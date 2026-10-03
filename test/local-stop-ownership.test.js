'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture() {
  const handlers = {}, callbacks = [], timers = new Map(), publications = [], cleanup = [];
  let casting = false, id = 0;
  const context = {
    cancelResolvers() {},
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    applyHttpHeaders() {}, applyStreamCache() {}, endCastsForNewSource() {},
    receiverPlan: null, externalSubs: [], lastAvTime: 0, mpvLastUrl: null, mainWindow: null,
    setCastable: (url) => publications.push(url),
    mpvAddon: { command() {} }, loadOpts: () => '',
    resolveCastable: (url, callback) => callbacks.push({ url, callback }),
    setTimeout: (fn) => { timers.set(++id, fn); return id; },
    clearTimeout: (key) => timers.delete(key),
    process: { env: {} }, console,
    isCasting: () => casting, castLog() {}, castEngine: 'dlna',
    lan: { cancelActive: () => cleanup.push('lan') },
    torrent: { cancel: () => cleanup.push('torrent') }
  };
  vm.createContext(context);
  const declarations = source.slice(source.indexOf('  let loadGen ='), source.indexOf('  // Default receiver profile'));
  const load = source.slice(source.indexOf("  ipcMain.on('player:load'"), source.indexOf('  // Defense-in-depth:'));
  const cancel = source.slice(source.indexOf("  ipcMain.on('torrent:cancel'"), source.indexOf('  // ---- dialogs / window / power'));
  vm.runInContext(declarations + load + cancel, context);
  return { context, handlers, callbacks, timers, publications, cleanup, casting: () => { casting = true; } };
}
const torrentUrl = 'http://127.0.0.1:1234/webtorrent/a/movie.mkv';
test('Stop rejects delayed resolution success and cancels scheduled retry', () => {
  const f = fixture();
  f.handlers['player:load'](null, { url: torrentUrl });
  f.callbacks[0].callback(null);
  assert.equal(f.timers.size, 1);
  f.handlers['torrent:cancel']();
  assert.equal(f.timers.size, 0);
  f.callbacks[0].callback('stale-url');
  assert.ok(!f.publications.includes('stale-url'));
  assert.deepEqual(f.cleanup, ['lan', 'torrent']);
});
test('A → Stop → B rejects A while allowing B to publish', () => {
  const f = fixture();
  f.handlers['player:load'](null, { url: torrentUrl });
  f.handlers['torrent:cancel']();
  f.handlers['player:load'](null, { url: '/B.mp4' });
  f.callbacks[0].callback('A-url');
  f.callbacks[1].callback('B-url');
  assert.ok(!f.publications.includes('A-url'));
  assert.equal(f.publications.at(-1), 'B-url');
});
test('home-screen torrent cancellation preserves TV-owned source and resolution', () => {
  const f = fixture();
  f.handlers['player:load'](null, { url: torrentUrl });
  f.casting();
  f.handlers['torrent:cancel']();
  f.callbacks[0].callback('TV-url');
  assert.deepEqual(f.cleanup, []);
  assert.equal(f.publications.at(-1), 'TV-url');
});

test('receiver ownership prevents delayed AirPlay publication and retry resurrection', () => {
  const f = fixture(); f.handlers['player:load'](null, { url: torrentUrl });
  f.callbacks[0].callback(null); assert.equal(f.timers.size, 1);
  f.context.receiverPlan = { src: torrentUrl };
  const retry = Array.from(f.timers.values())[0]; retry();
  assert.equal(f.callbacks.length, 1);
  f.callbacks[0].callback('stale-AirPlay');
  assert.equal(f.publications.includes('stale-AirPlay'), false);
});
