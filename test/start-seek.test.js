'use strict';

// Should the receiver (re)assert the start position it was asked for?
//
// Measured on the LG (2026-09-03): an epoch's playlist is EVENT-typed and had no ENDLIST when the
// television fetched it, so webOS treated it as LIVE and began at the live edge — epoch-local
// 816.98s and 530.4s on two runs — overriding the `video.currentTime = startSec` the app had set on
// loadedmetadata. The mapping was right; the start point was wrong. The player's first `playing`
// position is therefore checked against the request and corrected, once or twice, never forever.
//
// Pure, ES5, loadable in the browser and here — the same arrangement as hmac.js.

const { test } = require('node:test');
const assert = require('assert');
const { startSeekPlan, START_TOLERANCE_SEC, START_MAX_ATTEMPTS } = require('../webos-receiver/start-seek');

test('a first position far from the requested start is corrected', () => {
  const d = startSeekPlan({ requested: 1.668, current: 816.98, attempts: 0 });
  assert.equal(d.seek, true);
  assert.equal(d.to, 1.668);
  assert.match(d.why, /far/);
});

test('a position within a keyframe snap of the request is left alone', () => {
  // An input seek lands on the keyframe at or before T, and the player may snap forward within the
  // segment: a few seconds is the media, not the live edge.
  for (const cur of [1.668, 3.0, 1.668 + START_TOLERANCE_SEC - 0.1]) {
    assert.equal(startSeekPlan({ requested: 1.668, current: cur, attempts: 0 }).seek, false, 'at ' + cur);
  }
});

test('no request means nothing to assert', () => {
  assert.equal(startSeekPlan({ requested: null, current: 500, attempts: 0 }).seek, false);
});

test('zero is a real start target', () => {
  assert.equal(startSeekPlan({ requested: 0, current: 0, attempts: 0 }).action, 'settled');
  const d = startSeekPlan({ requested: 0, current: 500, attempts: 0 });
  assert.equal(d.seek, true);
  assert.equal(d.to, 0);
});

test('a position the player cannot report yet is not a reason to seek', () => {
  // -9223372030.8 was the LG's first report: INT64_MIN over 1e9, "no PTS yet". Seeking on that
  // would fire before the player has a timeline to seek in.
  for (const cur of [null, NaN, -9223372030.8, -1]) {
    assert.equal(startSeekPlan({ requested: 300, current: cur, attempts: 0 }).seek, false, 'at ' + cur);
  }
});

test('the correction is bounded: it does not fight a player forever', () => {
  assert.equal(startSeekPlan({ requested: 300, current: 900, attempts: START_MAX_ATTEMPTS - 1 }).seek, true);
  const d = startSeekPlan({ requested: 300, current: 900, attempts: START_MAX_ATTEMPTS });
  assert.equal(d.seek, false);
  assert.match(d.why, /gave up|attempts/);
});

test('a valid final arrival settles before retry exhaustion', () => {
  const d = startSeekPlan({ requested: 300, current: 300, attempts: START_MAX_ATTEMPTS });
  assert.equal(d.action, 'settled');
});

test('the browser build exposes the same function', () => {
  // The module attaches to a root when there is no CommonJS; simulate that root.
  const src = require('fs').readFileSync(require.resolve('../webos-receiver/start-seek'), 'utf8');
  const root = {};
  new Function('window', 'module', src)(root, undefined);
  assert.equal(typeof root.SpritzStartSeek.startSeekPlan, 'function');
});

test('growing-playlist clock four seconds early is not a settled resume', () => {
  assert.equal(startSeekPlan({ requested: 24.3, current: 20.111, attempts: 0 }).action, 'seek');
  assert.equal(startSeekPlan({ requested: 24.3, current: 20.111, attempts: 2 }).action, 'exhausted');
  assert.equal(startSeekPlan({ requested: 24.3, current: 24.44, attempts: 1 }).action, 'settled');
});

test('LG invalid or short seekable window does not spend a correction', () => {
  const base = { requested: 24.3, current: 0.6, attempts: 0 };
  for (const seekable of [[], [[-9223372036, -9223372034]], [[0, 15.955]]]) {
    assert.equal(startSeekPlan({ ...base, seekable, waitedMs: 1000 }).action, 'wait');
    assert.equal(startSeekPlan({ ...base, seekable, waitedMs: 30000 }).action, 'exhausted');
  }
  assert.equal(startSeekPlan({ ...base, seekable: [[0, 30]], waitedMs: 2000 }).action, 'seek');
  assert.equal(startSeekPlan({ ...base, current: 24.3, seekable: [] }).action, 'settled');
});
