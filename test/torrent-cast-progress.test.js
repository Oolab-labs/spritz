'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
test('receiver casting retains download speed and removes stale hidden-control state', () => {
  let update; const hidden = new Set(['hidden', 'controls-hidden']), status = { classList: { add: c => hidden.add(c), remove: (...names) => names.forEach(c => hidden.delete(c)) }, replaceChildren: (_, text) => { status.text = text; } };
  const ctx = { engine: 'receiver', st: { loaded: true }, torrentStatus: status, paintBuffered() {}, prettyBytes: () => '2MB',
    document: { createElement: () => ({}), createTextNode: text => text },
    soda: { torrent: { onProgress: fn => { update = fn; } } } };
  vm.runInNewContext(source.slice(source.indexOf('soda.torrent.onProgress('), source.indexOf('soda.torrent.onReady(')), ctx);
  update({ peers: 3, speed: 2000000, progress: 0.2 });
  assert.equal(hidden.size, 0); assert.match(status.text, /2MB\/s.*3 peers.*20%/);
  update({ progress: 1 }); assert.equal(hidden.has('hidden'), true);
});
