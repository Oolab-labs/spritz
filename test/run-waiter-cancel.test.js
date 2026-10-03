'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
test('VOD run cancellation immediately drains polling and rejects queued callbacks', () => {
  const timers = new Map(), results = [];
  const run = { proc: { kill() {} }, from: 0, count: 10 };
  const sess = { dir: '/owned', runs: new Map([['', run]]), procs: new Map(), subProcs: new Map(), waiters: new Map(), subWaiters: new Map() };
  const ctx = { vod: sess, vodGen: 0, vodPreparations: new Set(), fs: { rmSync() {} },
    segmentPath: () => '/owned/0.ts', safeStat: () => null, runSegmentReady: () => false,
    VOD_RUN_TIMEOUT: 10000, VOD_RUN_POLL_MS: 100,
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(ctx);
  const cancel = source.slice(source.indexOf('  function cancelVod()'), source.indexOf('  // Duration and keyframe times'));
  const start = source.indexOf('  function ensureSegmentViaRun(');
  const end = source.indexOf('  // Produce segment `index`, or join', start);
  vm.runInContext(cancel + source.slice(start, end) + '\nthis.run = ensureSegmentViaRun; this.cancel = cancelVod;', ctx);
  ctx.run(sess, 0, null, value => results.push(value));
  const queued = timers.get(1);
  assert.equal(timers.size, 1);
  ctx.cancel();
  assert.equal(timers.size, 0); assert.equal(sess.runWaiters.size, 0);
  assert.deepEqual(results, [false]);
  queued(); ctx.cancel(); assert.deepEqual(results, [false]);
});

for (const code of [0, 1]) {
  test(`run exit ${code} ${code === 0 ? 'publishes' : 'rejects'} its final segment`, () => {
    const { EventEmitter } = require('events');
    const { runSegmentReady } = require('../src/main/vod-segment');
    const proc = new EventEmitter(); proc.stderr = new EventEmitter();
    let timer, written = false;
    const results = [], sess = { dir: '/owned', runs: new Map(), segments: [] };
    const ctx = { vod: sess, FFMPEG: 'ffmpeg', VOD_RUN_SEGMENTS: 10, VOD_RUN_TIMEOUT: 10000, VOD_RUN_POLL_MS: 100,
      segmentPath: (_, index) => `/owned/${index}.ts`, safeStat: file => written && file === '/owned/0.ts',
      runSegmentReady, segmentRunArgs: () => [], spawn: () => proc, touchSegment() {},
      setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {} };
    vm.createContext(ctx);
    const start = source.indexOf('  function ensureSegmentViaRun(');
    vm.runInContext(source.slice(start, source.indexOf('  // Produce segment `index`, or join', start)) + '\nthis.run = ensureSegmentViaRun;', ctx);
    ctx.run(sess, 0, null, value => results.push(value));
    written = true; proc.emit('close', code); timer();
    assert.deepEqual(results, [code === 0]);
    ctx.run(sess, 0, null, value => results.push(value));
    assert.deepEqual(results, [code === 0, code === 0]);
  });
}

function runFixture(run) {
  const { runSegmentReady } = require('../src/main/vod-segment');
  const sess = { dir: '/owned', runs: new Map(run ? [['', run]] : []), segments: [] }, results = [];
  let timer, now = 0, spawns = 0;
  const ctx = { vod: sess, FFMPEG: 'ffmpeg', VOD_RUN_SEGMENTS: 10, VOD_RUN_TIMEOUT: 100, VOD_RUN_POLL_MS: 10,
    Date: { now: () => now }, segmentPath: (_, index) => `/owned/${index}.ts`, safeStat: () => null,
    runSegmentReady, segmentRunArgs: () => [], spawn: () => { spawns++; throw new Error('spawn failed'); }, touchSegment() {},
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {} };
  vm.createContext(ctx);
  const start = source.indexOf('  function ensureSegmentViaRun(');
  vm.runInContext(source.slice(start, source.indexOf('  // Produce segment `index`, or join', start)) + '\nthis.run = ensureSegmentViaRun;', ctx);
  return { ctx, sess, results, request: index => ctx.run(sess, index, null, value => results.push(value)),
    timeout: () => { now = 101; timer(); }, spawns: () => spawns };
}

test('run deadline kills only its owned producer and settles failure', () => {
  let killed = 0;
  const run = { from: 0, count: 10, proc: { kill: signal => { assert.equal(signal, 'SIGKILL'); killed++; } } };
  const f = runFixture(run);
  f.request(0); f.timeout();
  assert.equal(killed, 1); assert.equal(run.proc, null); assert.equal(run.failed, true);
  assert.deepEqual(f.results, [false]); assert.equal(f.sess.runWaiters.size, 0);
});

test('completed run cannot validate an unrelated cached final segment', () => {
  const f = runFixture({ from: 0, count: 10, completed: true, proc: null });
  f.ctx.safeStat = file => file === '/owned/20.ts';
  f.request(20);
  assert.equal(f.spawns(), 1);
  assert.deepEqual(f.results, [false]);
});
