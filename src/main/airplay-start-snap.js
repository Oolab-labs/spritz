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

// The same rule for a playlist that starts partway into the film (receiver HLS with a timeline
// origin): positions are film time, the playlist counts from `origin`. Spritz Receiver on the LG froze
// the same way (#EXT-X-START 24.823 = 8.16s into an 8.333s segment, 2026-10-10).
function safeStartOnTimeline(startSec, playlist, origin = 0) {
  const o = Number.isFinite(origin) && origin > 0 ? origin : 0;
  if (!Number.isFinite(startSec) || startSec <= o) return startSec;
  return o + safeAirplayStart(startSec - o, playlist);
}

module.exports = { segmentStarts, safeAirplayStart, safeStartOnTimeline, MAX_OFFSET };
