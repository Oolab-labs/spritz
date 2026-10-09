'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
test('diagnostic owner reflects current intent without copying held media URL', () => {
  const ctx = { loadGen: 4, receiverIntent: 8, pendingReceiverOperation: { receiverId: 'new-tv' },
    receiverPlan: { receiverId: 'old-tv', mediaId: 'film', epoch: 'epoch-owned', autoplay: false, url: 'http://secret/token' },
    castEngine: 'mpv', runtimeIdentity: () => ({}), app: {}, lan: { lanAddress: () => null },
    cast: { discoveryState: () => ({ phase: 'idle' }) }, dlna: { discoveryState: () => ({ phase: 'idle' }) },
    diagCast: [], diagDlna: [], diagTorrent: null, mpvLastUrl: null, engineLog: [], diagErrors: [] };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function diagSnapshot()'), source.indexOf("  ipcMain.handle('diag:get'")) + '\nthis.snapshot = diagSnapshot;', ctx);
  const owner = ctx.snapshot().playbackOwner;
  assert.equal(owner.sourceGeneration, 4); assert.equal(owner.receiverIntent, 8);
  assert.equal(owner.pendingReceiver, 'new-tv'); assert.equal(owner.receiver.receiverId, 'old-tv');
  assert.equal(owner.receiver.autoplay, false); assert.equal(owner.receiver.epoch, 'epoch-owned');
  assert.equal(Object.hasOwn(owner.receiver, 'url'), false);
  ctx.loadGen++; ctx.receiverIntent++; ctx.pendingReceiverOperation = null; ctx.receiverPlan = null;
  const retired = ctx.snapshot().playbackOwner;
  assert.equal(retired.sourceGeneration, 5); assert.equal(retired.pendingReceiver, null); assert.equal(retired.receiver, null);
  assert.equal(owner.receiver.receiverId, 'old-tv');
});

test('diagnostic error records retain bounded occurrence ownership across replacement', () => {
  const ctx = { Date, loadGen: 1, receiverIntent: 2 };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  const diagErrors ='), source.indexOf('  let diagCast =')) + '\nthis.record = recordErr; this.errors = diagErrors;', ctx);
  ctx.record('producer', 'x'.repeat(400)); ctx.loadGen = 3; ctx.receiverIntent = 4;
  assert.equal(ctx.errors[0].sourceGeneration, 1); assert.equal(ctx.errors[0].receiverIntent, 2);
  assert.equal(ctx.errors[0].message.length, 200);
  for (let i = 0; i < 30; i++) ctx.record('new', String(i));
  assert.equal(ctx.errors.length, 25); assert.equal(ctx.errors[0].sourceGeneration, 3);
  assert.equal(ctx.errors.at(-1).receiverIntent, 4);
});
