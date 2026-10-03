'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const change of ['source', 'target']) {
  test(`old idle timer cannot hide controls after ${change} replacement`, () => {
    const classes = new Set(), timers = []; let sourceId = 0, targetId = 0;
    const list = { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) };
    const ctx = { controls: { classList: list }, torrentStatus: { classList: list }, document: { body: { style: {} } },
      st: { paused: false, loaded: true }, engine: 'mpv', refreshAir() {}, clearTimeout() {},
      setTimeout: cb => { timers.push(cb); return timers.length; },
      subtitleOwner: () => ({ source: sourceId, target: targetId }),
      ownsSubtitle: o => o.source === sourceId && o.target === targetId };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('let idleTimer ='), source.indexOf("document.addEventListener('mousemove', armIdle)")) + '\nthis.arm = armIdle;', ctx);
    ctx.arm(); if (change === 'source') sourceId++; else targetId++;
    timers[0](); assert.equal(classes.has('idle'), false);
    ctx.arm(); timers[1](); assert.equal(classes.has('idle'), true);
  });
}
