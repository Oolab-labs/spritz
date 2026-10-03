'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = 0;
  child.kill = () => child.kills++;
  let handler;
  const timers = new Map(); let timerId = 0;
  const ctx = { setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id), pendingThumbnail: null, fs: { statSync: () => ({ isFile: () => true, dev: 1, ino: 2, size: 100, mtimeMs: 1, ctimeMs: 1 }) }, Buffer, FFMPEG: 'controlled', localMediaPath: s => s, spawn: () => child,
    ipcMain: { handle: (_, cb) => { handler = cb; } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const thumbCache ='), source.indexOf('  // ---- watch history / resume')) + '\nthis.cache = thumbCache; this.cacheFrame = cacheThumbnail;', ctx);
  return { ctx, child, timers, run: (time = 5, consumer = 'preview') => handler(null, { consumer, src: '/film', time }) };
}
test('failed thumbnail producer cannot publish partial output', async () => {
  const f = fixture(), result = f.run(); f.child.stdout.emit('data', Buffer.from('partial')); f.child.emit('close', 1);
  assert.equal(await result, null);
});
test('oversized thumbnail output stops producer and ignores late success', async () => {
  const f = fixture(), result = f.run(); f.child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1)); f.child.emit('close', 0);
  assert.equal(await result, null); assert.equal(f.child.kills, 1);
});
test('successful thumbnail output is cached', async () => {
  const f = fixture(), result = f.run(); f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  const url = await result; assert.equal(url, 'data:image/jpeg;base64,anBlZw=='); assert.equal(await f.run(), url);
});

test('thumbnail spawn exception resolves failure and permits a later successful request', async () => {
  const f = fixture(); f.ctx.spawn = () => { throw new Error('launch failed'); };
  assert.equal(await f.run(), null);
  f.ctx.spawn = () => f.child;
  const result = f.run(); f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  assert.equal(await result, 'data:image/jpeg;base64,anBlZw==');
});

test('thumbnail error followed by close cannot cache failed output', async () => {
  const f = fixture(), result = f.run();
  f.child.stdout.emit('data', Buffer.from('partial')); f.child.emit('error', new Error('failed')); f.child.emit('close', 0);
  assert.equal(await result, null);
  let launches = 0; f.ctx.spawn = () => { launches++; throw new Error('controlled'); };
  assert.equal(await f.run(), null); assert.equal(launches, 1);
});

test('thumbnail cache bucket and extracted frame use the same normalized time', async () => {
  const f = fixture(); const seeks = [];
  f.ctx.spawn = (_, args) => { seeks.push(args[1]); return f.child; };
  const result = f.run(6.2); f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  const url = await result; assert.equal(await f.run(7.1), url);
  assert.deepEqual(seeks, ['5']);
});
test('negative thumbnail requests normalize cache and extraction to zero', async () => {
  const f = fixture(); const seeks = [];
  f.ctx.spawn = (_, args) => { seeks.push(args[1]); return f.child; };
  const result = f.run(-20); f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  const url = await result; assert.equal(await f.run(0), url); assert.deepEqual(seeks, ['0']);
});

test('file mutation during thumbnail extraction suppresses stale publication', async () => {
  const f = fixture(), result = f.run();
  f.child.stdout.emit('data', Buffer.from('old'));
  f.ctx.fs.statSync = () => ({ isFile: () => true, dev: 1, ino: 2, size: 101, mtimeMs: 2, ctimeMs: 2 });
  f.child.emit('close', 0); assert.equal(await result, null);
});
test('file replacement at same path cannot reuse cached thumbnail', async () => {
  const f = fixture(), result = f.run(); f.child.stdout.emit('data', Buffer.from('old')); f.child.emit('close', 0);
  await result;
  f.ctx.fs.statSync = () => ({ isFile: () => true, dev: 1, ino: 3, size: 100, mtimeMs: 1, ctimeMs: 1 });
  let launches = 0; f.ctx.spawn = () => { launches++; throw new Error('controlled'); };
  assert.equal(await f.run(), null); assert.equal(launches, 1);
});

test('thumbnail cache hit refreshes recency before bounded eviction', async () => {
  const f = fixture(), result = f.run(); f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  const url = await result, key = Array.from(f.ctx.cache.keys())[0];
  for (let i = 0; i < 399; i++) f.ctx.cache.set('other-' + i, 'cached');
  assert.equal(await f.run(), url); assert.equal(Array.from(f.ctx.cache.keys()).at(-1), key);
  const next = new EventEmitter(); next.stdout = new EventEmitter(); next.stderr = new EventEmitter();
  f.ctx.spawn = () => next;
  const fresh = f.run(10); next.stdout.emit('data', Buffer.from('next')); next.emit('close', 0); await fresh;
  assert.equal(f.ctx.cache.size, 400); assert.equal(f.ctx.cache.has(key), true); assert.equal(f.ctx.cache.has('other-0'), false);
});

test('thumbnail cache enforces aggregate bytes and retains recent frames', () => {
  const f = fixture(), frame = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 20; i++) f.ctx.cacheFrame(String(i), frame);
  assert.equal(f.ctx.cache.size, 16); assert.equal(f.ctx.cache.has('3'), false); assert.equal(f.ctx.cache.has('4'), true);
  let bytes = 0; for (const value of f.ctx.cache.values()) bytes += Buffer.byteLength(value);
  assert.equal(bytes, 16 * 1024 * 1024);
  f.ctx.cacheFrame('huge', 'x'.repeat(16 * 1024 * 1024 + 1)); assert.equal(f.ctx.cache.size, 0);
});

test('new uncached thumbnail request retires the previous producer without clearing replacement', async () => {
  const f = fixture(), old = f.run();
  const next = new EventEmitter(); next.stdout = new EventEmitter(); next.stderr = new EventEmitter(); next.kill = () => {};
  f.ctx.spawn = () => next;
  const fresh = f.run(10); assert.equal(await old, null); assert.equal(f.child.kills, 1);
  f.child.stdout.emit('data', Buffer.from('old')); f.child.emit('close', 0);
  next.stdout.emit('data', Buffer.from('fresh')); next.emit('close', 0);
  assert.equal(await fresh, 'data:image/jpeg;base64,ZnJlc2g=');
});

test('identical pending thumbnail requests share one producer and completion', async () => {
  const f = fixture(); let launches = 0;
  f.ctx.spawn = () => { launches++; return f.child; };
  const first = f.run(6), second = f.run(7);
  assert.equal(launches, 1); assert.equal(f.child.kills, 0);
  f.child.stdout.emit('data', Buffer.from('shared')); f.child.emit('close', 0);
  assert.equal(await first, 'data:image/jpeg;base64,c2hhcmVk'); assert.equal(await second, await first);
});
test('retiring a shared thumbnail producer resolves all waiters once', async () => {
  const f = fixture(), first = f.run(6), second = f.run(7);
  f.ctx.spawn = () => { throw new Error('controlled replacement failure'); };
  assert.equal(await f.run(10), null);
  assert.equal(await first, null); assert.equal(await second, null); assert.equal(f.child.kills, 1);
});

test('shared thumbnail waiter admission is bounded without cancelling admitted requests', async () => {
  const f = fixture(), admitted = Array.from({ length: 32 }, () => f.run());
  assert.equal(await f.run(), null); assert.equal(f.child.kills, 0);
  f.child.stdout.emit('data', Buffer.from('shared')); f.child.emit('close', 0);
  const results = await Promise.all(admitted);
  assert.equal(results.length, 32); assert.ok(results.every(url => url === 'data:image/jpeg;base64,c2hhcmVk'));
});

test('source retirement drains pending thumbnail waiters before late producer completion', async () => {
  const f = fixture(), first = f.run(), second = f.run();
  f.ctx.loadGen = 1; f.ctx.retireReceiverIntent = () => {}; f.ctx.cancelResolvers = () => {}; f.ctx.clearTimeout = () => {};
  vm.runInContext(source.slice(source.indexOf('  let castResolveRetry ='), source.indexOf('  // Default receiver profile')) + '\nthis.invalidate = invalidateLoad;', f.ctx);
  f.ctx.invalidate(); assert.equal(await first, null); assert.equal(await second, null);
  assert.equal(f.child.kills, 1); assert.equal(f.ctx.pendingThumbnail, null);
  f.child.stdout.emit('data', Buffer.from('late')); f.child.emit('close', 0);
  assert.equal(f.ctx.cache.size, 0);
});

test('thumbnail source retirement terminates a real producer and drains shared callers', { timeout: 10000 }, async t => {
  const { spawn } = require('child_process'), { once } = require('events');
  const f = fixture(); let child, closed = false;
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); });
  f.ctx.spawn = () => {
    child = spawn(process.execPath, ['-e', 'process.stdout.write("partial"); setInterval(() => {}, 1000);']);
    child.once('close', () => { closed = true; }); return child;
  };
  f.ctx.loadGen = 1; f.ctx.retireReceiverIntent = () => {}; f.ctx.cancelResolvers = () => {}; f.ctx.clearTimeout = () => {};
  vm.runInContext(source.slice(source.indexOf('  let castResolveRetry ='), source.indexOf('  // Default receiver profile')) + '\nthis.invalidate = invalidateLoad;', f.ctx);
  const first = f.run(), second = f.run(); await once(child.stdout, 'data');
  const close = once(child, 'close'); f.ctx.invalidate();
  assert.equal(await first, null); assert.equal(await second, null);
  const [code, signal] = await close;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(f.ctx.pendingThumbnail, null); assert.equal(f.ctx.cache.size, 0);
});

test('thumbnail deadline drains shared callers and requests forced termination', async () => {
  const f = fixture(), first = f.run(), second = f.run();
  assert.equal(f.timers.size, 1); Array.from(f.timers.values())[0]();
  assert.equal(await first, null); assert.equal(await second, null); assert.equal(f.child.kills, 1);
  assert.equal(f.timers.size, 0); assert.equal(f.ctx.pendingThumbnail, null);
  f.child.stdout.emit('data', Buffer.from('late')); f.child.emit('close', 0); assert.equal(f.ctx.cache.size, 0);
});

test('late thumbnail deadline after successful completion is inert', async () => {
  const f = fixture(), result = f.run(), deadline = Array.from(f.timers.values())[0];
  f.child.stdout.emit('data', Buffer.from('jpeg')); f.child.emit('close', 0);
  assert.equal(await result, 'data:image/jpeg;base64,anBlZw==');
  deadline(); deadline(); assert.equal(f.child.kills, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.ctx.cache.size, 1);
});
test('duplicate thumbnail deadline delivery terminates producer once', async () => {
  const f = fixture(), result = f.run(), deadline = Array.from(f.timers.values())[0];
  deadline(); deadline(); assert.equal(await result, null); assert.equal(f.child.kills, 1);
});

test('thumbnail consumer identity is validated and retained on producer ownership', async () => {
  const f = fixture(); assert.equal(await f.run(5, 'unknown'), null);
  const result = f.run(5, 'poster'); assert.equal(f.ctx.pendingThumbnail.consumer, 'poster');
  f.child.emit('close', 1); assert.equal(await result, null);
});

test('poster waits for an active preview without cancelling its producer', async () => {
  const f = fixture(), preview = f.run(5);
  const next = new EventEmitter(); next.stdout = new EventEmitter(); next.stderr = new EventEmitter(); next.kill = () => {};
  let launches = 0; f.ctx.spawn = () => { launches++; return next; };
  const poster = f.run(10, 'poster'); assert.equal(launches, 0); assert.equal(f.child.kills, 0);
  f.child.stdout.emit('data', Buffer.from('preview')); f.child.emit('close', 0);
  await preview; assert.equal(launches, 1);
  next.stdout.emit('data', Buffer.from('poster')); next.emit('close', 0);
  assert.equal(await poster, 'data:image/jpeg;base64,cG9zdGVy');
});
test('cancelled preview cannot admit its deferred poster', async () => {
  const f = fixture(), preview = f.run(), poster = f.run(10, 'poster');
  let launches = 0; f.ctx.spawn = () => { launches++; throw new Error('unexpected'); };
  f.ctx.pendingThumbnail(); assert.equal(await preview, null); assert.equal(await poster, null); assert.equal(launches, 0);
});

test('preview joining a poster promotes shared producer priority', async () => {
  const f = fixture(), poster = f.run(5, 'poster'), preview = f.run(5, 'preview');
  assert.equal(f.ctx.pendingThumbnail.consumer, 'preview');
  const next = new EventEmitter(); next.stdout = new EventEmitter(); next.stderr = new EventEmitter(); next.kill = () => {};
  let launches = 0; f.ctx.spawn = () => { launches++; return next; };
  const otherPoster = f.run(10, 'poster'); assert.equal(launches, 0); assert.equal(f.child.kills, 0);
  f.child.stdout.emit('data', Buffer.from('shared')); f.child.emit('close', 0);
  assert.equal(await poster, await preview); assert.equal(launches, 1);
  next.emit('close', 1); assert.equal(await otherPoster, null);
});

test('deferred poster rechecks file revision before admitting its producer', async () => {
  const f = fixture(), preview = f.run(5), poster = f.run(10, 'poster');
  let launches = 0;
  f.ctx.spawn = () => { launches++; throw new Error('should not launch missing source'); };
  // Keep the preview revision valid through its close, then make the deferred admission fail.
  const originalStat = f.ctx.fs.statSync; let checks = 0;
  f.ctx.fs.statSync = () => { if (++checks === 1) return originalStat(); throw new Error('source disappeared'); };
  f.child.stdout.emit('data', Buffer.from('preview')); f.child.emit('close', 0);
  assert.equal(await preview, 'data:image/jpeg;base64,cHJldmlldw==');
  assert.equal(await poster, null); assert.equal(launches, 0); assert.equal(checks, 2);
});

test('deferred poster admission remains bounded during an active preview', async () => {
  const f = fixture(), preview = f.run();
  const posters = Array.from({ length: 31 }, () => f.run(10, 'poster'));
  assert.equal(await f.run(10, 'poster'), null); assert.equal(f.child.kills, 0);
  f.ctx.pendingThumbnail(); assert.equal(await preview, null);
  assert.ok((await Promise.all(posters)).every(value => value === null));
});

test('thumbnail deadline forcibly terminates a producer that ignores SIGTERM', { timeout: 10000 }, async t => {
  const { spawn } = require('child_process'), { once } = require('events');
  const f = fixture(); let child, closed = false;
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); });
  f.ctx.spawn = () => {
    child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);']);
    child.once('close', () => { closed = true; }); return child;
  };
  const result = f.run(); await once(child.stdout, 'data');
  child.kill('SIGTERM');
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const close = once(child, 'close'); Array.from(f.timers.values())[0]();
  assert.equal(await result, null);
  const [code, signal] = await close;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(f.timers.size, 0); assert.equal(f.ctx.pendingThumbnail, null); assert.equal(f.ctx.cache.size, 0);
});

test('completed preview cannot clear deferred poster ownership on late deadline', async () => {
  const f = fixture(), preview = f.run(5), oldDeadline = Array.from(f.timers.values())[0];
  const next = new EventEmitter(); next.stdout = new EventEmitter(); next.stderr = new EventEmitter(); let kills = 0;
  next.kill = () => kills++; f.ctx.spawn = () => next;
  const poster = f.run(10, 'poster');
  f.child.stdout.emit('data', Buffer.from('preview')); f.child.emit('close', 0); await preview;
  const owner = f.ctx.pendingThumbnail; assert.equal(owner.consumer, 'poster');
  oldDeadline(); f.child.emit('close', 0);
  assert.equal(f.ctx.pendingThumbnail, owner); assert.equal(kills, 0); assert.equal(f.timers.size, 1);
  next.stdout.emit('data', Buffer.from('poster')); next.emit('close', 0);
  assert.equal(await poster, 'data:image/jpeg;base64,cG9zdGVy'); assert.equal(f.timers.size, 0);
});

test('thumbnail producer error retires the child and all shared consumers', async () => {
  const f = fixture(), first = f.run(), second = f.run();
  f.child.emit('error', new Error('producer failed'));
  assert.equal(await first, null); assert.equal(await second, null);
  assert.equal(f.child.kills, 1); assert.equal(f.timers.size, 0);
  f.child.emit('error', new Error('late error')); f.child.emit('close', 0);
  assert.equal(f.child.kills, 1); assert.equal(f.ctx.cache.size, 0);
});

for (const stream of ['stdout', 'stderr']) {
  test(`thumbnail ${stream} failure retires extraction without publishing buffered data`, async () => {
    const f = fixture(), first = f.run(), shared = f.run();
    f.child.stdout.emit('data', Buffer.from('partial'));
    f.child[stream].emit('error', new Error('pipe failed'));
    assert.equal(await first, null); assert.equal(await shared, null);
    assert.equal(f.child.kills, 1); assert.equal(f.timers.size, 0);
    f.child[stream].emit('error', new Error('late pipe error'));
    f.child.emit('close', 0);
    assert.equal(f.child.kills, 1); assert.equal(f.ctx.cache.size, 0);
    assert.equal(f.ctx.pendingThumbnail, null);
  });
}
