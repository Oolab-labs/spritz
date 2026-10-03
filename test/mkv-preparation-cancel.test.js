'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const ready = [], probes = [], results = [], disposals = [], retirements = [];
  const ctx = { resolveOrigin: () => {}, lanAddress: () => '127.0.0.1', ensure: (cb) => ready.push(cb),
    probeTracks: (_, cb) => { probes.push(cb); return () => disposals.push(cb); },
    cancelMkv: (...args) => retirements.push(args) };
  vm.createContext(ctx);
  const owner = source.slice(source.indexOf('  let mkvGeneration ='), source.indexOf('  function cancelMkv(why'));
  const serve = source.slice(source.indexOf('  function serveMkv('), source.indexOf('  // On-demand WebVTT for a sideloaded MKV-cast'));
  vm.runInContext(owner + serve + '\nthis.serve = serveMkv; this.cancel = cancelMkvPreparation;', ctx);
  return { ctx, ready, probes, results, disposals, retirements,
    serve: () => ctx.serve('/movie.mkv', {}, (url) => results.push(url)), cancel: ctx.cancel };
}
test('progressive cancellation before readiness allocates no probe', () => {
  const f = fixture(); f.serve(); f.cancel(); f.ready[0]();
  assert.deepEqual(f.results, [null]);
  assert.equal(f.probes.length, 0);
});
test('progressive cancellation during probing disposes and rejects late results', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.cancel(); f.probes[0]({});
  assert.deepEqual(f.results, [null]);
  assert.equal(f.disposals.length, 1);
  assert.equal(f.retirements.length, 0);
});
test('progressive replacement admits latest preparation without prematurely retiring live cast', () => {
  const f = fixture(); f.serve(); f.serve(); f.ready[0](); f.ready[1]();
  assert.deepEqual(f.results, [null]);
  assert.equal(f.probes.length, 1);
  assert.equal(f.retirements.length, 0);
  f.cancel();
});

test('progressive preparation retired during old cast cleanup cannot publish a new entry', () => {
  const f = fixture(); f.ctx.cancelMkv = () => f.cancel();
  f.serve(); f.ready[0]();
  f.ctx.newToken = () => 'controlled'; f.ctx.clog = () => {};
  assert.doesNotThrow(() => f.probes[0]({ audio: [], subs: [] }));
  assert.deepEqual(f.results, [null]); assert.equal(f.disposals.length, 1);
  assert.equal(f.ctx.mkvEntry, undefined);
});

test('direct-file MKV preparation cancellation retires admission and ignores fallback', () => {
  const f = fixture(), prepare = f.ctx.serve; let admission, disposed = 0;
  Object.assign(f.ctx, { newToken: () => 't', clog() {}, pickActiveSub: () => null, port: 1234, CAN_TONEMAP: false, MKV_CONTAINER: 'matroska',
    planPlayback: () => ({ video: 'copy', audioTracks: [] }), canSendOriginal: () => ({ ok: true }),
    serve: (_input, cb) => { admission = cb; return () => { disposed++; cb(null); }; } });
  prepare('/film.mp4', {}, value => f.results.push(value)); f.ready[0](); f.probes[0]({ audio: [], subs: [] });
  f.cancel(); admission('late-url'); admission(null);
  assert.deepEqual(f.results, [null]); assert.equal(disposed, 1); assert.equal(f.disposals.length, 1);
});
test('throwing probe disposal cannot prevent MKV cancellation result', () => {
  const f = fixture(); f.ctx.probeTracks = () => () => { throw Error('dispose'); };
  f.serve(); f.ready[0](); assert.doesNotThrow(f.cancel);
  assert.deepEqual(f.results, [null]);
});

test('duplicate readiness does not allocate another MKV probe', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.ready[0]();
  assert.equal(f.probes.length, 1); f.cancel();
});
test('duplicate probe completion cannot retire a published MKV cast', () => {
  const f = fixture();
  Object.assign(f.ctx, { newToken: () => 't', clog() {}, pickActiveSub: () => null, port: 1234, CAN_TONEMAP: false, MKV_CONTAINER: 'matroska', planPlayback: () => ({ video: 'copy', audioTracks: [] }), canSendOriginal: () => ({ ok: false, why: 'fixture' }) });
  f.serve(); f.ready[0](); const info = { audio: [], subs: [] };
  f.probes[0](info); const entry = f.ctx.mkvEntry;
  f.probes[0](info); f.ready[0]();
  assert.equal(f.retirements.length, 1); assert.equal(f.results.length, 1);
  assert.equal(f.ctx.mkvEntry, entry); assert.equal(f.probes.length, 1);
});

test('probe disposer returned after synchronous MKV cancellation is retired', () => {
  const f = fixture(); let disposed = 0;
  f.ctx.probeTracks = (_input, cb) => { f.cancel(); cb({ audio: [], subs: [] }); return () => disposed++; };
  f.serve(); f.ready[0]();
  assert.deepEqual(f.results, [null]); assert.equal(disposed, 1);
  assert.equal(f.retirements.length, 0);
});
