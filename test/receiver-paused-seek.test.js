'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../webos-receiver/index.html'), 'utf8');
function fixture(autoplay) {
  const handlers = {}, states = [], positions = [], subtitleChecks = [];
  const video = { currentTime: 42, paused: false, addEventListener: (name, fn) => { handlers[name] = fn; }, pause() { this.paused = true; } };
  const ctx = { filmTime: n => n, filmDuration: () => null, startupFailed: false, startWanted: null, video, media: { id: 'film', autoplay }, flags: {}, startSawPlaying: false, lastState: 'paused',
    subtitleLoader: { tick: (position, seek) => subtitleChecks.push({ position, seek, paused: video.paused }) },
    paint() {}, checkPendingStart() {}, sendPosition: () => positions.push(video.paused), showUi() {}, report: s => states.push(s) };
  const begin = source.indexOf("[['loadstart', 'loading']");
  vm.runInNewContext(source.slice(begin, source.indexOf('/* One second while playing', begin)), ctx);
  return { handlers, states, positions, video, subtitleChecks };
}
test('native playing after a paused seek is suppressed by explicit pause intent', () => {
  const f = fixture(false); f.handlers.playing();
  assert.equal(f.video.paused, true); assert.equal(f.states.includes('playing'), false);
});
test('seek completion preserves pause while normal playing seek remains playing', () => {
  const paused = fixture(false); paused.handlers.seeked();
  assert.equal(paused.video.paused, true); assert.deepEqual(paused.positions, [true]);
  assert.deepEqual(paused.subtitleChecks, [{ position: 42, seek: true, paused: true }]);
  const playing = fixture(true); playing.handlers.seeked();
  assert.equal(playing.video.paused, false); assert.deepEqual(playing.positions, [false]);
  assert.deepEqual(playing.subtitleChecks, [{ position: 42, seek: true, paused: false }]);
  playing.handlers.playing(); assert.equal(playing.states.includes('playing'), true);
});
test('exhausted startup correction leaves playback and user controls available', () => {
  const video = { seekable: { length: 1, start() { return 0; }, end() { return 1000; } }, currentTime: 900, seeking: false, paused: false, pause() { this.paused = true; } };
  const errors = [];
  const ctx = { video, media: { id: 'film', autoplay: true }, startWanted: 106.6, startAttempts: 2, startCheckSince: null,
    SpritzStartSeek: require('../webos-receiver/start-seek'), startDiagnostic() {}, send: (type, data) => errors.push({ type, data }) };
  const begin = source.indexOf('function checkPendingStart()');
  vm.runInNewContext(source.slice(begin, source.indexOf('function requestPlayback', begin)), ctx);
  ctx.checkPendingStart();
  assert.equal(ctx.startWanted, null); assert.equal(video.paused, false);
  assert.equal(errors[0].data.code, 'startup-position');
});
