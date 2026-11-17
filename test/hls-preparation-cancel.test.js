'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const ready = [], probes = [], results = [], directories = [], disposals = [];
  const ctx = { hlsGeneration: 0, hlsPreparation: null, hlsToken: null, hlsProc: null,
    hlsDir: null, hlsRoot: '/owned', hlsStartedAt: 0, hlsAnnounced: false,
    subProcs: [], hlsWatch: null, hlsWarned: false, hlsSubTasks: new Map(), receiverSubtitles: null, startSubExtract() {},
    path, fs: { mkdirSync: (dir) => directories.push(dir), rmSync() {} },
    onAirplayHlsGone() {}, clog() {}, whoCalled: () => 'test',
    lanAddress: () => '127.0.0.1', newToken: () => String(directories.length),
    ensure: (cb) => ready.push(cb),
    probeTracks: (_, cb) => { probes.push(cb); return () => disposals.push(cb); }
  };
  vm.createContext(ctx);
  const cancel = source.slice(source.indexOf('  function cancelHls()'), source.indexOf('  // Pause the AirPlay preparation'));
  const serve = source.slice(source.indexOf('  function serveHls('), source.indexOf('  // ---- Chromecast transport:'));
  vm.runInContext(cancel + serve + '\nthis.serve = serveHls; this.cancel = cancelHls;', ctx);
  return { ctx, ready, probes, results, directories, disposals,
    serve: () => ctx.serve('/movie.mkv', (url) => results.push(url)), cancel: ctx.cancel };
}
test('HLS cancellation disposes its owned producer exactly once', () => {
  const f = fixture(), calls = [];
  f.ctx.hlsProducer = { dispose: () => calls.push('dispose') };
  f.cancel(); f.cancel();
  assert.deepEqual(calls, ['dispose']);
});
test('HLS Stop before server readiness creates no session or probe', () => {
  const f = fixture(); f.serve(); f.cancel(); f.ready[0]();
  assert.deepEqual(f.results, [null]);
  assert.equal(f.directories.length, 0);
  assert.equal(f.probes.length, 0);
});
test('HLS Stop during probing disposes the probe and rejects late completion', () => {
  const f = fixture(); f.serve(); f.ready[0](); f.cancel(); f.probes[0]({});
  assert.equal(f.disposals.length, 1);
  assert.deepEqual(f.results, [null]);
});
test('HLS replacement before readiness admits only the latest owner', () => {
  const f = fixture(); f.serve(); f.serve(); f.ready[0](); f.ready[1]();
  assert.equal(f.directories.length, 1);
  assert.equal(f.probes.length, 1);
  assert.deepEqual(f.results, [null]);
  f.cancel();
});
test('owned HLS cancellation before readiness cannot admit or cancel its replacement', () => {
  const f = fixture(), dispose = f.serve(); dispose(); dispose();
  f.serve(); f.ready[0](); f.ready[1](); dispose();
  assert.equal(f.directories.length, 1); assert.equal(f.probes.length, 1);
  assert.deepEqual(f.results, [null]); f.cancel();
});
test('owned HLS cancellation during probing disposes only the pending probe', () => {
  const f = fixture(), dispose = f.serve(); f.ready[0](); dispose();
  f.probes[0]({});
  assert.equal(f.disposals.length, 1); assert.deepEqual(f.results, [null]);
});
