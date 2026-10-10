'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
function fixture() {
  const callbacks = {}, notice = { text: '' }; let stops = 0, delayed = 0;
  const status = { classList: { add() {}, remove() {} }, replaceChildren(...children) { this.textContent = children.filter(c => c && c.text).map(c => c.text).join(''); } };
  const modelPath = path.join(root, 'src/renderer/torrent-status.js');
  const ctx = { console: { error() {} }, torrentActive: true, torrentStatus: status, st: { loaded: true }, paintBuffered() {}, prettyBytes: n => String(n),
    SpritzTorrentStatus: fs.existsSync(modelPath) ? require(modelPath) : {},
    document: { createElement: () => ({}), createTextNode: text => ({ text }) },
    soda: { torrent: { onProgress: fn => callbacks.progress = fn, onReady: fn => callbacks.ready = fn, onError: fn => callbacks.error = fn, onWarning: fn => callbacks.warning = fn }, player: { load() {} } },
    scheduleErrorStop() { delayed++; }, stop() { stops++; ctx.torrentActive = false; },
    showTorrentNotice(message) { notice.text = message; } };
  vm.runInNewContext(source.slice(source.indexOf('soda.torrent.onProgress('), source.indexOf('torrentCancel.addEventListener(')), ctx);
  return { callbacks, notice, status, stops: () => stops, delayed: () => delayed };
}
test('torrent error stops the failed source and persists through late progress until dismissal', () => {
  const f = fixture(); f.callbacks.error({ message: 'No seeders available' });
  assert.equal(f.stops(), 1); assert.equal(f.delayed(), 0);
  assert.match(f.notice.text, /No seeders/);
  f.callbacks.progress({ peers: 0, speed: 0, progress: 0 }); assert.match(f.notice.text, /No seeders/);
});
test('stream status exposes runway and risk, and uses selected-file completion', () => {
  const f = fixture(); f.callbacks.progress({ peers: 2, speed: 500, progress: 0.1, fileProgress: 0.5,
    health: { known: true, risk: 'high', secondsBuffered: 15, secondsToEmpty: 25 } });
  assert.match(f.status.textContent, /50%/); assert.match(f.status.textContent, /15s buffered/); assert.match(f.status.textContent, /25s/);
});

test('unknown runway is not displayed as zero and paused playback does not predict a stall', () => {
  const { model } = require(path.join(root, 'src/renderer/torrent-status'));
  const state = { loaded: true, prettyBytes: String };
  assert.doesNotMatch(model({ peers: 1, progress: 0.3, health: { known: false } }, state).text, /buffered|stall/);
  const paused = model({ peers: 1, health: { known: true, risk: 'high', secondsBuffered: 5, secondsToEmpty: 10 } }, { ...state, paused: true });
  assert.doesNotMatch(paused.text, /may stall/); assert.match(paused.text, /download below playback rate/);
  assert.equal(model({ progress: 0.1, fileProgress: 1 }, state).complete, true);
});
