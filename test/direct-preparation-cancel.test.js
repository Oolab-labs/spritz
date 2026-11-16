'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const probes = [], results = [], fallbacks = [], disposed = [];
  const ctx = { path, VIDEO_OK: new Set(['h264']), AUDIO_OK: new Set(['aac']),
    lanAddress: () => '127.0.0.1', probe: (_, cb) => { probes.push(cb); return () => disposed.push(true); },
    serve: (_, cb) => cb('file-url') };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const directPreparations ='), source.indexOf('  // Extract embedded text subtitle tracks')) + '\nthis.prepare = prepareCast; this.cancel = cancelDirectPreparations;', ctx);
  return { ctx, probes, results, fallbacks, disposed, cancel: ctx.cancel,
    prepare: (fallback) => ctx.prepare('/movie.mkv', (url) => results.push(url), fallback ? () => fallbacks.push(true) : null) };
}
test('cancelled codec probe cannot launch HLS fallback', () => {
  const f = fixture(); f.prepare(true); f.cancel(); f.probes[0](null);
  assert.deepEqual(f.results, [null]); assert.equal(f.fallbacks.length, 0);
  assert.equal(f.disposed.length, 1);
});
test('owned direct preparation disposer follows HLS fallback and rejects late completion', () => {
  const f = fixture(); let finish, disposed = 0, started = 0;
  const cancel = f.ctx.prepare('/film.mp4', url => f.results.push(url), (_, cb) => {
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

test('owned direct preparation cancels subtitle extraction before handoff', () => {
  const f = fixture(); let finishSubs, stopped = 0;
  f.ctx.prepareDirectSubs = (_, __, cb) => { finishSubs = cb; return () => { stopped++; cb([]); }; };
  const cancel = f.ctx.prepare('/film.mp4', url => f.results.push(url), null, { directSubs: true });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  cancel(); cancel(); finishSubs([{ url: 'late-sub' }]);
  assert.equal(stopped, 1); assert.deepEqual(f.results, [null]);
});
test('completed direct subtitle handoff makes preparation disposal inert', () => {
  const f = fixture(); let finishSubs, stopped = 0;
  f.ctx.prepareDirectSubs = (_, __, cb) => { finishSubs = cb; return () => stopped++; };
  const cancel = f.ctx.prepare('/film.mp4', url => f.results.push(url), null, { directSubs: true });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' }); finishSubs([]); cancel();
  assert.equal(stopped, 0); assert.deepEqual(f.results, ['file-url']);
});

test('direct preparation retires pending file registration before readiness', () => {
  const f = fixture(); let publish, stopped = 0;
  f.ctx.serve = (_, cb) => { publish = cb; return () => { stopped++; cb(null); }; };
  const cancel = f.ctx.prepare('/film.mp4', url => f.results.push(url));
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' }); cancel(); publish('late-url');
  assert.equal(stopped, 1); assert.deepEqual(f.results, [null]);
});

test('duplicate codec results cannot start a second HLS fallback producer', () => {
  const f = fixture(); f.prepare(true);
  f.probes[0]({ vcodec: 'h264' }); f.probes[0]({ vcodec: 'h264' });
  assert.equal(f.fallbacks.length, 1);
});

test('duplicate codec results cannot register a second direct file while readiness is pending', () => {
  const f = fixture(); let calls = 0, publish;
  f.ctx.serve = (_, cb) => { calls++; publish = cb; };
  f.ctx.prepare('/film.mp4', url => f.results.push(url));
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  f.probes[0]({ vcodec: 'h264', acodec: 'aac' });
  assert.equal(calls, 1); publish('file-url'); assert.deepEqual(f.results, ['file-url']);
});
