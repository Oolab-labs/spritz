'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const probes = [], children = [], results = [], serves = [], disposed = [], registrations = [], removed = [];
  let id = 0;
  const ctx = { path, remuxRoot: '/owned', FFMPEG: 'ffmpeg', newToken: () => String(++id),
    sniffCharenc: () => 'UTF-8', fs: { mkdirSync() {}, unlinkSync: p => removed.push(p), statSync: () => ({ size: 20 }) },
    probeTracks: (_, cb) => { probes.push(cb); return () => disposed.push(true); },
    serve: (_, cb) => { serves.push(cb); const job = { cancelled: false }; registrations.push(job); return () => { job.cancelled = true; cb(null); }; }, spawn: () => {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = 0;
      child.kill = () => { child.kills++; child.emit('close', 1); }; children.push(child); return child;
    } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const directSubJobs ='), source.indexOf('  function teardown()')) + '\nthis.prepare = prepareDirectSubs; this.cancel = cancelDirectSubJobs;', ctx);
  return { ctx, probes, children, results, serves, disposed, registrations, removed, cancel: ctx.cancel,
    prepare: (isFile, extra = []) => ctx.prepare('/movie', isFile, extra, (tracks) => results.push(tracks)) };
}
test('subtitle cancel during track probing prevents extraction', () => {
  const f = fixture(); f.prepare(true); f.cancel(); f.probes[0]({ subs: [{ idx: 0 }] });
  assert.equal(f.children.length, 0); assert.equal(f.disposed.length, 1); assert.equal(f.results.length, 0);
});
test('subtitle cancellation kills all owned children and suppresses publication', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]); f.cancel();
  assert.deepEqual(f.children.map((c) => c.kills), [1, 1]);
  f.children[0].emit('close', 0); assert.equal(f.serves.length, 0); assert.equal(f.results.length, 0);
});
test('error followed by close cannot prematurely finish a multi-track job', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]);
  f.children[0].emit('error', new Error('failed')); f.children[0].emit('close', 1);
  assert.equal(f.results.length, 0);
  f.children[1].emit('close', 0); f.serves[0]('subtitle-url');
  assert.equal(f.results.length, 1); assert.equal(f.results[0].length, 1);
});
test('cancel while file registration waits rejects its late URL', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }]); f.children[0].emit('close', 0);
  f.cancel(); f.serves[0]('late-url'); assert.equal(f.results.length, 0);
});

test('subtitle cancellation retires every pending file registration', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]);
  for (const child of f.children) child.emit('close', 0);
  f.cancel();
  assert.deepEqual(f.registrations.map(job => job.cancelled), [true, true]);
  assert.equal(f.results.length, 0);
});

test('duplicate producer close during registration cannot publish a second track', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]);
  f.children[0].emit('close', 0); f.children[0].emit('close', 0);
  assert.equal(f.serves.length, 1);
  f.serves[0]('a-url'); f.serves[0]('duplicate-url');
  assert.equal(f.results.length, 0);
  f.children[1].emit('close', 0); f.serves[1]('b-url');
  assert.deepEqual(Array.from(f.results[0], t => t.url), ['a-url', 'b-url']);
});

test('late producer error after successful close cannot settle pending registration', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]);
  f.children[0].emit('close', 0); f.children[0].emit('error', new Error('late'));
  f.children[1].emit('close', 0); f.serves[1]('b-url');
  assert.equal(f.results.length, 0);
  f.serves[0]('a-url');
  assert.deepEqual(Array.from(f.results[0], t => t.url), ['b-url', 'a-url']);
});

test('reentrant retirement disposes a subtitle probe handle returned after cancellation', () => {
  const f = fixture(); let disposed = 0;
  f.ctx.probeTracks = (_, cb) => { f.cancel(); cb({ subs: [{ idx: 0 }] }); return () => disposed++; };
  f.prepare(true);
  assert.equal(disposed, 1); assert.equal(f.children.length, 0); assert.equal(f.results.length, 0);
});

test('synchronous successful subtitle completion does not cancel its returned probe handle', () => {
  const f = fixture(); let disposed = 0;
  f.ctx.probeTracks = (_, cb) => { cb({ subs: [] }); return () => disposed++; };
  const cancel = f.prepare(true); cancel();
  assert.equal(disposed, 0); assert.equal(f.results.length, 1);
});

test('duplicate track probe results cannot start a second subtitle extraction batch', () => {
  const f = fixture(); f.prepare(true);
  f.probes[0]({ subs: [{ idx: 0, name: 'first' }] });
  f.probes[0]({ subs: [{ idx: 1, name: 'duplicate' }] });
  assert.equal(f.children.length, 1);
  f.children[0].emit('close', 0); f.serves[0]('first-url');
  assert.equal(f.results.length, 1); assert.equal(f.results[0].length, 1);
  assert.equal(f.results[0][0].name, 'first');
});

test('failed subtitle output is removed without deleting a successful completed track', () => {
  const f = fixture(); f.prepare(false, [{ path: '/a.srt' }, { path: '/b.srt' }]);
  f.children[0].emit('close', 1);
  assert.deepEqual(f.removed, ['/owned/subs/1.vtt']);
  f.children[1].emit('close', 0); f.serves[0]('b-url');
  f.children[1].emit('close', 0);
  assert.deepEqual(f.removed, ['/owned/subs/1.vtt']);
  assert.equal(f.results[0][0].url, 'b-url');
});

test('subtitle retirement terminates a real local producer and removes its partial file', { timeout: 10000 }, async (t) => {
  const os = require('os'), { spawn } = require('child_process'), { once } = require('events');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-sub-retire-'));
  let child, closed = false, results = 0, publications = 0;
  t.after(() => { if (child && !closed) child.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); });
  const ctx = { path, fs, remuxRoot: root, FFMPEG: 'controlled-producer', newToken: () => 'owned',
    sniffCharenc: () => 'UTF-8', serve: () => publications++, spawn: (_, args) => {
      child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "partial subtitle"); process.stdout.write("ready"); setInterval(() => {}, 1000);', args.at(-1)]);
      child.once('close', () => { closed = true; }); return child;
    } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const directSubJobs ='), source.indexOf('  function teardown()')) + '\nthis.prepare = prepareDirectSubs;', ctx);
  const cancel = ctx.prepare('/film', false, [{ path: '/subtitle.srt' }], () => results++);
  await once(child.stdout, 'data');
  const output = path.join(root, 'subs', 'owned.vtt');
  assert.equal(fs.existsSync(output), true);
  const close = once(child, 'close'); cancel(); cancel();
  const [code, signal] = await close;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(fs.existsSync(output), false); assert.equal(results, 0); assert.equal(publications, 0);
});
