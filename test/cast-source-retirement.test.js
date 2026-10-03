'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
test('new player source retires prior cast clock, state, and pending observation', () => {
  let handler;
  const ctx = { ipcMain: { on: (_name, cb) => { handler = cb; } }, invalidateLoad: () => 2, applyHttpHeaders() {}, applyStreamCache() {}, endCastsForNewSource() {}, externalSubs: ['old'], lastAvTime: 45, lastCastPos: 60, lastPlayerState: 'PLAYING', pendingObservation: { title: 'old' } };
  const start = source.indexOf("  ipcMain.on('player:load'");
  vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('    setCastable(null);', start)) + '\n  });', ctx);
  handler(null, { url: '/new' });
  assert.equal(ctx.lastAvTime, 0); assert.equal(ctx.lastCastPos, 0);
  assert.equal(ctx.lastPlayerState, null); assert.equal(ctx.pendingObservation, null);
  assert.equal(ctx.externalSubs.length, 0);
});
