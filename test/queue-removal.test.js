'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture(queue, index) {
  const loads = [];
  const ctx = { sourceIntent: 0, folderIntent: 0, playQueue: queue.slice(), qIndex: index, detachedQueueSource: null,
    settings: { repeat: 'off', shuffle: false }, torrentQueue: [], torrentIdx: -1,
    currentLocalPath: null, routeSource: (src) => loads.push(src), castAdvanceHost: null };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function removeQueueItem('), source.indexOf('// Prev/Next + playlist buttons')) + '\nthis.remove = removeQueueItem; this.next = playNext; this.prev = playPrev;', ctx);
  return { ctx, loads };
}
test('removing current A detaches playback and Next selects B rather than C', () => {
  const f = fixture(['A', 'B', 'C'], 0); f.ctx.remove(0);
  assert.deepEqual(f.loads, []); assert.equal(f.ctx.detachedQueueSource, 'A');
  assert.equal(f.ctx.qIndex, -1); f.ctx.next();
  assert.deepEqual(f.loads, ['B']); assert.equal(f.ctx.detachedQueueSource, null);
});
test('removing an earlier duplicate preserves the current item position', () => {
  const f = fixture(['A', 'A', 'B'], 1); f.ctx.remove(0);
  assert.equal(f.ctx.qIndex, 0); assert.equal(f.ctx.detachedQueueSource, null);
  f.ctx.next(); assert.deepEqual(f.loads, ['B']);
});
test('detached middle item keeps Prev and Next at its surrounding items', () => {
  const next = fixture(['A', 'B', 'C'], 1); next.ctx.remove(1); next.ctx.next();
  assert.deepEqual(next.loads, ['C']);
  const prev = fixture(['A', 'B', 'C'], 1); prev.ctx.remove(1); prev.ctx.prev();
  assert.deepEqual(prev.loads, ['A']);
});
test('repeat-one repeats the detached source without highlighting its replacement', () => {
  const f = fixture(['A', 'B'], 0); f.ctx.remove(0); f.ctx.settings.repeat = 'one'; f.ctx.next();
  assert.deepEqual(f.loads, ['A']); assert.equal(f.ctx.detachedQueueSource, 'A');
});
test('further removals update the detached cursor without taking over playback', () => {
  const f = fixture(['A', 'B', 'C', 'D'], 2); f.ctx.remove(2); f.ctx.remove(0); f.ctx.next();
  assert.deepEqual(f.loads, ['D']);
});

test('repeat-all wraps a detached last item to the sole remaining item', () => {
  const f = fixture(['A', 'B'], 1); f.ctx.remove(1); f.ctx.settings.repeat = 'all'; f.ctx.next();
  assert.deepEqual(f.loads, ['A']);
});
test('shuffle can select any remaining row after active removal', () => {
  const f = fixture(['A', 'B', 'C'], 0); f.ctx.remove(0); f.ctx.settings.shuffle = true;
  f.ctx.Math = { random: () => 0.99, floor: Math.floor };
  f.ctx.next(); assert.deepEqual(f.loads, ['C']);
});

for (const change of ['source', 'stop', 'queue']) {
  test(`delayed folder result cannot take over after ${change}`, async () => {
    const f = fixture([], -1); let finish;
    f.ctx.currentLocalPath = '/A.mp4';
    f.ctx.soda = { fsSiblings: () => new Promise((resolve) => { finish = resolve; }) };
    f.ctx.next();
    if (change === 'queue') f.ctx.folderIntent++;
    else f.ctx.sourceIntent++;
    finish({ next: '/B.mp4' }); await Promise.resolve();
    assert.deepEqual(f.loads, []);
  });
}
test('latest folder-next request alone advances once', async () => {
  const f = fixture([], -1), pending = [];
  f.ctx.currentLocalPath = '/A.mp4';
  f.ctx.soda = { fsSiblings: () => new Promise((resolve) => pending.push(resolve)) };
  f.ctx.next(); f.ctx.next();
  pending[0]({ next: '/old.mp4' }); pending[1]({ next: '/B.mp4' });
  await Promise.resolve(); assert.deepEqual(f.loads, ['/B.mp4']);
});
