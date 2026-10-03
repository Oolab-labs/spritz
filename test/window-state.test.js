'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../src/main/window-state');

const FALLBACK = { width: 950, height: 560 };
const one = [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }];
const two = one.concat([{ workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }]);

test('nothing saved gives the default size and lets the OS place the window', () => {
  assert.deepStrictEqual(W.restore(null, one, FALLBACK), FALLBACK);
  assert.deepStrictEqual(W.restore(undefined, one, FALLBACK), FALLBACK);
});

test('a saved window that is on screen comes back exactly where it was', () => {
  const saved = { x: 100, y: 120, width: 1200, height: 700 };
  assert.deepStrictEqual(W.restore(saved, one, FALLBACK), saved);
});

test('a window saved on a monitor that is no longer connected keeps its size but is re-placed', () => {
  const r = W.restore({ x: 2000, y: 300, width: 1200, height: 700 }, one, FALLBACK);
  assert.strictEqual(r.x, undefined); assert.strictEqual(r.y, undefined);
  assert.strictEqual(r.width, 1200); assert.strictEqual(r.height, 700);
});

test('the same saved position is honoured when that monitor is present', () => {
  const saved = { x: 2000, y: 300, width: 1200, height: 700 };
  assert.deepStrictEqual(W.restore(saved, two, FALLBACK), saved);
});

test('a window mostly off the edge of the screen is re-placed (a sliver on screen is not "visible")', () => {
  const r = W.restore({ x: 1400, y: 100, width: 1000, height: 600 }, one, FALLBACK);
  assert.strictEqual(r.x, undefined);
});

test('sizes are clamped: never below the minimum window, never larger than the screen', () => {
  const tiny = W.restore({ x: 10, y: 40, width: 100, height: 90 }, one, FALLBACK);
  assert.ok(tiny.width >= 520 && tiny.height >= 400);
  const huge = W.restore({ x: 0, y: 25, width: 9000, height: 9000 }, one, FALLBACK);
  assert.ok(huge.width <= 1440 && huge.height <= 875);
});

test('garbage never throws and never produces NaN', () => {
  for (const bad of [{}, { x: 'a', y: null, width: NaN, height: Infinity }, 'str', 42, [], { width: -5, height: -5 }]) {
    const r = W.restore(bad, one, FALLBACK);
    assert.ok(Number.isFinite(r.width) && Number.isFinite(r.height), JSON.stringify(bad));
  }
});

test('no displays reported falls back safely', () => {
  assert.deepStrictEqual(W.restore({ x: 1, y: 1, width: 900, height: 500 }, [], FALLBACK), { width: 900, height: 500 });
});

test('save then load round-trips, a missing file is null, and a corrupt file is null (not a crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-ws-'));
  const file = path.join(dir, 'window-state.json');
  assert.strictEqual(W.load(file), null);
  W.save(file, { x: 5, y: 6, width: 1000, height: 600 });
  assert.deepStrictEqual(W.load(file), { x: 5, y: 6, width: 1000, height: 600 });
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(W.load(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save is atomic: no temporary file is left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-ws-'));
  W.save(path.join(dir, 'window-state.json'), { x: 1, y: 2, width: 900, height: 500 });
  assert.deepStrictEqual(fs.readdirSync(dir), ['window-state.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
