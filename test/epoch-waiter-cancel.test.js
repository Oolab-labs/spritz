'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const timers = new Map(), results = [], retired = []; let id = 0;
  const epoch = { id: 'epoch-2', playlist: '/owned/playlist', dir: '/owned', running: true };
  const sess = { lingering: new Map(), procs: new Map(), subProcs: new Map(), waiters: new Map(), subWaiters: new Map(), dir: '/owned',
    epochs: { open: () => epoch, list: () => [{ id: 'epoch-1' }, epoch], get: () => epoch, retire: (key) => retired.push(key), close() {} } };
  const ctx = { path, vod: sess, vodGen: 0, vodPreparations: new Set(), fs: { rmSync() {} }, safeStat: () => null,
    VOD_EPOCH_PLAYLIST: () => 'event', VOD_EPOCH_LINGER_MS: 1000, VOD_EPOCH_PLAYLIST_TIMEOUT: 5000,
    setTimeout: (fn) => { timers.set(++id, fn); return id; }, clearTimeout: (key) => timers.delete(key) };
  vm.createContext(ctx);
  const cancel = source.slice(source.indexOf('  function cancelVod()'), source.indexOf('  // Duration and keyframe times'));
  const open = source.slice(source.indexOf('  function openEpochAt('), source.indexOf('  // How far an epoch has produced'));
  vm.runInContext(cancel + open + '\nthis.open = openEpochAt; this.cancel = cancelVod;', ctx);
  return { timers, results, retired, sess, ctx, open: () => ctx.open(sess, 30, (e) => results.push(e)) };
}
test('owned readiness cancellation retires only its epoch and ignores late polls', () => {
  const f = fixture(), dispose = f.open(), callbacks = [...f.timers.values()];
  dispose(); dispose();
  assert.deepEqual(f.retired, ['epoch-2']); assert.deepEqual(f.results, [null]);
  assert.equal(f.sess.epochWaiters.size, 0);
  for (const callback of callbacks) callback();
  assert.equal(f.retired.filter(id => id === 'epoch-2').length, 1);
});
test('completed readiness disposer cannot retire a handed-off epoch', () => {
  const f = fixture(); f.ctx.safeStat = () => true;
  f.sess.epochs.noteFirstSegment = (_, __, cb) => cb();
  const dispose = f.open(); dispose();
  assert.equal(f.results[0].id, 'epoch-2'); assert.deepEqual(f.retired, []);
});
test('epoch open exception drains readiness admission and settles once', () => {
  const f = fixture(); f.sess.epochs.open = () => { throw new Error('open failed'); };
  const dispose = f.open(); dispose();
  assert.deepEqual(f.results, [null]); assert.equal(f.sess.epochWaiters.size, 0); assert.equal(f.timers.size, 0);
});
test('timestamp preparation exception settles and retires its epoch', () => {
  const f = fixture(); f.ctx.safeStat = () => true;
  f.sess.epochs.noteFirstSegment = () => { throw new Error('measurement failed'); };
  const dispose = f.open(); dispose();
  assert.deepEqual(f.results, [null]); assert.deepEqual(f.retired, ['epoch-2']);
  assert.equal(f.sess.epochWaiters.size, 0);
});
test('retirement and caller exceptions cannot strand the readiness waiter', () => {
  const f = fixture(); f.sess.epochs.retire = () => { throw new Error('retire failed'); };
  const dispose = f.ctx.open(f.sess, 30, () => { throw new Error('caller failed'); });
  assert.doesNotThrow(dispose); assert.equal(f.sess.epochWaiters.size, 0);
  assert.doesNotThrow(dispose);
});
test('owned epoch disposal terminates a real child and stale disposal preserves its replacement', { timeout: 5000 }, async () => {
  const { spawn } = require('child_process');
  const { once } = require('events');
  const { createEpochs } = require('../src/main/transport-epoch');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spritz-owned-epoch-'));
  const f = fixture(), children = [], closes = [], ready = [];
  const epochs = createEpochs({ ffmpeg: process.execPath, root,
    spawn: () => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)']);
      children.push(child); closes.push(once(child, 'close')); ready.push(once(child.stdout, 'data'));
      return child;
    } });
  f.sess.epochs = epochs; f.sess.input = '/fixture.mp4'; f.sess.token = 'owned';
  try {
    const disposeOld = f.open(); await ready[0];
    disposeOld();
    assert.deepEqual(await closes[0], [null, 'SIGKILL']);
    assert.throws(() => process.kill(children[0].pid, 0), { code: 'ESRCH' });
    const disposeNew = f.open(); await ready[1];
    const current = epochs.current().id;
    disposeOld();
    assert.equal(epochs.current().id, current);
    assert.equal(process.kill(children[1].pid, 0), true);
    assert.equal(epochs.active(), true);
    disposeNew(); assert.deepEqual(await closes[1], [null, 'SIGKILL']);
    assert.throws(() => process.kill(children[1].pid, 0), { code: 'ESRCH' });
    assert.equal(epochs.active(), false); assert.equal(f.sess.epochWaiters.size, 0);
    assert.equal(f.timers.size, 0); assert.deepEqual(f.results, [null, null]);
  } finally {
    epochs.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(closes);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('VOD cancellation drains epoch readiness and lingering timers immediately', () => {
  const f = fixture(); f.open(); assert.equal(f.timers.size, 2);
  const callbacks = [...f.timers.values()]; f.ctx.cancel();
  assert.equal(f.timers.size, 0); assert.equal(f.sess.epochWaiters.size, 0);
  assert.equal(f.sess.lingering.size, 0); assert.deepEqual(f.results, [null]);
  for (const callback of callbacks) callback();
  assert.deepEqual(f.results, [null]);
});
test('multiple readiness waiters settle once when the session retires', () => {
  const f = fixture(); f.open(); f.open(); f.ctx.cancel(); f.ctx.cancel();
  assert.deepEqual(f.results, [null, null]); assert.equal(f.timers.size, 0);
});

test('late first-timestamp completion cannot publish a retired epoch', () => {
  const f = fixture(); let finish;
  f.ctx.safeStat = () => true;
  f.sess.epochs.noteFirstSegment = (_, __, cb) => { finish = cb; };
  f.open(); f.ctx.cancel(); finish();
  assert.deepEqual(f.results, [null]);
});


test('retired VOD releases producer and waiter registries before notifying callers', () => {
  const f = fixture(); let killed = 0, settled = 0;
  const proc = { kill: () => killed++ };
  f.sess.procs.set('segment', proc); f.sess.subProcs.set('sub', proc);
  f.sess.runs = new Map([['run', { proc }]]); f.sess.presegProc = proc;
  f.sess.waiters.set('segment', [() => {
    assert.equal(f.sess.waiters.size, 0); assert.equal(f.sess.subWaiters.size, 0);
    assert.equal(f.sess.procs.size, 0); assert.equal(f.sess.subProcs.size, 0);
    assert.equal(f.sess.runs.size, 0); assert.equal(f.sess.presegProc, null);
    settled++; throw new Error('caller failed');
  }]);
  f.sess.subWaiters.set('sub', [value => { assert.equal(value, false); settled++; }]);
  f.ctx.cancel(); f.ctx.cancel();
  assert.equal(killed, 4); assert.equal(settled, 2);
});

test('VOD retirement drains actual segment, subtitle, run and presegment children', { timeout: 5000 }, async () => {
  const { spawn } = require('child_process');
  const { once } = require('events');
  const f = fixture(), children = [], closes = [];
  try {
    const ready = [];
    for (let i = 0; i < 4; i++) {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)']);
      children.push(child); closes.push(once(child, 'close'));
      ready.push(once(child.stdout, 'data'));
    }
    await Promise.all(ready);
    f.sess.procs.set('segment', children[0]);
    f.sess.subProcs.set('subtitle', children[1]);
    f.sess.runs = new Map([['run', { proc: children[2] }]]);
    f.sess.presegProc = children[3];
    f.ctx.cancel();
    const outcomes = await Promise.all(closes);
    for (let i = 0; i < children.length; i++) {
      assert.deepEqual(outcomes[i], [null, 'SIGKILL']);
      assert.throws(() => process.kill(children[i].pid, 0), { code: 'ESRCH' });
    }
    assert.equal(f.sess.procs.size, 0); assert.equal(f.sess.subProcs.size, 0);
    assert.equal(f.sess.runs.size, 0); assert.equal(f.sess.presegProc, null);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled(closes);
  }
});
