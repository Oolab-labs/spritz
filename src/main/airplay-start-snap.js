'use strict';

// Where an AirPlay handoff may start the TV.
//
// LG 55NANO80T6A (webOS 24), 19 handoffs on 2026-10-10: every start 0.07–5.27s into an HLS segment
// played; every start 6.00–7.57s into one stalled — the TV fetched five segments, posted
// PlaybackStalled and failed with -11870/-60080. A stream copy cuts segments at the source's
// keyframes (8.333s on the test file, other lengths on other files), so the boundary is read from
// the live media playlist rather than assumed. A start more than MAX_OFFSET into its segment is moved
// back to the segment's start: the TV repeats a few seconds the viewer just saw on the Mac instead of
// stalling. 4s leaves margin under the largest offset that played.
const MAX_OFFSET = 4;

function segmentStarts(playlist) {
  if (typeof playlist !== 'string') return [];
  const out = [];
  let t = 0;
  for (const m of playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
    const d = Number(m[1]);
    if (!Number.isFinite(d) || d <= 0) return [];
    out.push({ start: t, duration: d });
    t += d;
  }
  return out;
}

function safeAirplayStart(pos, playlist, { maxOffset = MAX_OFFSET } = {}) {
  if (!Number.isFinite(pos) || pos < 0) return 0;
  const seg = segmentStarts(playlist).find((s) => pos >= s.start && pos < s.start + s.duration);
  if (!seg) return pos; // not yet produced, or no playlist: nothing to vouch for the boundary
  return pos - seg.start > maxOffset ? seg.start : pos;
}

// Whether the playlist reaches far enough to start the TV at `pos`. The AirPlay remux starts at 0:00
// when the file loads and runs at a few times real time, so a viewer who seeks ahead and casts soon
// after asks for a position that does not exist yet. AVPlayer on an open EVENT playlist then lands at
// the end of what is produced and plays on from there — on the LG, 302s for a 631s handoff
// (2026-11-14). LOOKAHEAD covers the segment holding `pos` (a stream copy cuts at keyframes: 8.333s on
// the test file) plus the next one or two the TV fetches before it starts. No playlist means nothing
// to wait on (a non-HLS source), and a finished playlist reaches everywhere.
const LOOKAHEAD = 12;
function producedEnd(playlist) {
  const segs = segmentStarts(playlist);
  const last = segs[segs.length - 1];
  return last ? last.start + last.duration : 0;
}
function startIsProduced(pos, playlist, { lookahead = LOOKAHEAD } = {}) {
  if (typeof playlist !== 'string') return true;
  if (/#EXT-X-ENDLIST/.test(playlist)) return true;
  return producedEnd(playlist) >= pos + lookahead;
}

// The same rule for a playlist that starts partway into the film (receiver HLS with a timeline
// origin): positions are film time, the playlist counts from `origin`. Spritz Receiver on the LG froze
// the same way (#EXT-X-START 24.823 = 8.16s into an 8.333s segment, 2026-10-10).
function safeStartOnTimeline(startSec, playlist, origin = 0) {
  const o = Number.isFinite(origin) && origin > 0 ? origin : 0;
  if (!Number.isFinite(startSec) || startSec <= o) return startSec;
  return o + safeAirplayStart(startSec - o, playlist);
}

module.exports = { segmentStarts, safeAirplayStart, safeStartOnTimeline, producedEnd, startIsProduced, MAX_OFFSET, LOOKAHEAD };
