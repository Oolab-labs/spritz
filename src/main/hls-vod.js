'use strict';

// A VOD playlist written before a single segment exists.
//
// Spritz's live HLS authors an EVENT playlist that grows as the encoder produces segments, and the
// project's own notes concluded that a seekable VOD playlist was impractical because "finalizing
// races the encode" — you cannot write ENDLIST until you know where the end is.
//
// The old player showed the way out, and it is almost embarrassingly simple: you already know where
// the end is. The duration comes from the probe, the cut points from a keyframe probe, and the
// playlist can then be written complete, with ENDLIST, before any encoding starts. The receiver reads a finite, seekable playlist and asks for segments by index; each one is
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
// allowed that — EXTINF is per segment for exactly this reason. Uniform slices would only be valid
// if every segment were re-encoded with forced keyframes, which is the expensive path this exists
// to avoid (an earlier uniform-slice builder was removed for that reason: nothing ever called it).

const DEFAULT_SEGMENT_SEC = 6;

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

module.exports = { segmentsFromKeyframes, buildVodPlaylistFromSegments, DEFAULT_SEGMENT_SEC };
