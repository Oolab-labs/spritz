'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
test('closed and reopened diagnostics reject the prior pending snapshot', async () => {
  let hidden = false, resolve, clears = 0;
  const debug = { classList: { contains: () => hidden }, textContent: 'initial' };
  const ctx = { debug, Date, st: {}, toPlayerTime: () => '0', prettyBytes: () => '0',
    soda: { diag: () => new Promise(r => { resolve = r; }) },
    setInterval: () => 1, clearInterval: () => clears++ };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let diagTimer ='), source.indexOf('// ---- tracks / menus')) + '\nthis.refresh = updateDebug;', ctx);
  const pending = ctx.refresh(); hidden = true; await ctx.refresh(); hidden = false; await ctx.refresh();
  resolve({ engine: 'stale', cast: { count: 0, names: [] }, dlna: { count: 0, names: [] } }); await pending;
  assert.equal(debug.textContent, 'initial'); assert.equal(clears, 1);
  const fresh = ctx.refresh(); resolve({ engine: 'fresh', cast: { count: 0, names: [] }, dlna: { count: 0, names: [] } }); await fresh;
  assert.ok(debug.textContent.includes('engine   fresh'));
});
