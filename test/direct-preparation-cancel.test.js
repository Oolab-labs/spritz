'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const probes = [], ready = [], remux = [], results = [], fallbacks = [], disposed = [];
  const ctx = { path, VIDEO_OK: new Set(['h264']), AUDIO_OK: new Set(['aac']),
    lanAddress: () => '127.0.0.1', probe: (_, cb) => { probes.push(cb); return () => disposed.push(true); },
    ensure: (cb) => ready.push(cb), remuxToTemp: (_, __, cb) => remux.push(cb),
    serve: (_, cb) => cb('file-url') };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const directPreparations ='), source.indexOf('  // Extract embedded text subtitle tracks')) + '\nthis.prepare = prepareCast; this.cancel = cancelDirectPreparations;', ctx);
  return { ctx, probes, ready, remux, results, fallbacks, disposed, cancel: ctx.cancel,
    prepare: (fallback) => ctx.prepare('/movie.mkv', true, (url) => results.push(url), fallback ? () => fallbacks.push(true) : null) };
}
test('cancelled codec probe cannot launch HLS fallback', () => {
  const f = fixture(); f.prepare(true); f.cancel(); f.probes[0](null);
  assert.deepEqual(f.results, [null]); assert.equal(f.fallbacks.length, 0);
  assert.equal(f.disposed.length, 1);
});
test('cancel before remux server readiness starts no producer', () => {
  const f = fixture(); f.prepare(); f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  f.cancel(); f.ready[0]();
  assert.equal(f.remux.length, 0); assert.deepEqual(f.results, [null]);
});
test('cancel during remux rejects late file publication', () => {
  const f = fixture(); f.prepare(); f.probes[0]({ vcodec: 'h264' }); f.ready[0]();
  f.cancel(); f.remux[0]('/completed.mp4');
  assert.deepEqual(f.results, [null]);
});
test('uncancelled direct remux result still publishes', () => {
  const f = fixture(); f.prepare(); f.probes[0]({ vcodec: 'h264' }); f.ready[0](); f.remux[0]('/completed.mp4');
  assert.deepEqual(f.results, ['file-url']);
});
test('owned direct preparation disposer follows HLS fallback and rejects late completion', () => {
  const f = fixture(); let finish, disposed = 0, started = 0;
  const cancel = f.ctx.prepare('/film.mp4', true, url => f.results.push(url), (_, cb) => {
    started++; finish = cb; return () => { disposed++; cb(null); };
  });
  f.probes[0](null); f.probes[0](null);
  assert.equal(started, 1);
  cancel(); cancel(); finish('http://late');
  assert.equal(disposed, 1); assert.deepEqual(f.results, [null]);
});
test('owned direct preparation cancellation before probe cannot launch fallback', () => {
  const f = fixture(), cancel = f.prepare(true); cancel(); f.probes[0](null);
  assert.equal(f.fallbacks.length, 0); assert.equal(f.disposed.length, 1);
});

test('retired remux error cannot clear replacement process ownership', () => {
  const { EventEmitter } = require('events');
  const children = [], results = [];
  let id = 0;
  const ctx = { path, remuxRoot: '/owned', remuxProc: null, remuxOut: null,
    FFMPEG: 'ffmpeg', fs: { mkdirSync() {}, unlinkSync() {} }, newToken: () => String(++id), safeStat: () => true,
    spawn: () => { const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child; } };
  ctx.cancelRemux = () => { ctx.remuxProc = null; ctx.remuxOut = null; };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function remuxToTemp('), source.indexOf('  // (Removed: setMasterDefaultAudio')) + '\nthis.run = remuxToTemp;', ctx);
  ctx.run('/A', false, (out) => results.push(out));
  ctx.run('/B', false, (out) => results.push(out));
  children[0].emit('error', new Error('late failure'));
  assert.equal(ctx.remuxProc, children[1]);
  children[1].emit('close', 0);
  assert.deepEqual(results, ['/owned/2.mp4']);
});

test('owned direct preparation cancels subtitle extraction before handoff', () => {
  const f = fixture(); let finishSubs, stopped = 0;
  f.ctx.prepareDirectSubs = (_, __, ___, cb) => { finishSubs = cb; return () => { stopped++; cb([]); }; };
  const cancel = f.ctx.prepare('/film.mp4', true, url => f.results.push(url), null, { directSubs: true });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  cancel(); cancel(); finishSubs([{ url: 'late-sub' }]);
  assert.equal(stopped, 1); assert.deepEqual(f.results, [null]);
});
test('completed direct subtitle handoff makes preparation disposal inert', () => {
  const f = fixture(); let finishSubs, stopped = 0;
  f.ctx.prepareDirectSubs = (_, __, ___, cb) => { finishSubs = cb; return () => stopped++; };
  const cancel = f.ctx.prepare('/film.mp4', true, url => f.results.push(url), null, { directSubs: true });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' }); finishSubs([]); cancel();
  assert.equal(stopped, 0); assert.deepEqual(f.results, ['file-url']);
});

test('owned remux cancellation kills only its child and preserves replacement ownership', () => {
  const { EventEmitter } = require('events');
  const children = [], removed = [], results = []; let id = 0;
  const ctx = { path, remuxRoot: '/owned', remuxProc: null, remuxOut: null,
    FFMPEG: 'ffmpeg', fs: { mkdirSync() {}, unlinkSync: p => removed.push(p) },
    newToken: () => String(++id), safeStat: () => true,
    spawn: () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kills = 0;
      c.kill = () => { c.kills++; c.emit('close', 1); }; children.push(c); return c; } };
  ctx.cancelRemux = () => { ctx.remuxProc = null; ctx.remuxOut = null; };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function remuxToTemp('), source.indexOf('  // (Removed: setMasterDefaultAudio')) + '\nthis.run = remuxToTemp;', ctx);
  const cancelA = ctx.run('/A', false, out => results.push(out));
  ctx.run('/B', false, out => results.push(out)); cancelA(); cancelA();
  assert.equal(children[0].kills, 1); assert.equal(children[1].kills, 0);
  assert.equal(ctx.remuxProc, children[1]); assert.equal(ctx.remuxOut, '/owned/2.mp4');
  assert.deepEqual(removed, ['/owned/1.mp4', '/owned/1.mp4']);
  children[0].emit('error', new Error('late')); children[1].emit('close', 0);
  assert.deepEqual(results, ['/owned/2.mp4']);
});

test('direct preparation retains and disposes its remux producer', () => {
  const f = fixture(); let killed = 0;
  f.ctx.remuxToTemp = (_, __, cb) => { f.remux.push(cb); return () => { killed++; cb(null); }; };
  const cancel = f.prepare(); f.probes[0]({ vcodec: 'h264' }); f.ready[0]();
  cancel(); cancel(); f.remux[0]('/late.mp4');
  assert.equal(killed, 1); assert.deepEqual(f.results, [null]);
});

test('direct preparation retires pending file registration before readiness', () => {
  const f = fixture(); let publish, stopped = 0;
  f.ctx.serve = (_, cb) => { publish = cb; return () => { stopped++; cb(null); }; };
  const cancel = f.ctx.prepare('/film.mp4', true, url => f.results.push(url));
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' }); cancel(); publish('late-url');
  assert.equal(stopped, 1); assert.deepEqual(f.results, [null]);
});

test('retired remux removes output recreated before its late close while successful output survives', () => {
  const { EventEmitter } = require('events');
  const children = [], files = new Set(); let id = 0;
  const ctx = { path, remuxRoot: '/owned', remuxProc: null, remuxOut: null, FFMPEG: 'ffmpeg',
    fs: { mkdirSync() {}, unlinkSync: p => files.delete(p) }, newToken: () => String(++id), safeStat: p => files.has(p),
    spawn: () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; children.push(c); return c; },
    cancelRemux: () => {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function remuxToTemp('), source.indexOf('  // (Removed: setMasterDefaultAudio')) + '\nthis.run = remuxToTemp;', ctx);
  const cancel = ctx.run('/A', false, () => assert.fail('retired output published'));
  cancel(); files.add('/owned/1.mp4'); children[0].emit('close', 1);
  assert.equal(files.has('/owned/1.mp4'), false);
  ctx.run('/B', false, () => {}); files.add('/owned/2.mp4');
  children[1].emit('close', 0); children[1].emit('close', 0);
  assert.equal(files.has('/owned/2.mp4'), true);
});

test('owned remux disposer terminates a real local producer and removes its output', { timeout: 10000 }, async (t) => {
  const os = require('os'), { spawn } = require('child_process'), { once } = require('events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-remux-retire-'));
  let child, closed = false, published = 0;
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); });
  const ctx = { path, fs, remuxRoot: root, remuxProc: null, remuxOut: null, FFMPEG: 'controlled-producer',
    newToken: () => 'owned', safeStat: p => { try { return fs.statSync(p); } catch (_) { return null; } },
    cancelRemux: () => {}, spawn: (_, args) => {
      child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "partial"); process.stdout.write("ready"); setInterval(() => {}, 1000);', args.at(-1)]);
      child.once('close', () => { closed = true; }); return child;
    } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function remuxToTemp('), source.indexOf('  // (Removed: setMasterDefaultAudio')) + '\nthis.run = remuxToTemp;', ctx);
  const cancel = ctx.run('/input', false, () => published++);
  await once(child.stdout, 'data');
  assert.equal(fs.existsSync(path.join(root, 'owned.mp4')), true);
  const close = once(child, 'close'); cancel(); cancel();
  const [code, signal] = await close;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(fs.existsSync(path.join(root, 'owned.mp4')), false);
  assert.equal(ctx.remuxProc, null); assert.equal(ctx.remuxOut, null); assert.equal(published, 0);
});

test('global remux retirement detaches ownership before reentrant child shutdown', () => {
  const removed = [], replacement = { kill: () => assert.fail('replacement killed') };
  const ctx = { remuxProc: null, remuxOut: '/old.mp4', fs: { unlinkSync: p => removed.push(p) } };
  ctx.remuxProc = { kill: signal => {
    assert.equal(signal, 'SIGKILL'); assert.equal(ctx.remuxProc, null); assert.equal(ctx.remuxOut, null);
    ctx.remuxProc = replacement; ctx.remuxOut = '/new.mp4';
  } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function cancelRemux('), source.indexOf('  function cancelHls(')) + '\nthis.cancel = cancelRemux;', ctx);
  ctx.cancel();
  assert.equal(ctx.remuxProc, replacement); assert.equal(ctx.remuxOut, '/new.mp4');
  assert.deepEqual(removed, ['/old.mp4']);
});

test('duplicate codec results cannot start a second finite remux producer', () => {
  const f = fixture(); f.prepare();
  f.probes[0]({ vcodec: 'h264' }); f.probes[0]({ vcodec: 'h264' });
  assert.equal(f.ready.length, 1); f.ready[0](); assert.equal(f.remux.length, 1);
  f.remux[0]('/completed.mp4'); assert.deepEqual(f.results, ['file-url']);
});

test('duplicate codec results cannot register a second direct file while readiness is pending', () => {
  const f = fixture(); let calls = 0, publish;
  f.ctx.serve = (_, cb) => { calls++; publish = cb; };
  f.ctx.prepare('/film.mp4', true, url => f.results.push(url));
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  assert.equal(calls, 1); publish('file-url'); assert.deepEqual(f.results, ['file-url']);
});
