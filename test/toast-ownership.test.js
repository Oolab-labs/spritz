'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const change of ['source', 'message']) {
  test(`toast expiry preserves replacement ${change}`, () => {
    let sourceId = 0; const timers = [], classes = new Set();
    const status = { textContent: '', classList: { remove: () => classes.delete('hidden'), add: c => classes.add(c) } };
    const ctx = { torrentStatus: status, sponsorToastT: null, clearTimeout() {}, setTimeout: cb => timers.push(cb),
      subtitleOwner: () => ({ source: sourceId }), ownsSubtitle: o => o.source === sourceId };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('function toast('), source.indexOf('function showSponsorToast')) + '\nthis.toast = toast;', ctx);
    ctx.toast('old'); if (change === 'source') sourceId++; else status.textContent = 'downloading';
    timers[0](); assert.equal(classes.has('hidden'), false);
    ctx.toast('fresh'); timers[1](); assert.equal(classes.has('hidden'), true);
  });
}
