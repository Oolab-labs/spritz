'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/cast.js'), 'utf8');
function fixture(supersede) {
  let callback, completed = 0, emitted = 0; const timers = [];
  const ctx = { media: { url: 'new' }, activeContentId: null, endedEmitted: true, lastErrCode: null, myGen: 1, castGen: 1, mediaInfo: () => ({}), hls: false, lastStatus: { currentTime: 900, activeTrackIds: [7] }, lastTracks: [{ trackId: 7 }], noteTracks() {}, reconnectTries: 1, setTimeout: fn => timers.push(fn), done: () => completed++, ev: { emit: () => { emitted++; if (supersede) ctx.castGen++; } } };
  const start = source.indexOf('    const sendLoad =');
  vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('    // FAST PATH', start)) + '\nthis.run = sendLoad;', ctx);
  ctx.run({ load: (_media, _opts, cb) => { callback = cb; } });
  return { ctx, callback: (...args) => callback(...args), timers, counts: () => ({ completed, emitted }) };
}
for (const failure of [false, true]) {
  test(`Cast LOAD ${failure ? 'error' : 'status'} listener supersession suppresses stale completion`, () => {
    const f = fixture(true); f.callback(failure ? Error('failed') : null, failure ? null : { currentTime: 1 });
    if (failure) f.timers[0]();
    assert.deepEqual(f.counts(), { completed: 0, emitted: 1 });
  });
}
test('duplicate Cast LOAD callbacks emit and settle once', () => {
  const f = fixture(false); f.callback(null, { currentTime: 1 }); f.callback(null, { currentTime: 2 });
  assert.deepEqual(f.counts(), { completed: 1, emitted: 1 });
});

test('new Cast LOAD clears previous item track and position caches before completion', () => {
  const f = fixture(false);
  assert.equal(f.ctx.lastStatus, null); assert.equal(f.ctx.lastTracks.length, 0);
  assert.equal(f.ctx.activeContentId, 'new');
  f.callback(null, { currentTime: 3 }); assert.equal(f.ctx.lastStatus.currentTime, 3);
});
