'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { trustPosition, effectiveState } = require('../src/main/resume-point');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf('    const believable = trustPosition(');
const code = source.slice(start, source.indexOf("    send('cast-event'", start));
for (const [state, cur, accepted] of [['PLAYING', 10, true], ['PAUSED', 10, true], ['BUFFERING', 10, false], ['IDLE', 10, false], ['PLAYING', Infinity, false], [undefined, 10, true]]) {
  test(`cast transport clock admission: ${state} at ${cur}`, () => {
    const positions = [];
    const ctx = { s: { playerState: state, currentTime: cur }, trustPosition, effectiveState, lastPlayerState: 'PLAYING', lastAvTime: 5, lastCastPos: 5, castMkv: { dur: 100 }, lan: { noteCastPosition: value => positions.push(value), castOrigin: () => 0 }, mpvLastUrl: '/film', playheadUpdate: () => null };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    assert.deepEqual(positions, accepted ? [cur] : []);
    assert.equal(ctx.lastCastPos, accepted ? cur : 5);
  });
}
