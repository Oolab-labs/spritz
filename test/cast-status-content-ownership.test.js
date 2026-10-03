'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/cast.js'), 'utf8');
test('reused Cast player rejects explicitly stale content while retaining partial status', () => {
  const p = new EventEmitter(), events = [], tracks = [];
  const ctx = { p, player: p, castGen: 1, activeContentId: 'new', lastErrCode: null, lastStatus: null, endedEmitted: false, noteTracks: s => tracks.push(s), ev: { emit: (...args) => events.push(args) } };
  const start = source.indexOf("        p.on('status', (s) => {");
  vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('        sendLoad(p);', start)), ctx);
  p.emit('status', { media: { contentId: 'old' }, playerState: 'IDLE', idleReason: 'FINISHED', detailedErrorCode: 104 });
  assert.equal(events.length, 0); assert.equal(tracks.length, 0); assert.equal(ctx.lastErrCode, null);
  p.emit('status', { media: { contentId: 'new' }, playerState: 'PLAYING' });
  p.emit('status', { currentTime: 10 });
  assert.equal(events.length, 2); assert.equal(tracks.length, 2);
  p.emit('status', { media: { contentId: 'new' }, playerState: 'IDLE', idleReason: 'FINISHED' });
  assert.equal(events.at(-1)[0], 'ended');
});

test('Cast teardown detaches old ownership before reentrant close admits replacement', () => {
  const replacement = { player: {}, client: {}, status: { currentTime: 3 }, tracks: [{}] };
  let playerDetached = 0, clientDetached = 0;
  const ctx = { stopStatusPoll() {}, player: { removeAllListeners: () => playerDetached++ }, client: { removeAllListeners: () => clientDetached++, close: () => {
    assert.equal(ctx.player, null); assert.equal(ctx.client, null);
    ctx.player = replacement.player; ctx.client = replacement.client; ctx.connectedHost = 'new';
    ctx.lastStatus = replacement.status; ctx.lastTracks = replacement.tracks; ctx.activeContentId = 'new-url';
  } }, connectedHost: 'old', lastStatus: {}, lastTracks: [{}], activeContentId: 'old-url' };
  const start = source.indexOf('  function teardownClient()');
  vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('  // load(host', start)), ctx);
  ctx.teardownClient();
  assert.equal(playerDetached, 1); assert.equal(clientDetached, 1);
  assert.equal(ctx.player, replacement.player); assert.equal(ctx.client, replacement.client);
  assert.equal(ctx.lastStatus, replacement.status); assert.equal(ctx.lastTracks, replacement.tracks);
  assert.equal(ctx.activeContentId, 'new-url'); assert.equal(ctx.connectedHost, 'new');
});

for (const replacementDuringCleanup of [false, true]) {
  test(`Cast connect admission rechecks generation after cleanup: ${replacementDuringCleanup}`, () => {
    let admitted = 0, cleaned = 0;
    const ctx = { myGen: 1, castGen: 1, teardownClient: () => { cleaned++; if (replacementDuringCleanup) ctx.castGen++; }, admitted: () => admitted++ };
    const start = source.indexOf('    function fullConnect() {');
    vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('    const { Client }', start)) + 'admitted(); }', ctx);
    ctx.fullConnect(); assert.equal(cleaned, 1); assert.equal(admitted, replacementDuringCleanup ? 0 : 1);
  });
}

for (const replaceAt of ['cleanup', 'error', 'none']) {
  test(`Cast connection failure isolates replacement during ${replaceAt}`, () => {
    let cleaned = 0, reported = 0, completed = 0;
    const ctx = { myGen: 1, castGen: 1, teardownClient: () => { cleaned++; if (replaceAt === 'cleanup') ctx.castGen++; }, ev: { emit: () => { reported++; if (replaceAt === 'error') ctx.castGen++; } }, done: () => completed++ };
    const start = source.indexOf('    function failConnection(error)');
    vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('    function fullConnect()', start)), ctx);
    ctx.failConnection(Error('failed'));
    assert.equal(cleaned, 1); assert.equal(reported, replaceAt === 'cleanup' ? 0 : 1);
    assert.equal(completed, replaceAt === 'none' ? 1 : 0);
  });
}

test('Cast status listener replacement suppresses old FINISHED even on reused player', () => {
  const p = new EventEmitter(), events = [];
  const ctx = { p, player: p, castGen: 1, activeContentId: 'old', lastErrCode: null, lastStatus: null, endedEmitted: false, noteTracks() {}, ev: { emit: (name) => {
    events.push(name); if (name === 'status') { ctx.castGen++; ctx.activeContentId = 'new'; ctx.endedEmitted = false; }
  } } };
  const start = source.indexOf("        p.on('status', (s) => {");
  vm.createContext(ctx); vm.runInContext(source.slice(start, source.indexOf('        sendLoad(p);', start)), ctx);
  p.emit('status', { media: { contentId: 'old' }, playerState: 'IDLE', idleReason: 'FINISHED' });
  assert.deepEqual(events, ['status']); assert.equal(ctx.endedEmitted, false);
});
