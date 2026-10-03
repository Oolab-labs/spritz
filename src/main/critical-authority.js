'use strict';

// WHO the torrent's critical window follows: the viewer, or the packager.
//
// Torrent-backed playback has two positions and they are deliberately not the same number.
//
//   VIEWER PLAYHEAD   where the person is watching. User intent, and the signal that a seek
//                     happened at all.
//   PRODUCER DEMAND   the source region the packager (ffmpeg, reading the torrent through the
//                     HTTP proxy) is consuming right now. It necessarily runs AHEAD of the viewer,
//                     because producing upcoming media is what it is for.
//
// Prioritising the swarm around the viewer alone starves the producer that is trying to generate
// the next segments, and the viewer then stalls anyway — so during active packaging the producer
// is the authority and the viewer is the fallback.
//
// This exists as its own module because the alternative already happened. torrent.js's
// ensureBytes() achieves a producer-shaped window by calling setPlayhead() — it MOVES THE VIEWER
// PLAYHEAD to a byte the viewer is nowhere near, because refreshCritical re-aims at playFrac every
// progress tick and would otherwise wipe it. Its comment is explicit: "the two would fight, and
// the tick would win." That works, but it destroys the distinction: afterwards nothing can tell
// which authority set the window, which is precisely the question a far seek has to answer.
//
// Pure by design — no torrent, no clock, no filesystem — so the rule can be tested exhaustively
// without a swarm. Same shape as seek-window.js and buffer-plan.js.

// How long a producer observation stays authoritative.
//
// GENEROUS ON PURPOSE, and the reasoning is the opposite of the obvious one. A producer that is
// BLOCKED — waiting on pieces that have not arrived — emits no new reads precisely because the
// bytes are missing, which is the exact moment it most needs the swarm aimed at it. A short
// freshness window would read that silence as staleness and hand priority back to the viewer at
// the worst possible time.
//
// So this is not the signal for "the producer stopped". That signal is `active: false`, set by
// whoever owns the ffmpeg run when it exits. Freshness only catches the case where that signal is
// never delivered — a crash, a dropped callback — so it is a backstop, not the mechanism.
const PRODUCER_FRESH_MS = 30000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// viewer   — { frac, fileLength }. frac is 0..1 within the file, the unit torrent.js already keeps.
// producer — { byteStart, at, active } or null. `at` is when the read was observed, `active` is
//            whether the run that made it is still going.
// now      — current time in the same units as `at`.
//
// Returns { source: 'producer' | 'viewer' | null, byteStart, why }. A null source means NO
// authority could be established, and the caller must leave the existing window alone — see the
// zero trap below.
function criticalAuthority({ viewer, producer, now, freshMs = PRODUCER_FRESH_MS } = {}) {
  const t = finite(now) ? now : 0;

  // The producer's claim, checked before the viewer's because it outranks it when it holds.
  if (producer && producer.active !== false && finite(producer.byteStart) && producer.byteStart >= 0) {
    const at = finite(producer.at) ? producer.at : null;
    if (at === null || t - at <= freshMs) {
      return { source: 'producer', byteStart: producer.byteStart,
        why: 'the packager is reading source byte ' + producer.byteStart };
    }
  }

  // The viewer's position, converted to a byte so both authorities speak one unit.
  //
  // THE ZERO TRAP: byte 0 is a real position — the head of the film — so a MISSING reading must
  // never arrive as one. A transient null from the receiver, a playhead before the first status
  // update, or a file whose length is not known yet would otherwise snap the critical window to
  // the start of the film and pull the whole swarm off whatever is actually being watched.
  // Answering "no authority" leaves the previous window standing, which is always the safer
  // wrong answer of the two.
  if (viewer && finite(viewer.frac) && viewer.frac >= 0 && viewer.frac <= 1
      && finite(viewer.fileLength) && viewer.fileLength > 0) {
    const byteStart = Math.floor(viewer.frac * viewer.fileLength);
    return { source: 'viewer', byteStart,
      why: 'no packager is reading; following the viewer at byte ' + byteStart };
  }

  return { source: null, byteStart: null, why: 'no usable position from either authority' };
}

module.exports = { criticalAuthority, PRODUCER_FRESH_MS };
