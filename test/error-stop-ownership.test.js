'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const timers = new Map(); let id = 0, stopped = 0;
  const ctx = { playbackTargetIntent: 0, stop: () => stopped++,
    setTimeout: (fn) => { timers.set(++id, fn); return id; }, clearTimeout: (key) => timers.delete(key) };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let sourceIntent ='), source.indexOf('let detachedQueueSource =')) + '\nthis.schedule = scheduleErrorStop; this.clear = clearErrorStop; this.changeSource = () => ++sourceIntent;', ctx);
  return { ctx, timers, stopped: () => stopped };
}
for (const change of ['none', 'source', 'target']) {
  test(`delayed error Stop respects ${change} ownership`, () => {
    const f = fixture(); f.ctx.schedule(2400); const timer = [...f.timers.values()][0];
    if (change === 'source') f.ctx.changeSource();
    if (change === 'target') f.ctx.playbackTargetIntent++;
    timer(); assert.equal(f.stopped(), change === 'none' ? 1 : 0);
  });
}
test('new error replaces the old Stop timer and explicit cleanup drains it', () => {
  const f = fixture(); f.ctx.schedule(2400); f.ctx.schedule(1800);
  assert.equal(f.timers.size, 1); f.ctx.clear(); assert.equal(f.timers.size, 0);
});

for (const changed of [false, true]) {
  test(`VPN admission ${changed ? 'rejects stale' : 'accepts current'} source intent`, async () => {
    let finish;
    const started = [];
    const ctx = { engine: 'mpv', sourceIntent: 0, folderIntent: 0, clearErrorStop() {}, applyRouteHints() {}, st: {},
      paintBuffered() {}, updateQuality() {}, isPlaylistFile: () => false, isTorrentSrc: () => true,
      settings: { requireVpn: true }, titleFromSrc: () => 'movie', playerTitle: {}, hideResume() {}, syncNavButtons() {},
      youtubeId: () => null, skipSponsors: false, startTorrent: (src) => started.push(src), toast() {},
      soda: { vpnStatus: () => new Promise((resolve) => { finish = resolve; }) } };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('function routeSource('), source.indexOf('soda.player.onNotice(')) + '\nthis.route = routeSource;', ctx);
    ctx.route('magnet:?xt=A', false); if (changed) ctx.sourceIntent++;
    finish({ active: true }); await Promise.resolve();
    assert.deepEqual(started, changed ? [] : ['magnet:?xt=A']);
  });
}

test('an already queued retired error timer cannot stop playback or clear the new timer', () => {
  const f = fixture(); f.ctx.schedule(2400); const old = [...f.timers.values()][0];
  f.ctx.schedule(1800); old(); assert.equal(f.stopped(), 0);
  f.ctx.clear(); assert.equal(f.timers.size, 0);
});
