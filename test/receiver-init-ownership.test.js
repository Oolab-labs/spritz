'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  let event, pending; const lists = [];
  const ctx = { window: { soda: true }, receiverTargets: [], receiverPending: [],
    wirePairForm() {}, renderReceivers() {}, renderHomeDevices() {}, refreshCast() {},
    soda: { receiver: { onEvent: fn => { event = fn; },
      list: () => new Promise(resolve => { lists.push(resolve); }),
      pending: () => new Promise(resolve => { pending = resolve; }) } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let receiverTargetRevision'), source.indexOf('function renderReceivers()')) + source.slice(source.indexOf('async function initReceivers()'), source.indexOf('// One pairing form')) + '\nthis.init = initReceivers; this.refresh = refreshReceiverState;', ctx);
  return { ctx, event: value => event(value), list: (value, index = lists.length - 1) => lists[index](value), pending: value => pending(value) };
}
test('initial receiver lookup cannot overwrite newer target and pairing events', async () => {
  const f = fixture(), started = f.ctx.init();
  const latest = [{ id: 'new', playback: { currentTime: 602 } }], pairing = [{ receiverId: 'new' }];
  f.event({ type: 'targets', targets: latest }); f.event({ type: 'pairing', pending: pairing });
  f.list([{ id: 'old' }]); await new Promise(setImmediate); f.pending([]); await started;
  assert.equal(f.ctx.receiverTargets, latest); assert.equal(f.ctx.receiverPending, pairing);
});
test('fresh initialization results still populate target and pairing state', async () => {
  const f = fixture(), started = f.ctx.init(), targets = [{ id: 'current' }], pending = [{ receiverId: 'current' }];
  f.list(targets); await new Promise(setImmediate); f.pending(pending); await started;
  assert.equal(f.ctx.receiverTargets, targets); assert.equal(f.ctx.receiverPending, pending);
});
test('newer refresh wins when older list completes last', async () => {
  const f = fixture(), old = f.ctx.refresh(false), next = f.ctx.refresh(false), latest = [{ id: 'new' }];
  f.list(latest, 1); await next;
  f.list([{ id: 'old' }], 0); await old;
  assert.equal(f.ctx.receiverTargets, latest);
});
test('new position event beats a pending later refresh', async () => {
  const f = fixture(), initialized = f.ctx.init();
  f.list([{ id: 'lg', playback: { currentTime: 602 } }]); await new Promise(setImmediate);
  f.pending([]); await initialized;
  const refresh = f.ctx.refresh(false);
  f.event({ type: 'position', position: { receiverId: 'lg', currentTime: 603 } });
  f.list([{ id: 'lg', playback: { currentTime: 602 } }]); await refresh;
  assert.equal(f.ctx.receiverTargets[0].playback.currentTime, 603);
});
test('renderer rejects positions naming retired media or epoch after target replacement', async () => {
  const f = fixture(), initialized = f.ctx.init();
  f.list([{ id: 'lg', playback: { mediaId: 'B', epoch: 'eB', currentTime: 602 } }]);
  await new Promise(setImmediate); f.pending([]); await initialized;
  for (const position of [
    { mediaId: 'A', epoch: 'eB', currentTime: 999 },
    { mediaId: 'B', epoch: 'eA', currentTime: 999 },
    { mediaId: 'B', epoch: 'eB', currentTime: undefined }
  ]) f.event({ type: 'position', position: { receiverId: 'lg', ...position } });
  assert.equal(f.ctx.receiverTargets[0].playback.currentTime, 602);
  f.event({ type: 'position', position: { receiverId: 'lg', mediaId: 'B', epoch: 'eB', currentTime: 603 } });
  assert.equal(f.ctx.receiverTargets[0].playback.currentTime, 603);
});

test('retired receiver error cannot toast over a replacement while cleared fatal state remains reportable', async () => {
  const f = fixture(), messages = []; f.ctx.toast = message => messages.push(message);
  const initialized = f.ctx.init();
  f.event({ type: 'targets', targets: [{ id: 'lg', playback: { mediaId: 'B', epoch: 'e2' } }] });
  f.event({ type: 'error', error: { receiverId: 'lg', mediaId: 'A', epoch: 'e1', fatal: true } });
  f.event({ type: 'error', error: { receiverId: 'lg', mediaId: 'B', epoch: 'e1', fatal: true } });
  assert.equal(messages.length, 0);
  f.event({ type: 'targets', targets: [{ id: 'lg', playback: { mediaId: null, epoch: null } }] });
  f.event({ type: 'error', error: { receiverId: 'lg', mediaId: 'B', epoch: 'e2', fatal: true, message: 'decode' } });
  assert.equal(messages.length, 1);
  f.list([]); await new Promise(setImmediate); f.pending([]); await initialized;
});
