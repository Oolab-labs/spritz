'use strict';

// Subtitles for a film the Spritz Receiver is ALREADY playing.
//
// A torrent MP4 is handed to the television untouched, and its track list lives in the MP4 index
// (moov), which an ordinary release writes at the END of the file. Probing it before the cast would
// wait on the last pieces of the swarm — the stall resolveCastable's torrent branch exists to avoid.
// Measured on a 13 GB WEB-DL: moov at byte 13,182,791,484 of 13,188,472,946. The television reads
// that index itself before it can show a frame, so once it is playing the same probe is cheap.
//
// So: ask a few times, spaced out, after the load; deliver the first real list; stop on an empty one
// (the file has no text subtitles) or when the cast has moved on. `prepare(cb)` answers an array of
// subtitle entries, [] for "none", or null for "could not read it yet", and returns a cancel.

// First at 2 s: the TV has normally read the index by then. The rest cover a slow swarm, and stop
// after a little over two minutes in total rather than probing for the whole film.
const DELAYS_MS = [2000, 5000, 10000, 20000, 40000, 60000];

function startLateSubtitles({ prepare, deliver, alive, schedule = setTimeout, cancelSchedule = clearTimeout, log = () => {} }) {
  let stopped = false, timer = null, cancelProbe = null, attempt = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) cancelSchedule(timer);
    timer = null;
    const cancel = cancelProbe; cancelProbe = null;
    if (typeof cancel === 'function') { try { cancel(); } catch (e) {} }
  };
  const next = () => {
    if (stopped) return;
    if (attempt >= DELAYS_MS.length) { log('late subtitles: index still unreadable after ' + attempt + ' attempts; giving up'); stopped = true; return; }
    timer = schedule(run, DELAYS_MS[attempt++]);
  };
  function run() {
    timer = null;
    if (stopped) return;
    if (!alive()) { stopped = true; return; }
    let answered = false;
    const cancel = prepare((subs) => {
      if (answered || stopped) return;
      answered = true; cancelProbe = null;
      if (!alive()) { stopped = true; return; }
      if (subs === null || subs === undefined) return next();
      stopped = true;
      if (Array.isArray(subs) && subs.length) deliver(subs);
      else log('late subtitles: the file has no text subtitles');
    });
    if (!answered) cancelProbe = cancel;
  }
  next();
  return stop;
}

module.exports = { startLateSubtitles, DELAYS_MS };
