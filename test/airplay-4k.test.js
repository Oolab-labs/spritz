'use strict';
// AirPlay 4K is opt-in (SPRITZ_AIRPLAY_4K=1) and offered only for LOCAL files. decide4k() is the guard
// that keeps the ambitious profile from making things worse. Two failure modes it exists to prevent:
//
//   - taking 4K when the plan is a TRANSCODE. A 2160p encode cannot hold realtime, its software retry
//     (libx264 at 4K) is worse, and a wedged encode ends the launch ladder at cb(null) — so a source
//     that plays fine at 1080p would become uncastable entirely.
//   - taking the profile for a 1080p HEVC HDR10 source, which would be COPIED rather than transcoded.
//     That is the exact configuration recorded in main.js as "enters AirPlay mode, never plays".
//
// The 1088 threshold mirrors the planner's own TALL constant: mod-16 padded 1080p encodes are 1088.
const test = require('node:test');
const assert = require('node:assert');
const { decide4k } = require('../src/main/lanserver');

const copy = { video: 'copy', speculative: false };

test('a real 4K copy is taken', () => {
  const d = decide4k(copy, 2160);
  assert.strictEqual(d.take, true);
  assert.match(d.why, /copy/);
});

test('a scope-framed 4K source (3840x1606) is still 4K', () => {
  assert.strictEqual(decide4k(copy, 1606).take, true);
});

test('a transcode is never worth taking, however tall the source', () => {
  const d = decide4k({ video: 'transcode', speculative: false }, 2160);
  assert.strictEqual(d.take, false);
  assert.match(d.why, /transcode/);
});

test('1080p is refused even as a copy — that is the never-plays configuration', () => {
  assert.strictEqual(decide4k(copy, 1080).take, false);
});

test('mod-16 padded 1080p (1088) is refused, not treated as 4K', () => {
  assert.strictEqual(decide4k(copy, 1088).take, false);
  assert.strictEqual(decide4k(copy, 1089).take, true);
});

test('a speculative plan is refused — it describes a guess, not the source', () => {
  const d = decide4k({ video: 'copy', speculative: true }, 2160);
  assert.strictEqual(d.take, false);
  assert.match(d.why, /probe/);
});

test('an unknown height is refused rather than assumed', () => {
  assert.strictEqual(decide4k(copy, 0).take, false);
  assert.strictEqual(decide4k(copy, undefined).take, false);
  assert.strictEqual(decide4k(copy, null).take, false);
});

test('no plan is not a crash', () => {
  assert.strictEqual(decide4k(null, 2160).take, false);
});

test('every refusal explains itself, so the log says why 4K was declined', () => {
  for (const args of [[null, 2160], [{ video: 'copy', speculative: true }, 2160],
    [{ video: 'transcode', speculative: false }, 2160], [copy, 1080]]) {
    const d = decide4k(args[0], args[1]);
    assert.strictEqual(d.take, false);
    assert.ok(d.why && d.why.length > 4, 'refusal should carry a reason');
  }
});
