'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
test('renderer source admission before ready-to-show reaches an initialized native core', () => {
  let ready = false, shown, loaded = false;
  const ctx = { INDEX_HTML: 'renderer', attachPlayer: () => { ready = true; },
    mainWindow: { loadFile: () => { loaded = ready; }, once: (_, cb) => { shown = cb; }, show() {} } };
  const begin = source.indexOf("    // The preload can admit");
  const end = source.indexOf('    // OS fullscreen', begin);
  vm.runInNewContext(source.slice(begin, end), ctx);
  assert.equal(loaded, true, 'an early renderer load must not be silently dropped');
  shown(); assert.equal(ready, true);
});
