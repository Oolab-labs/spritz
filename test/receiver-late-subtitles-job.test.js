'use strict';

// When the Mac asks for a torrent MP4's subtitles after the TV has started, and how it stops.
// The index the probe needs arrives with the TV's own read of it, which is usually seconds but on a
// slow swarm can be minutes — so it asks a few times, spaced out, and gives up quietly.

const { test } = require('node:test');
const assert = require('assert');
const { startLateSubtitles, DELAYS_MS } = require('../src/main/receiver-late-subtitles');

function clock() {
  const timers = [];
  return {
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    cancelSchedule: (t) => { if (t) t.live = false; },
    fire() { const t = timers.find((x) => x.live); if (!t) return false; t.live = false; t.fn(); return true; },
    pending: () => timers.filter((x) => x.live)
  };
}

test('it retries an inconclusive probe and delivers the first real list once', () => {
  const c = clock(); const delivered = []; const answers = [null, null, [{ id: 'source-subtitle-0' }]]; let asked = 0;
  startLateSubtitles({ ...c, alive: () => true, deliver: (s) => delivered.push(s),
    prepare: (cb) => { const a = answers[asked++]; cb(a); return () => {}; } });
  while (c.fire());
  assert.equal(asked, 3);
  assert.deepEqual(delivered, [[{ id: 'source-subtitle-0' }]]);
});

test('an empty list ends it without delivering anything', () => {
  const c = clock(); const delivered = []; let asked = 0;
  startLateSubtitles({ ...c, alive: () => true, deliver: (s) => delivered.push(s), prepare: (cb) => { asked++; cb([]); return () => {}; } });
  while (c.fire());
  assert.equal(asked, 1); assert.deepEqual(delivered, []);
});

test('it gives up after the last spaced attempt', () => {
  const c = clock(); let asked = 0;
  startLateSubtitles({ ...c, alive: () => true, deliver: () => assert.fail('nothing to deliver'), prepare: (cb) => { asked++; cb(null); return () => {}; } });
  while (c.fire());
  assert.equal(asked, DELAYS_MS.length);
  assert.ok(DELAYS_MS.reduce((a, b) => a + b, 0) <= 180000, 'bounded: a slow swarm does not keep it probing for the whole film');
});

test('a cast that moved on stops it, including a probe already running', () => {
  const c = clock(); let alive = true, cancelled = 0, pendingCb = null;
  const stop = startLateSubtitles({ ...c, alive: () => alive, deliver: () => assert.fail('superseded'),
    prepare: (cb) => { pendingCb = cb; return () => { cancelled++; }; } });
  c.fire(); // first probe starts and is still running
  stop();
  assert.equal(cancelled, 1, 'the running probe was cancelled');
  pendingCb([{ id: 'source-subtitle-0' }]); // a late answer from a cancelled probe is dropped
  assert.equal(c.pending().length, 0);
  // And when the plan is retired without anyone calling stop, the next step notices.
  const d = clock(); let asked = 0;
  startLateSubtitles({ ...d, alive: () => alive, deliver: () => assert.fail('superseded'), prepare: (cb) => { asked++; cb(null); return () => {}; } });
  alive = false; while (d.fire());
  assert.equal(asked, 0);
});
