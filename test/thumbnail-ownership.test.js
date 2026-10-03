'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const change of ['source', 'leave']) {
  test(`thumbnail response is rejected after ${change}`, async () => {
    const events = {}, timers = []; let sourceId = 0, resolve;
    const img = { src: 'initial', style: {} }, element = { style: {}, classList: { add() {}, remove() {} } };
    const ctx = { $: id => id === '#thumb-img' ? img : element,
      seek: { addEventListener: (event, cb) => { events[event] = cb; }, getBoundingClientRect: () => ({ left: 0, width: 100 }) },
      st: { loaded: true, duration: 100 }, engine: 'mpv', currentLocalPath: '/old', toPlayerTime: () => '50',
      clearTimeout() {}, setTimeout: cb => timers.push(cb), subtitleOwner: () => ({ source: sourceId }),
      ownsSubtitle: o => o.source === sourceId, soda: { thumbAt: () => new Promise(r => { resolve = r; }) } };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('const thumbPreview ='), source.indexOf("seek.addEventListener('mousedown'", source.indexOf('const thumbPreview ='))), ctx);
    events.mousemove({ clientX: 50 }); const pending = timers[0]();
    if (change === 'source') { sourceId++; ctx.currentLocalPath = '/new'; } else events.mouseleave();
    resolve('old-image'); await pending; assert.equal(img.src, 'initial');
  });
}
