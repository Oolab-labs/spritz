'use strict';

// A VOD playlist written before a single segment exists.
//
// Spritz's live HLS authors an EVENT playlist that grows as the encoder produces segments, and the
// project's own notes concluded that a seekable VOD playlist was impractical because "finalizing
// races the encode" — you cannot write ENDLIST until you know where the end is.
//
// The old player showed the way out, and it is almost embarrassingly simple: you already know where
// the end is. The duration comes from the probe. A playlist is then pure arithmetic — how many
// segments, how long each one is — and can be written complete, with ENDLIST, before any encoding
// starts. The receiver reads a finite, seekable playlist and asks for segments by index; each one is
// produced when it is requested.
//
// That is what makes the whole family of live-pipe failures go away. Pausing is not asking for the
// next segment. Seeking is asking for a different index. A stall is asking again. There is no
// long-lived socket to die, no position to reconstruct, and nothing to restart.
//
// Single rendition, deliberately. Multi-rendition switching is what actually failed on this
// hardware before — not HLS — and a playlist with one variant cannot switch.
//
// ONE CONSTRAINT DOMINATES THE DESIGN, and it is not obvious from the arithmetic. A stream copy can
// only be cut on a keyframe. Asking ffmpeg for "18 seconds in, six seconds long" with -c copy does
// not give you that: it seeks back to the previous keyframe and hands you whatever follows. Measured
// on a fixture with keyframes every 10s, segment 3 (18s, 6s) came back starting at 10s and lasting
// 14.21s — overlapping its neighbours and matching nothing the playlist promised.
//
// So segment boundaries are the source's OWN keyframes, and segment durations vary. HLS has always
// allowed that — EXTINF is per segment for exactly this reason. Uniform slices are only valid when
// every segment is re-encoded with forced keyframes, which is the expensive path this exists to
// avoid.

const DEFAULT_SEGMENT_SEC = 6;

// How many segments a film of this length needs, and how long the last one is.
function planSegments(durationSec, segmentSec) {
  const dur = Number(durationSec);
  const seg = Number(segmentSec) > 0 ? Number(segmentSec) : DEFAULT_SEGMENT_SEC;
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const count = Math.ceil(dur / seg);
  const last = dur - (count - 1) * seg;
  return { count, segmentSec: seg, lastSec: Math.round(last * 1000) / 1000, durationSec: dur };
}

// Which slice of the film segment `index` covers. This is the only thing the encoder needs: seek
// here, encode this long. Segments are independent, which is what lets them be produced on demand
// and in any order the receiver asks for.
function segmentSpan(index, durationSec, segmentSec) {
  const plan = planSegments(durationSec, segmentSec);
  if (!plan) return null;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= plan.count) return null;
  const start = i * plan.segmentSec;
  const length = i === plan.count - 1 ? plan.lastSec : plan.segmentSec;
  return { index: i, start, duration: Math.round(length * 1000) / 1000, last: i === plan.count - 1 };
}

// Group a source's keyframes into segments of at least `targetSec`, so every cut lands where a copy
// can actually make one. The last segment runs to the end of the film.
//
// keyframes — ascending seconds, from ffprobe (-skip_frame nokey). The leading 0 is optional.
function segmentsFromKeyframes(keyframes, durationSec, targetSec) {
  const dur = Number(durationSec);
  const target = Number(targetSec) > 0 ? Number(targetSec) : DEFAULT_SEGMENT_SEC;
  if (!Array.isArray(keyframes) || !Number.isFinite(dur) || dur <= 0) return null;
  const ks = [...new Set(keyframes.map(Number).filter((k) => Number.isFinite(k) && k >= 0 && k < dur))].sort((a, b) => a - b);
  if (!ks.length || ks[0] > 0.001) ks.unshift(0); // a film always starts at a cut, whether or not it was reported
  const bounds = [0];
  for (const k of ks) if (k - bounds[bounds.length - 1] >= target) bounds.push(k);
  const out = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i];
    const end = i === bounds.length - 1 ? dur : bounds[i + 1];
    const length = Math.round((end - start) * 1000) / 1000;
    if (length <= 0) continue;              // a keyframe on the final boundary would make an empty tail
    out.push({ index: out.length, start, duration: length, last: i === bounds.length - 1 });
  }
  return out;
}

// The complete playlist from explicit segments — the keyframe-aligned form.
function buildVodPlaylistFromSegments({ segments, urlFor } = {}) {
  if (!Array.isArray(segments) || !segments.length || typeof urlFor !== 'function') return null;
  const longest = Math.max(...segments.map((s) => s.duration));
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + Math.ceil(longest),
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  segments.forEach((s, i) => { lines.push('#EXTINF:' + s.duration.toFixed(3) + ','); lines.push(urlFor(i)); });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// The complete playlist from uniform slices. ONLY valid when segments are re-encoded — see the note
// at the top of this file about why a stream copy cannot honour these boundaries.
function buildVodPlaylist({ durationSec, segmentSec, urlFor } = {}) {
  const plan = planSegments(durationSec, segmentSec);
  if (!plan || typeof urlFor !== 'function') return null;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    // TARGETDURATION must be an integer and must not be less than any segment; a receiver may refuse
    // a playlist where a segment is longer than it was promised.
    '#EXT-X-TARGETDURATION:' + Math.ceil(plan.segmentSec),
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  for (let i = 0; i < plan.count; i++) {
    const span = segmentSpan(i, plan.durationSec, plan.segmentSec);
    lines.push('#EXTINF:' + span.duration.toFixed(3) + ',');
    lines.push(urlFor(i));
  }
  // The point of the exercise: the receiver knows this is the whole film, so it can seek anywhere in
  // it without waiting to be told the length later.
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// The master playlist. CODECS is included only when the caller can state it truthfully — a guessed
// codec string is worse than none, which this project learned when a speculative one made AVPlayer
// reject the master outright and AirPlay stopped working for days.
function buildMasterPlaylist({ mediaUrl, bandwidth, width, height, codecs, subtitlesUrl } = {}) {
  if (!mediaUrl) return null;
  const attrs = ['BANDWIDTH=' + (Number(bandwidth) > 0 ? Math.floor(bandwidth) : 20000000)];
  if (Number(width) > 0 && Number(height) > 0) attrs.push('RESOLUTION=' + Math.floor(width) + 'x' + Math.floor(height));
  if (codecs) attrs.push('CODECS="' + codecs + '"');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  if (subtitlesUrl) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Subtitles",DEFAULT=NO,AUTOSELECT=NO,URI="' + subtitlesUrl + '"');
    attrs.push('SUBTITLES="subs"');
  }
  lines.push('#EXT-X-STREAM-INF:' + attrs.join(','));
  lines.push(mediaUrl);
  return lines.join('\n') + '\n';
}

module.exports = { planSegments, segmentSpan, buildVodPlaylist, segmentsFromKeyframes, buildVodPlaylistFromSegments, buildMasterPlaylist, DEFAULT_SEGMENT_SEC };
