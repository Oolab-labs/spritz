'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { presentTargets } = require('../src/main/receiver-presentation');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
test('source duration belongs to the epoch session and cannot leak across replacement', () => {
  const ctx = { vod: { dur: 7200, epochs: { get: id => id === 'epoch-A-1' ? {} : null } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function vodSourceDuration('), source.indexOf('  function vodEpoch(')) + '\nthis.duration = vodSourceDuration;', ctx);
  assert.equal(ctx.duration('epoch-A-1'), 7200);
  const list = [{ playback: { epoch: 'epoch-A-1', currentTime: 2, durationSec: 20 } }];
  assert.equal(presentTargets(list, () => 602, ctx.duration)[0].playback.durationSec, 7200);
  ctx.vod = { dur: 100, epochs: { get: id => id === 'epoch-B-1' ? {} : null } };
  assert.equal(ctx.duration('epoch-A-1'), null); assert.equal(ctx.duration('epoch-B-1'), 100);
  assert.equal(presentTargets(list, () => null, ctx.duration)[0].playback.durationSec, null);
  ctx.vod = null; assert.equal(ctx.duration('epoch-B-1'), null);
});
test('invalid source durations stay unknown rather than falling back to playlist length', () => {
  const list = [{ playback: { epoch: 'e', currentTime: 2, durationSec: 20 } }];
  for (const value of [null, 0, -1, NaN, Infinity, '100']) {
    assert.equal(presentTargets(list, () => 2, () => value)[0].playback.durationSec, null);
  }
});
