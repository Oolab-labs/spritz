'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const changed of [false, true]) {
  test(`queue picker ${changed ? 'rejects a superseded' : 'accepts its current'} result`, async () => {
    let click, finish;
    const ctx = { engine: 'mpv', clearErrorStop() {}, applyRouteHints() {}, sourceIntent: 1, playQueue: ['A'], closeMenus() {}, syncNavButtons() {}, renderPlaylistMenu() {},
      $: () => ({ addEventListener: (_, fn) => { click = fn; } }),
      soda: { dialog: { openFile: () => new Promise((resolve) => { finish = resolve; }) } } };
    vm.runInNewContext(source.slice(source.indexOf("$('#pl-add').addEventListener"), source.indexOf('// queue helpers')), ctx);
    const operation = click(); if (changed) ctx.sourceIntent++;
    finish({ filePaths: ['B'] }); await operation;
    assert.deepEqual(ctx.playQueue, changed ? ['A'] : ['A', 'B']);
  });
}

for (const changed of [false, true]) {
  test(`playlist parse ${changed ? 'rejects a superseded' : 'accepts its current'} selection`, async () => {
    let finish;
    const queues = [];
    const ctx = { engine: 'mpv', clearErrorStop() {}, applyRouteHints() {}, sourceIntent: 0, folderIntent: 0, st: {}, paintBuffered() {}, updateQuality() {},
      isPlaylistFile: () => true, enqueue: (items) => queues.push(items),
      soda: { parsePlaylist: () => new Promise((resolve) => { finish = resolve; }) } };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('function routeSource('), source.indexOf('soda.player.onNotice(')) + '\nthis.route = routeSource;', ctx);
    ctx.route('/playlist.m3u', false);
    if (changed) ctx.sourceIntent++;
    finish([{ url: 'A' }]); await Promise.resolve();
    assert.equal(queues.length, changed ? 0 : 1);
  });
}
