'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { presentTargets } = require('../src/main/receiver-presentation');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture(logical, duration) {
  let position; const sent = [];
  const ctx = { presentTargets, receivers: { on: (_, cb) => { position = cb; } },
    lan: { vodLogical: logical, vodSourceDuration: duration }, send: (_, event) => sent.push(event) };
  ctx.receiverTimelineTransport = () => ctx.lan;
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf("    receivers.on('position'"), source.indexOf("    receivers.on('playback-error'")), ctx);
  return { ctx, position: p => position(p), sent };
}
test('unknown/invalid epoch conversion cannot publish epoch-local film time', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '50']) {
    const f = fixture(() => value); f.position({ epoch: 'unknown', currentTime: 2 });
    assert.equal(f.sent.length, 0);
  }
  const f = fixture(undefined); f.position({ epoch: 'unknown', currentTime: 2 }); assert.equal(f.sent.length, 0);
});
test('known epoch publishes converted film time including zero with the raw reading beside it', () => {
  for (const logical of [0, 602]) {
    const f = fixture(() => logical); f.position({ receiverId: 'lg', epoch: 'e1', currentTime: 2 });
    assert.equal(f.sent[0].position.currentTime, logical); assert.equal(f.sent[0].position.epochLocal, 2);
  }
});
test('partial and invalid clocks do not publish a timeline update; direct clocks remain valid', () => {
  const f = fixture(() => { throw new Error('must not convert'); });
  for (const currentTime of [undefined, null, NaN, -1, '2']) f.position({ epoch: 'e1', currentTime });
  assert.equal(f.sent.length, 0);
  f.position({ currentTime: 0 }); assert.equal(f.sent[0].position.currentTime, 0);
});
test('epoch position duration uses owned source length and preserves playlist observation', () => {
  const f = fixture(() => 602, epoch => epoch === 'owned' ? 7200 : null);
  const raw = { receiverId: 'lg', epoch: 'owned', currentTime: 2, durationSec: 20 };
  f.position(raw);
  assert.equal(f.sent[0].position.durationSec, 7200);
  assert.equal(f.sent[0].position.epochDurationSec, 20);
  assert.equal(raw.durationSec, 20); assert.equal(raw.currentTime, 2);
});
test('unknown source duration never publishes epoch length as film duration', () => {
  const f = fixture(() => 602, () => null);
  f.position({ epoch: 'owned', currentTime: 2, durationSec: 20 });
  assert.equal(f.sent[0].position.durationSec, null);
  assert.equal(f.sent[0].position.epochDurationSec, 20);
});

test('audio replacement cannot retire the previous stream on a wrong or in-flight clock', () => {
  const f = fixture();
  let retired = 0;
  f.ctx.clearTimeout = () => {};
  f.ctx.pendingReceiverOperation = null;
  f.ctx.receiverPlan = { receiverId: 'lg', mediaId: 'new', position: 23.3, audioStartPosition: 23.3,
    previous: {}, retirePrevious: () => retired++ };
  const p = { receiverId: 'lg', mediaId: 'new', paused: false, currentTime: 8.1 };
  f.position(p);
  assert.equal(retired, 0); assert.equal(f.ctx.receiverPlan.position, 23.3);
  f.position({ ...p, currentTime: 20.1, seeking: false });
  assert.equal(retired, 0, 'nearby live edge is not the requested arrival');
  f.position({ ...p, currentTime: 23.3, seeking: true });
  assert.equal(retired, 0);
  f.position({ ...p, currentTime: 23.6, seeking: false });
  assert.equal(retired, 1); assert.equal(f.ctx.receiverPlan.previous, null);
});
test('explicit TV seek during audio replacement becomes the new arrival target', () => {
  const f = fixture(); let retired = 0;
  f.ctx.clearTimeout = () => {}; f.ctx.pendingReceiverOperation = null;
  f.ctx.receiverPlan = { receiverId: 'lg', mediaId: 'new', position: 23.3, audioStartPosition: 23.3,
    previous: {}, retirePrevious: () => retired++ };
  f.position({ receiverId: 'lg', mediaId: 'new', paused: true, currentTime: 60, requestedTime: 60, seeking: false });
  assert.equal(retired, 1); assert.equal(f.ctx.receiverPlan.position, 60);
});
