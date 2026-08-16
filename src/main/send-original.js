'use strict';

// Can this file go to the receiver untouched?
//
// Every cast currently goes through ffmpeg, even when the plan is a pure stream copy and the file is
// already in a container the receiver reads. That is a long-lived HTTP pipe with no seeking, and it
// brings the whole family of problems this project has spent days on: a paused receiver stops
// reading and the socket dies, a restart has to work out where the viewer was, a stall is fatal, and
// the position has to be reconstructed from sparse status frames.
//
// The old player had a `sendOriginal` path for exactly this. Handed a file it can already play, the
// receiver fetches it with range requests: pausing is just not asking for the next range, seeking is
// asking for a different one, and the receiver always knows where it is. None of the machinery is
// needed because none of the failures happen.
//
// The bar is deliberately high. Anything that would change a single byte — a container swap, a
// Dolby Vision strip, tone mapping, a burned-in subtitle, picking a different audio track, any
// re-encode — disqualifies it, because those are the reasons ffmpeg is in the path at all. When in
// doubt this returns false and the existing, working path runs.

// Containers a Cast receiver reads directly. MKV is excluded on evidence, not caution: it was tried
// and the receiver refused it, twice, with two different codecs inside.
const DIRECT_CONTAINERS = /\.(mp4|m4v|mov)$/i;

// Codecs it can decode from those containers.
const DIRECT_VIDEO = new Set(['h264', 'avc', 'hevc', 'h265']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

// plan      — the result of planPlayback for this media and receiver
// info      — the probe result
// opts      — { input, remote, audioTrack, burnSub, caps }
// Returns { ok: true } or { ok: false, why } — the reason matters, because "we did not take the
// fast path" is otherwise indistinguishable from "there is no fast path".
function canSendOriginal(plan, info, opts) {
  const o = opts || {};
  if (!plan || !info) return { ok: false, why: 'nothing was probed' };
  // A streamed torrent is not a file on disk: serving it directly would hand the receiver a range
  // of a partially downloaded file. There is a proxy that could bridge that, but it is a separate
  // change with its own failure modes.
  if (o.remote) return { ok: false, why: 'source is streamed, not a local file' };
  if (!DIRECT_CONTAINERS.test(String(o.input || ''))) return { ok: false, why: 'container is not one the receiver reads directly' };
  if (plan.speculative) return { ok: false, why: 'the probe was inconclusive' };
  if (plan.video !== 'copy') return { ok: false, why: 'the video has to be re-encoded' };
  if (plan.stripDovi) return { ok: false, why: 'Dolby Vision has to be stripped' };
  if (plan.tonemap) return { ok: false, why: 'HDR has to be tone-mapped' };
  if (o.burnSub != null && o.burnSub >= 0) return { ok: false, why: 'a subtitle has to be burned in' };

  const vcodec = String(info.vcodec || '').toLowerCase();
  if (!DIRECT_VIDEO.has(vcodec)) return { ok: false, why: 'video codec ' + (vcodec || 'unknown') + ' is not directly playable' };

  const audio = Array.isArray(info.audio) ? info.audio : [];
  // Sending the file whole means sending every track in it, and the receiver picks the first. If the
  // viewer chose a different language, only ffmpeg can honour that.
  const track = o.audioTrack || 0;
  if (track !== 0) return { ok: false, why: 'a non-default audio track was chosen' };
  if (audio.length > 1) return { ok: false, why: 'the file has several audio tracks and the receiver would pick for itself' };
  const acodec = String((audio[0] && audio[0].codec) || '').toLowerCase();
  if (audio.length && !DIRECT_AUDIO.has(acodec)) return { ok: false, why: 'audio codec ' + acodec + ' is not directly playable' };
  // The plan is authoritative on whether that audio survives untouched.
  const planned = plan.audioTracks && plan.audioTracks[track];
  if (planned && planned.action !== 'copy') return { ok: false, why: 'the audio has to be converted' };

  return { ok: true };
}

module.exports = { canSendOriginal, DIRECT_CONTAINERS, DIRECT_VIDEO, DIRECT_AUDIO };
