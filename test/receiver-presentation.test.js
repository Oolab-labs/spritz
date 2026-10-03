'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { presentTargets } = require('../src/main/receiver-presentation');
test('list refresh uses film clock without mutating adoption state or presenting epoch duration as film length', () => {
  const list = [{ id: 'lg', playback: { epoch: 'e1', currentTime: 2, durationSec: 20 } }];
  const before = JSON.stringify(list);
  for (let i = 0; i < 3; i++) {
    const view = presentTargets(list, (epoch, time) => epoch === 'e1' ? 600 + time : null);
    assert.equal(view[0].playback.currentTime, 602); assert.equal(view[0].playback.epochLocal, 2);
    assert.equal(view[0].playback.durationSec, null); assert.equal(view[0].playback.epochDurationSec, 20);
  }
  assert.equal(JSON.stringify(list), before);
});
test('unknown mappings hide local clock; valid converted zero survives', () => {
  const list = [{ playback: { epoch: 'e', currentTime: 2 } }];
  for (const value of [null, undefined, NaN, -1, Infinity]) assert.equal(presentTargets(list, () => value)[0].playback.currentTime, null);
  assert.equal(presentTargets(list, () => 0)[0].playback.currentTime, 0);
});
test('direct, offline and other receivers retain independent presentation', () => {
  const direct = { id: 'direct', playback: { epoch: null, currentTime: 0, durationSec: 100 } }, offline = { id: 'offline', playback: null };
  const list = [direct, offline, { id: 'unknown', playback: { epoch: 'other', currentTime: 10 } }];
  const view = presentTargets(list, () => null);
  assert.equal(view[0], direct); assert.equal(view[1], offline); assert.equal(view[2].playback.currentTime, null);
});
