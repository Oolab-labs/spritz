'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/cast.js'), 'utf8');
function fixture(tracks = []) {
  const requests = [], ctx = { player: { media: { sessionRequest: message => requests.push(message) } }, lastTracks: tracks, lastStatus: { activeTrackIds: [1, 2] } };
  const start = source.indexOf('  function setTrack(kind, id)'); vm.createContext(ctx);
  vm.runInContext(source.slice(start, source.indexOf('  const withPlayer', start)), ctx);
  return { ctx, requests };
}
test('Cast track admission rejects malformed IDs and unknown kinds before receiver command', () => {
  const f = fixture();
  for (const id of [NaN, Infinity, 0.5, '1', -2]) f.ctx.setTrack('subs', id);
  f.ctx.setTrack('audio', -1); f.ctx.setTrack('unknown', 1);
  assert.equal(f.requests.length, 0);
  f.ctx.setTrack('subs', -1); f.ctx.setTrack('subs', 1000);
  assert.equal(f.requests.length, 2);
});
test('known Cast track lists reject stale or wrong-group IDs and preserve other selection', () => {
  const f = fixture([{ type: 'AUDIO', trackId: 1 }, { type: 'TEXT', trackId: 2 }, { type: 'TEXT', trackId: 3 }]);
  f.ctx.setTrack('subs', 1); f.ctx.setTrack('subs', 99); assert.equal(f.requests.length, 0);
  f.ctx.setTrack('subs', 3);
  assert.deepEqual(Array.from(f.requests[0].activeTrackIds), [1, 3]);
});
