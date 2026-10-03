'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSettleGuard, createSelectionBaseline } = require('../src/main/settle-guard');

test('open until the re-cast ends, then through the settling period', () => {
  let t = 1000;
  const g = createSettleGuard(() => t);
  assert.strictEqual(g.active(), false);
  g.begin();
  assert.strictEqual(g.active(), true);
  t += 60000;
  assert.strictEqual(g.active(), true, 'a slow re-cast stays guarded however long it takes');
  g.end(3000);
  assert.strictEqual(g.active(), true, 'the receiver reports stale selections just after the load');
  t += 2999; assert.strictEqual(g.active(), true);
  t += 2; assert.strictEqual(g.active(), false);
});

test('overlapping re-casts keep it shut until the last one ends', () => {
  let t = 0;
  const g = createSettleGuard(() => t);
  g.begin(); g.begin();
  g.end(0);
  assert.strictEqual(g.active(), true);
  g.end(0);
  assert.strictEqual(g.active(), false);
});

test('end() without begin() cannot underflow', () => {
  let t = 0;
  const g = createSettleGuard(() => t);
  g.end(0); g.end(0);
  g.begin();
  assert.strictEqual(g.active(), true);
});

test('every way out of recastMkv releases the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const body = src.slice(src.indexOf('function recastMkv('), src.indexOf('// Re-establish a cast whose stream died'));
  assert.ok(/subGuard\.begin\(\)/.test(body), 'recastMkv takes the guard');
  // begin() once; each early return and each callback outcome must pair it with an end().
  const ends = (body.match(/subGuard\.end\(/g) || []).length;
  assert.ok(ends >= 3, 'the no-url, the load error and the success paths each release it (found ' + ends + ')');
});

test('the first quiet report is the starting state, not a viewer choice', () => {
  const b = createSelectionBaseline();
  assert.strictEqual(b.observe([1000], false), false, 'an LG that activates track 1000 by itself');
  assert.strictEqual(b.observe([1000], false), false);
});

test('a later change is a viewer choice, once', () => {
  const b = createSelectionBaseline();
  b.observe([], false);
  assert.strictEqual(b.observe([1001], false), true);
  assert.strictEqual(b.observe([1001], false), false, 'the same report again is not a new choice');
  assert.strictEqual(b.observe([], false), true, 'switching off on the remote is a choice too');
});

test('reports while a re-cast is in flight are never choices, and reset the baseline', () => {
  const b = createSelectionBaseline();
  b.observe([1000], false);
  assert.strictEqual(b.observe([], true), false, 'the empty list during the new LOAD');
  assert.strictEqual(b.observe([1000], true), false, 'the previous selection after setTrack');
  assert.strictEqual(b.observe([1000], false), false, 'the first quiet report after the rebuild is the new start');
  assert.strictEqual(b.observe([1001], false), true);
});

test('track order does not matter and non-arrays are ignored', () => {
  const b = createSelectionBaseline();
  b.observe([2, 1], false);
  assert.strictEqual(b.observe([1, 2], false), false);
  assert.strictEqual(b.observe(undefined, false), false);
  assert.strictEqual(b.observe(null, false), false);
});
