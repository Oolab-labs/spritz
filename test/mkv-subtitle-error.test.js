'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture(throws = false) {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
  let kills = 0, done = 0, writes = 0, served = 0; child.kill = () => kills++;
  const timers = new Set(), req = new EventEmitter(); req.destroyed = false;
  const res = new EventEmitter(); Object.assign(res, { writableEnded: false, writeHead: () => writes++, end() {} });
  const ctx = { subSeekArgs: () => [], mkvEntry: { token: 't', subs: [{ name: 's', kind: 'embedded', ref: 0 }], subCache: {}, input: '/film' }, mkvSubProcs: [], fs: { mkdirSync() {}, unlinkSync() {} }, path, remuxRoot: '/tmp/test', newToken: () => 'out', safeStat: () => null, FFMPEG: 'controlled', spawn: () => { if (throws) throw Error('spawn'); return child; }, clog() {}, Date, SUB_BUDGET_MS: 1, SUB_GRACE_MS: 1, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn), serveFile: () => served++ };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('  function runSubExtract('), source.indexOf('  function serveMkvStream(')), ctx);
  ctx.runSubExtract(req, res, 't', 's', () => done++);
  return { child, ctx, timers, req, res, counts: () => ({ kills, done, writes, served }) };
}
test('subtitle spawn exception releases the queue with one failure response', () => {
  const f = fixture(true); assert.deepEqual(f.counts(), { kills: 0, done: 1, writes: 1, served: 0 });
});
test('subtitle producer error cannot publish or respond again on late close', () => {
  const f = fixture(); f.child.emit('error', Error('failed'));
  f.child.emit('error', Error('late')); f.child.emit('close', 0);
  assert.deepEqual(f.counts(), { kills: 1, done: 1, writes: 1, served: 0 });
  assert.equal(f.ctx.mkvSubProcs.length, 0); assert.equal(f.timers.size, 0);
});

test('successful subtitle output survives late close, error, and deadline delivery', () => {
  const f = fixture(), deadline = Array.from(f.timers)[0];
  let removed = 0, shifted = 0;
  f.ctx.fs.unlinkSync = () => removed++;
  f.ctx.safeStat = () => ({ size: 20 }); f.ctx.shiftVtt = () => shifted++;
  f.child.emit('close', 0);
  const published = f.ctx.mkvEntry.subCache.s;
  assert.ok(published); assert.equal(shifted, 1);
  f.child.emit('close', 0); f.child.emit('error', Error('late')); deadline();
  assert.deepEqual(f.counts(), { kills: 0, done: 1, writes: 0, served: 1 });
  assert.equal(shifted, 1); assert.equal(removed, 0);
  assert.equal(f.ctx.mkvEntry.subCache.s, published); assert.equal(f.timers.size, 0);
});

for (const event of ['aborted', 'response-close']) {
  test(`subtitle ${event} retires the producer without publishing late output`, () => {
    const f = fixture(), deadline = Array.from(f.timers)[0];
    f.ctx.safeStat = () => ({ size: 20 }); f.ctx.shiftVtt = () => {};
    if (event === 'aborted') f.req.emit('aborted'); else f.res.emit('close');
    f.res.emit('close'); f.req.emit('aborted'); deadline(); f.child.emit('close', 0);
    assert.deepEqual(f.counts(), { kills: 1, done: 1, writes: 0, served: 0 });
    assert.equal(f.ctx.mkvEntry.subCache.s, undefined); assert.equal(f.timers.size, 0);
  });
}
test('normal request completion does not abandon the outstanding subtitle response', () => {
  const f = fixture(); f.req.emit('close');
  assert.equal(f.counts().kills, 0); assert.equal(f.counts().done, 0);
  f.ctx.safeStat = () => ({ size: 20 }); f.ctx.shiftVtt = () => {};
  f.child.emit('close', 0); f.res.emit('close');
  assert.deepEqual(f.counts(), { kills: 0, done: 1, writes: 0, served: 1 });
});

test('real HTTP disconnect kills the subtitle child and discards its output', { timeout: 10000 }, async t => {
  const http = require('http'), os = require('os');
  const { spawn } = require('child_process'), { once } = require('events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-sub-http-'));
  let child, childClosed = false, done = 0, served = 0, request;
  const timers = new Set();
  const ctx = { subSeekArgs: () => [], mkvEntry: { token: 't', subs: [{ name: 's', kind: 'embedded', ref: 0 }], subCache: {}, input: '/film' }, mkvSubProcs: [], fs, path, remuxRoot: root, newToken: () => 'out', safeStat: file => { try { return fs.statSync(file); } catch { return null; } }, FFMPEG: 'controlled', spawn: (_binary, args) => {
    child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "WEBVTT\\n\\npartial"); process.stdout.write("ready"); setInterval(() => {}, 1000);', args.at(-1)]);
    child.once('close', () => { childClosed = true; }); return child;
  }, clog() {}, Date, SUB_BUDGET_MS: 60000, SUB_GRACE_MS: 1000,
  setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
  clearTimeout: id => { clearTimeout(id); timers.delete(id); }, serveFile: () => served++ };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('  function runSubExtract('), source.indexOf('  function serveMkvStream(')), ctx);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const server = http.createServer((req, res) => {
    ctx.runSubExtract(req, res, 't', 's', () => done++);
    child.stdout.once('data', ready);
  });
  t.after(async () => {
    if (request) request.destroy();
    if (child && !childClosed) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    for (const id of timers) clearTimeout(id);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/sub' }); request.on('error', () => {});
  await started;
  assert.equal(done, 0); assert.equal(childClosed, false);
  assert.ok(fs.existsSync(path.join(root, 'subs/out.vtt')));
  const closed = once(child, 'close'); request.destroy();
  const [code, signal] = await closed;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(done, 1); assert.equal(served, 0); assert.equal(timers.size, 0);
  assert.equal(ctx.mkvSubProcs.length, 0); assert.equal(ctx.mkvEntry.subCache.s, undefined);
  assert.equal(fs.existsSync(path.join(root, 'subs/out.vtt')), false);
});

test('subtitle stderr error retires extraction and cannot publish on close', () => {
  const f = fixture(); f.child.stderr.emit('error', Error('pipe'));
  f.child.emit('close', 0);
  assert.deepEqual(f.counts(), { kills: 1, done: 1, writes: 1, served: 0 });
});
test('subtitle response error abandons extraction without a failure response', () => {
  const f = fixture(); f.res.emit('error', Error('socket'));
  f.child.emit('close', 0);
  assert.deepEqual(f.counts(), { kills: 1, done: 1, writes: 0, served: 0 });
});
test('unusable subtitle output is discarded when salvage fails', () => {
  const f = fixture(); let removed = 0;
  f.ctx.fs.unlinkSync = () => removed++;
  f.ctx.fs.readFileSync = () => 'partial'; f.ctx.trimToCompleteCues = () => null;
  f.child.emit('close', 1);
  assert.equal(removed, 1); assert.equal(f.counts().done, 1);
  assert.equal(f.counts().served, 0); assert.equal(f.counts().writes, 1);
});

for (const outcome of ['success', 'error', 'abandon']) {
  test(`subtitle ${outcome} detaches request ownership listeners`, () => {
    const f = fixture();
    assert.equal(f.req.listenerCount('aborted'), 1); assert.equal(f.res.listenerCount('close'), 1);
    if (outcome === 'success') { f.ctx.safeStat = () => ({ size: 20 }); f.ctx.shiftVtt = () => {}; f.child.emit('close', 0); }
    else if (outcome === 'error') f.child.emit('error', Error('failed'));
    else f.res.emit('close');
    assert.equal(f.req.listenerCount('aborted'), 0); assert.equal(f.res.listenerCount('close'), 0);
    assert.equal(f.res.listenerCount('error'), 1);
    assert.doesNotThrow(() => f.res.emit('error', Error('late socket error')));
    assert.equal(f.counts().done, 1);
  });
}
