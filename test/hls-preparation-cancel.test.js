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
    onAirplayHlsGone() {}, cancelRemux() {}, clog() {}, whoCalled: () => 'test',
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

test('near timestamp failure disposes its candidate before admitting an origin retry', () => {
  const order = [], token = 'candidate';
  const ctx = { settled: false, hlsToken: token, tok: token, sourceAudio: { index: 1 }, mode: 'copy', inputStart: 55,
    hlsStartedAt: Date.now(), firstSegmentMs: 300, lastSegs: 1, lastProgressAt: Date.now(), tick: 1,
    preparationDiagnostics: { summarize: () => ({ category: 'timestamp-or-mux-error', stderr: 'redacted' }) },
    clog() {}, clearInterval() {}, cancel() { order.push('ordinary-cancel'); },
    cancelHls() { assert.equal(ctx.hlsPreparation, null); order.push('dispose'); },
    cb(url, subs, metadata) { assert.equal(url, null); assert.equal(metadata.retryFromOrigin, true); order.push('retry'); }
  };
  ctx.hlsPreparation = ctx.cancel;
  const start = source.indexOf('          const fail = (reason, code, signal) =>');
  vm.runInNewContext(source.slice(start, source.indexOf('          const tick =', start)) + '\nfail("no-segment-progress");', ctx);
  assert.deepEqual(order, ['dispose', 'retry']);
});
test('near source-read failures retain the existing cancellation behavior', () => {
  let cancelled = 0, retries = 0;
  const ctx = { settled: false, hlsToken: 'candidate', tok: 'candidate', sourceAudio: { index: 1 }, mode: 'copy', inputStart: 55,
    hlsStartedAt: Date.now(), firstSegmentMs: null, lastSegs: 0, lastProgressAt: Date.now(), tick: 1,
    preparationDiagnostics: { summarize: () => ({ category: 'source-read-error' }) },
    clog() {}, clearInterval() {}, cancel() { cancelled++; }, cb() { retries++; }
  };
  const start = source.indexOf('          const fail = (reason, code, signal) =>');
  vm.runInNewContext(source.slice(start, source.indexOf('          const tick =', start)) + '\nfail("no-segment-progress");', ctx);
  assert.equal(cancelled, 1); assert.equal(retries, 0);
});

test('fatal near mux output triggers immediate recovery only for the current preparing producer', () => {
  for (const state of ['current', 'superseded', 'settled', 'origin']) {
    let handler; const failures = [], ff = { stderr: { on(_, fn) { handler = fn; } } };
    const ctx = { ff, hlsProc: state === 'superseded' ? {} : ff, settled: state === 'settled', hlsToken: 'candidate', tok: 'candidate',
      inputStart: state === 'origin' ? 0 : 55, preparationDiagnostics: require('../src/main/subtitle-extraction-diagnostics').createDiagnostics(),
      fail: why => failures.push(why) };
    const start = source.indexOf("          ff.stderr.on('data', chunk => {", source.indexOf('const preparationDiagnostics'));
    vm.runInNewContext(source.slice(start, source.indexOf('          // A SUPERSEDED', start)), ctx);
    handler('Non-monotonic DTS; changing to 123'); assert.equal(failures.length, 0);
    handler('Error muxing a packet');
    assert.deepEqual(failures, state === 'current' ? ['mux-error'] : []);
  }
});
