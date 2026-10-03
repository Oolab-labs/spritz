'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceWaiting, stallAction } = require('../src/main/receiver-preparation-policy');
const source = 'http://localhost:1234/webtorrent/media';
const context = { source, generation: 3, now: 10000 };
const sample = { source, generation: 3, at: 9000, health: { known: true, sustainable: false, secondsBuffered: 0 } };
test('only fresh current torrent starvation can suppress recovery', () => {
  assert.equal(sourceWaiting(sample, context), true);
  for (const change of [{ generation: 2 }, { source: 'other' }, { at: 4000 }, { at: 11000 }, { health: null },
    { health: { known: false, sustainable: false, secondsBuffered: 0 } },
    { health: { known: true, sustainable: true, secondsBuffered: 0 } },
    { health: { known: true, sustainable: false, secondsBuffered: 2 } }]) {
    assert.equal(sourceWaiting({ ...sample, ...change }, context), false);
  }
  assert.equal(sourceWaiting(sample, { ...context, source: '/movie.mkv' }), false);
});
test('starved preparation waits only inside the original bounded budget', () => {
  assert.equal(stallAction({ sourceWaiting: true, category: 'no-output', elapsedMs: 25001 }), 'wait');
  assert.equal(stallAction({ sourceWaiting: true, category: 'no-output', elapsedMs: 60000 }), 'expire');
  assert.equal(stallAction({ sourceWaiting: false, category: 'no-output', elapsedMs: 25001 }), 'recover');
  for (const category of ['timestamp-or-mux-error', 'conversion-error', 'source-request-error', 'probe-or-demux-error', 'process-failed']) {
    assert.equal(stallAction({ sourceWaiting: true, category, elapsedMs: 25001 }), 'recover');
  }
});
