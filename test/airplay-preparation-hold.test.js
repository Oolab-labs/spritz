'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const signals = [];
  const ctx = { hlsAnnounced: true, hlsToken: 'a', hlsGeneration: 1,
    hlsProc: { pid: 1 }, subProcs: [{ pid: 2 }], clog() {},
    process: { kill: (pid, signal) => signals.push([pid, signal]) } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function holdReadyAirplayPrep('), source.indexOf('  // The HLS remux runs faster')) + '\nthis.hold = holdReadyAirplayPrep;', ctx);
  return { ctx, signals };
}
test('ready preparation hold resumes its owned children exactly once', () => {
  const f = fixture(), release = f.ctx.hold();
  assert.deepEqual(f.signals, [[1, 'SIGSTOP'], [2, 'SIGSTOP']]);
  release(); release();
  assert.deepEqual(f.signals.slice(2), [[1, 'SIGCONT'], [2, 'SIGCONT']]);
});
test('unannounced preparation is never held under its startup watchdog', () => {
  const f = fixture(); f.ctx.hlsAnnounced = false;
  assert.equal(f.ctx.hold(), null); assert.deepEqual(f.signals, []);
});
test('release cannot signal a replacement generation or retired child', () => {
  for (const change of ['generation', 'token', 'children']) {
    const f = fixture(), release = f.ctx.hold();
    if (change === 'generation') f.ctx.hlsGeneration++;
    if (change === 'token') f.ctx.hlsToken = 'b';
    if (change === 'children') { f.ctx.hlsProc = { pid: 3 }; f.ctx.subProcs = []; }
    release(); assert.equal(f.signals.length, 2);
  }
});
test('alternate playback ownership leaves held work suspended', () => {
  const f = fixture(), release = f.ctx.hold(); release(false); release();
  assert.equal(f.signals.length, 2);
});
test('release does not signal exited subtitle children retained in the list', () => {
  const f = fixture(), release = f.ctx.hold();
  f.ctx.subProcs[0].exitCode = 0; release();
  assert.deepEqual(f.signals.slice(2), [[1, 'SIGCONT']]);
});
