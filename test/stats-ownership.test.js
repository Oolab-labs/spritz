'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const change of ['source', 'visibility', 'newer']) {
  test(`stats reject stale response after ${change} change`, async () => {
    let sourceId = 0, hidden = false; const pending = [];
    const panel = { textContent: 'initial', classList: { contains: () => hidden } };
    const ctx = { statsPanel: panel, soda: { player: { mediaStats: () => new Promise(r => pending.push(r)) } },
      subtitleOwner: () => ({ source: sourceId }), ownsSubtitle: o => o.source === sourceId };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('let statsTimer ='), source.indexOf('// ---- drag-drop')) + '\nthis.refresh = refreshStats;', ctx);
    const old = ctx.refresh();
    if (change === 'source') sourceId++;
    else if (change === 'visibility') hidden = true;
    else { const fresh = ctx.refresh(); pending[1]({ vcodec: 'fresh' }); await fresh; }
    pending[0]({ vcodec: 'old' }); await old;
    assert.equal(panel.textContent.includes('old'), false);
    if (change === 'newer') assert.ok(panel.textContent.includes('fresh'));
  });
}
