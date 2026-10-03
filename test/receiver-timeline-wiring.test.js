'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { presentTargets } = require('../src/main/receiver-presentation');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  let deliver; const handlers = {}, ipc = {}, shown = [];
  const view = { window: { soda: true }, soda: { receiver: { onEvent: cb => { deliver = cb; } } },
    receiverTargetRevision: 0, receiverPairingRevision: 0, receiverTargets: [], renderReceivers: () => shown.push(view.receiverTargets[0]?.playback?.currentTime),
    renderHomeDevices() {}, refreshCast() {} };
  vm.createContext(view);
  vm.runInContext(renderer.slice(renderer.indexOf('async function initReceivers()'), renderer.indexOf("  wirePairForm('receiver-pair-go'")) +
    '\n}\nthis.init = initReceivers;', view);
  view.init();
  const raw = [{ id: 'lg', playback: { epoch: 'e1', currentTime: 2, durationSec: 20 } }];
  const ctx = { presentTargets, lan: { vodLogical: (epoch, t) => epoch === 'e1' ? 600 + t : null },
    receivers: { on: (type, cb) => { handlers[type] = cb; } },
    ipcMain: { handle: (type, cb) => { ipc[type] = cb; } }, startReceivers: () => ({ targets: () => raw }),
    send: (_, event) => deliver(event) };
  ctx.receiverTimelineTransport = () => ctx.lan;
  vm.createContext(ctx);
  const targetStart = main.indexOf("    receivers.on('targets'");
  vm.runInContext(main.slice(targetStart, main.indexOf("    receivers.on('pairing'", targetStart)) +
    main.slice(main.indexOf("    receivers.on('position'"), main.indexOf("    receivers.on('playback-error'")) +
    main.slice(main.indexOf("  ipcMain.handle('receiver:list'"), main.indexOf("  ipcMain.handle('receiver:pending'")), ctx);
  return { raw, view, handlers, ipc, shown };
}
test('production list/position wiring preserves film clock through renderer refreshes', () => {
  const f = fixture();
  f.handlers.targets(f.raw);
  assert.equal(f.view.receiverTargets[0].playback.currentTime, 602);
  f.handlers.position({ receiverId: 'lg', epoch: 'e1', currentTime: 3 });
  assert.equal(f.view.receiverTargets[0].playback.currentTime, 603);
  f.raw[0].playback.currentTime = 3; f.handlers.targets(f.raw);
  assert.equal(f.view.receiverTargets[0].playback.currentTime, 603);
  assert.equal(f.ipc['receiver:list']()[0].playback.currentTime, 603);
  assert.equal(f.raw[0].playback.currentTime, 3);
  assert.deepEqual(f.shown, [602, 603, 603]);
});
test('unknown epoch target refresh hides clock and late position cannot expose local time', () => {
  const f = fixture(); f.raw[0].playback.epoch = 'retired';
  f.handlers.targets(f.raw); f.handlers.position({ receiverId: 'lg', epoch: 'retired', currentTime: 2 });
  assert.equal(f.view.receiverTargets[0].playback.currentTime, null);
  assert.equal(f.ipc['receiver:list']()[0].playback.currentTime, null);
});
