'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const ready = [], probes = [], starts = [], results = [], disposed = [];
  const ctx = {
    VOD_ENABLED: () => true, lanAddress: () => '127.0.0.1',
    ensure: (cb) => ready.push(cb), probeTracks: (input, cb) => { probes.push(cb); return () => disposed.push(input); },
    planPlayback: () => ({}), vodEligible: () => ({ ok: true }), CAN_TONEMAP: false,
    startVod: (...args) => { starts.push(args); return () => disposed.push('shape'); }, clog() {}, fs, console
  };
  vm.createContext(ctx);
  const ownership = source.slice(source.indexOf('  let vod = null;'), source.indexOf('  // Duration and keyframe times'));
  const admission = source.slice(source.indexOf('  function serveVod(input'), source.indexOf('  function startVod(input'));
  vm.runInContext(ownership + admission + '\nthis.serve = serveVod; this.cancel = cancelVod;', ctx);
  return { ctx, ready, probes, starts, results, disposed, serve: () => ctx.serve('/movie.mkv', {}, (...args) => results.push(args)), cancel: ctx.cancel };
}
test('cancel before server readiness settles once and allocates nothing', () => {
  const f = fixture(); f.serve(); f.cancel();
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0][1].outcome, 'cancelled');
  f.ready[0]();
  assert.equal(f.probes.length, 0);
  assert.equal(f.starts.length, 0);
  assert.equal(f.results.length, 1);
});
test('cancel during eligibility probe rejects late eligible completion', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.cancel();
  assert.deepEqual(f.disposed, ['/movie.mkv']);
  f.probes[0]({ vcodec: 'h264' });
  assert.equal(f.starts.length, 0);
  assert.equal(f.results.length, 1);
});
test('replacement settles old admission while allowing the new owner', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.serve(); f.ready[1]();
  f.probes[0]({}); f.probes[1]({});
  assert.equal(f.starts.length, 1);
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0][1].outcome, 'cancelled');
});

test('resolver distinguishes cancellation from decline and rejects superseded fallback', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const resolver = main.slice(main.indexOf('  function resolveCastable('), main.indexOf('  // Resolve the CHROMECAST'));
  const pending = [], fallbacks = [];
  const ctx = { loadGen: 1, AIRPLAY_4K: false, AIRPLAY_CAPS: {}, externalSubs: [],
    airplayCaps: (caps) => caps,
    lan: { serveVod: (_, __, cb) => pending.push(cb), serveHls: (input) => fallbacks.push(input) } };
  vm.createContext(ctx);
  vm.runInContext(resolver + '\nthis.resolve = resolveCastable;', ctx);
  ctx.resolve('/a.mkv', () => {});
  pending[0](null, { outcome: 'cancelled' });
  assert.equal(fallbacks.length, 0);
  ctx.resolve('/b.mkv', () => {});
  ctx.loadGen++;
  pending[1](null);
  assert.equal(fallbacks.length, 0);
  ctx.resolve('/c.mkv', () => {});
  pending[2](null);
  assert.deepEqual(fallbacks, ['/c.mkv']);
});

test('cancel after eligibility disposes the owned shape probe', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.probes[0]({});
  f.cancel();
  assert.ok(f.disposed.includes('shape'));
  assert.equal(f.results.length, 1);
});
test('owned admission disposer prevents allocation before readiness without cancelling a replacement', () => {
  const f = fixture(), dispose = f.serve(); dispose(); dispose();
  f.serve(); f.ready[0](); f.ready[1](); f.probes[0]({});
  assert.equal(f.results.length, 1); assert.equal(f.starts.length, 1);
});
test('reentrant probe disposal preserves cancelled outcome and prevents fallback-style decline', () => {
  const f = fixture();
  f.ctx.probeTracks = (_, cb) => () => cb(null);
  const dispose = f.serve(); f.ready[0](); dispose();
  assert.equal(f.results.length, 1); assert.equal(f.results[0][1].outcome, 'cancelled');
  assert.equal(f.starts.length, 0);
});
test('throwing completion cannot prevent cancellation of owned probe', () => {
  const f = fixture();
  const dispose = f.ctx.serve('/movie.mkv', {}, () => { throw new Error('caller failed'); });
  f.ready[0](); assert.doesNotThrow(dispose);
  assert.deepEqual(f.disposed, ['/movie.mkv']);
});
test('resolver disposer follows VOD decline into HLS and rejects duplicate/late callbacks', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  let vodCallback, hlsCallback, starts = 0, hlsDisposed = 0; const results = [];
  const ctx = { loadGen: 1, AIRPLAY_4K: false, AIRPLAY_CAPS: {}, externalSubs: [], airplayCaps: c => c,
    lan: {
      serveVod: (_, __, cb) => { vodCallback = cb; return () => cb(null, { outcome: 'cancelled' }); },
      serveHls: (_, cb) => { starts++; hlsCallback = cb; return () => { hlsDisposed++; cb(null); }; }
    } };
  vm.createContext(ctx);
  vm.runInContext(main.slice(main.indexOf('  function resolveCastable('), main.indexOf('  // Resolve the CHROMECAST')) + '\nthis.resolve = resolveCastable;', ctx);
  const dispose = ctx.resolve('/film.mkv', url => results.push(url));
  vodCallback(null); vodCallback(null);
  assert.equal(starts, 1);
  dispose(); dispose(); hlsCallback('http://late');
  assert.equal(hlsDisposed, 1); assert.deepEqual(results, []);
});
