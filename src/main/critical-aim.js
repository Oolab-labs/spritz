'use strict';

// WHERE the torrent's critical window is aimed, and by WHOM.
//
// The scheduler side of critical-authority.js. This holds the two positions torrent-backed
// playback has — the VIEWER PLAYHEAD and the PRODUCER DEMAND — plus the producer's lifecycle, asks
// criticalAuthority() which of them the swarm should follow, and marks the window. torrent.js
// delegates to it: the swarm, the file, the progress tick and the seek wait stay there; the
// decision about what the tick aims at lives here, where it can be tested against a fake torrent.
// (torrent.js cannot be instantiated outside Electron and has no seam for injecting a torrent.)
//
// Producer LIFECYCLE belongs to the packaging run — setProducerActive — and never to HTTP
// requests. Measured against a real ffmpeg: one run makes several Range requests (the header, the
// container index at the tail, the seek target, then one long read) and closes each before the
// next, so a Range closing says nothing about whether the producer stopped. The transport epoch
// that owns the ffmpeg is the caller that knows; until it exists, the producer is simply never
// active and this behaves exactly as the viewer-only scheduler did.

const { criticalWindow } = require('./buffer-plan');
const { criticalAuthority } = require('./critical-authority');

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// tlog — diagnostic logger, torrent.js's tlog in production.
// now  — clock, injectable so freshness can be tested without waiting.
function createCriticalAim({ tlog = () => {}, now = Date.now } = {}) {
  // The viewer. Same two numbers torrent.js always kept: a 0..1 fraction of the file, and the
  // duration that turns the window from a piece count into playback time.
  let viewerFrac = 0, mediaDuration = 0;
  // The producer: the last observed source-read position, when it was seen, and whether the run
  // that made it is still going.
  let producer = { byteStart: null, at: null, active: false };
  const owners = new Map();
  let ownerSequence = 0;
  function registerProducer() {
    const id = ++ownerSequence;
    const entry = { byteStart: null, at: null, active: false, owner: id };
    owners.set(id, entry);
    return {
      noteSourceRead(o) {
        if (owners.get(id) !== entry || !o || o.reader !== 'producer' || o.event === 'close') return;
        const pos = finite(o.position) ? o.position : o.byteStart;
        if (!finite(pos) || pos < 0) return;
        entry.byteStart = pos; entry.at = now();
      },
      setActive(active) { if (owners.get(id) === entry) entry.active = !!active; },
      dispose() { if (owners.get(id) === entry) owners.delete(id); }
    };
  }
  function currentProducer() {
    const live = [...owners.values()].filter(p => p.active && finite(p.byteStart));
    // Registration order is authority: late events from a retained rollback
    // producer cannot steal priority from the newer candidate.
    return live.length ? live[live.length - 1] : producer;
  }
  // What refresh() last decided and marked, for the log and for anyone asking who is in charge.
  let decision = null, window = null;

  function setPlayhead(frac, durationSec) {
    if (finite(frac) && frac >= 0 && frac <= 1) viewerFrac = frac;
    if (finite(durationSec) && durationSec > 0) mediaDuration = durationSec;
  }

  // A read observed at the source proxy (lanserver's onSourceRead). Only the PRODUCER's reads are
  // demand: a television reading the same file through the DLNA route is the viewer, and its
  // position already arrives as playhead status. Attribution is the proxy's, by token; nothing
  // here re-derives it.
  //
  // open and progress both carry `position` — the range start at open, the advancing delivered
  // position after — and that is the number wanted. close is recorded for the position too (the
  // read got that far) and deliberately does NOT touch `active`: see the module comment.
  function noteSourceRead(o) {
    if (!o || o.reader !== 'producer') return;
    const pos = finite(o.position) ? o.position : (finite(o.byteStart) ? o.byteStart : null);
    if (pos === null || pos < 0) return;
    producer = { byteStart: pos, at: now(), active: producer.active };
  }

  // The packaging run's lifecycle. true when its ffmpeg starts, false when it exits or is killed.
  // Turning it off does not forget the last position — the log still wants to say where the
  // producer got to — but authority returns to the viewer on the very next refresh.
  function setProducerActive(active) {
    producer = Object.assign({}, producer, { active: !!active });
    tlog('producer ' + (active ? 'ACTIVE' : 'inactive') + (producer.byteStart !== null ? ' (last read at byte ' + producer.byteStart + ')' : ''));
  }

  function reset() {
    owners.clear();
    viewerFrac = 0;
    producer = { byteStart: null, at: null, active: false };
    decision = null; window = null;
  }

  // Re-aim the window. Called from the progress tick with the live torrent and file.
  //
  // One decision point, then one window abstraction: the chosen position becomes a fraction of
  // the file and goes through criticalWindow exactly as the viewer's always did, so producer and
  // viewer windows are the same shape and size. No second scheduler.
  function refresh(t, file) {
    if (!t || !file || !finite(file.length) || file.length <= 0) return;
    const selectedProducer = currentProducer();
    decision = criticalAuthority({
      viewer: { frac: viewerFrac, fileLength: file.length },
      // Owned runs have explicit lifecycle cleanup. Silence while blocked must
      // not expire their demand; the legacy path retains its freshness backstop.
      producer: selectedProducer === producer ? producer : { ...selectedProducer, at: null },
      now: now()
    });
    // No usable position from either authority: leave whatever window is there alone. Byte 0 is a
    // real position, and "nobody knows" must not become "the head of the film".
    if (!decision.source) return;
    const frac = Math.min(1, Math.max(0, decision.byteStart / file.length));
    const win = criticalWindow({
      startPiece: file._startPiece, endPiece: file._endPiece, pieceLength: t.pieceLength,
      fileBytes: file.length, durationSec: mediaDuration, playFrac: frac,
      targetSeconds: READAHEAD_SECONDS
    });
    if (!win) return;
    // CLEAR first. webtorrent's critical() only ever sets _critical[i] = true and never unsets it,
    // so a moving window re-marked every tick would grow without bound until nearly every piece
    // was flagged and the flag stopped discriminating — see the history in torrent.js.
    try { if (Array.isArray(t._critical)) t._critical.length = 0; } catch (e) {}
    try { t.critical(win.at, win.end); } catch (e) {}
    window = { at: win.at, end: win.end, source: decision.source };
  }

  // Seconds of playback to keep urgent. Wide enough to ride out a slow patch, narrow enough that
  // the critical set still means something. See buffer-plan.js for why this is time, not pieces.
  const READAHEAD_SECONDS = 30;

  // Who is in charge, where everyone is, what was marked. This is what a far-seek log prints.
  function state() {
    return {
      viewer: { frac: viewerFrac, durationSec: mediaDuration },
      producer: Object.assign({}, currentProducer()),
      decision: decision ? Object.assign({}, decision) : null,
      window: window ? Object.assign({}, window) : null
    };
  }

  return { registerProducer, setPlayhead, noteSourceRead, setProducerActive, reset, refresh, state,
    viewerFrac: () => viewerFrac, duration: () => mediaDuration, READAHEAD_SECONDS };
}

module.exports = { createCriticalAim };
