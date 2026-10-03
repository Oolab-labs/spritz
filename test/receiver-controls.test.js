'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const calls = [], handlers = {}, classes = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
  const element = { classList: classes, style: {}, querySelector: () => ({ classList: classes }), querySelectorAll: () => [], appendChild() {} };
  let complete;
  const ctx = { engine: 'mpv', sourceIntent: 1, st: { loaded: true, paused: true, currentTime: 8, duration: 180 },
    setPlaybackEngine: v => { ctx.engine = v; },
    soda: { receiver: { command: (id, cmd, arg) => { calls.push(['receiver', id, cmd, arg]); return new Promise(resolve => { complete = resolve; }); } },
      player: { pause: () => calls.push(['local', 'pause']), seek: t => calls.push(['local', 'seek', t]), play: () => calls.push(['local', 'play']) } },
    audioList: element, subList: element, document: { body: element, createElement: () => ({ classList: classes, dataset: {} }) }, castOverlay: element, castStop: {}, castBtn: element,
    btnAudio: element, btnSubs: element, controls: element, volSlider: {}, muteBtn: {}, seek: {},
    hideSpinner() {}, showPicker() {}, refreshCast() {}, toast: t => calls.push(['toast', t]),
    showIcon: icon => calls.push(['icon', icon]), updateRemoteTime: (t, d) => calls.push(['clock', t, d]),
    playpause: { addEventListener: (type, cb) => { handlers[type] = cb; } },
    icPlay: element, icReplay: element };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let receiverSelection ='), source.indexOf('let receiverPending =')) +
    '\nthis.enter = enterReceiver; this.leave = leaveReceiver; this.sync = syncReceiverPlayback; this.control = receiverControl; this.targets = x => receiverTargets = x;', ctx);
  vm.runInContext(source.slice(source.indexOf("playpause.addEventListener('click'"), source.indexOf("stopBtn.addEventListener('click'")), ctx);
  return { ctx, calls, handlers, complete: value => complete(value) };
}
test('desktop toggle controls receiver and local clock cannot overwrite receiver state', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  f.handlers.click(); assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'play', undefined]);
  f.complete({ ok: true }); await Promise.resolve();
  f.ctx.targets([{ id: 'lg', status: 'online', playback: { mediaId: 'film', state: 'playing', currentTime: 45, durationSec: 180 } }]);
  f.ctx.sync(); assert.equal(f.ctx.st.paused, false); assert.equal(f.ctx.st.currentTime, 45);
  f.handlers.click(); assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'pause', undefined]);
  assert.equal(f.calls.filter(c => c[0] === 'local' && c[1] === 'play').length, 0);
  vm.runInContext(source.slice(source.indexOf('function dispatch(ev)'), source.indexOf("  if (ev.type === 'file-loaded')")) + '\n}\nthis.dispatch = dispatch;', f.ctx);
  f.ctx.dispatch({ type: 'property-change', name: 'time-pos', value: 999 });
  assert.equal(f.ctx.st.currentTime, 45);
});
test('receiver control routes seek and ignores a replaced source or media', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  f.ctx.control('seek', 70); assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'seek', 70]);
  f.complete({ ok: true }); await Promise.resolve();
  f.ctx.targets([{ id: 'lg', status: 'online', playback: { mediaId: 'old-film', state: 'playing', currentTime: 99 } }]);
  f.ctx.sync(); assert.equal(f.ctx.st.currentTime, 8);
  f.ctx.sourceIntent++; const count = f.calls.length; await f.ctx.control('play'); assert.equal(f.calls.length, count);
});
test('return to Mac waits for successful stop and restores a paused confirmed position', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  const failed = f.ctx.leave(true); f.complete({ ok: false }); await failed;
  assert.equal(f.ctx.engine, 'receiver');
  const success = f.ctx.leave(true); f.complete({ ok: true }); await success;
  assert.equal(f.ctx.engine, 'mpv'); assert.equal(f.ctx.st.paused, true);
  assert.deepEqual(f.calls.filter(c => c[0] === 'local').slice(-2), [['local', 'pause'], ['local', 'seek', 8]]);
});
test('new source detaches immediately and a late stop response cannot switch its engine', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  await f.ctx.leave(false); assert.equal(f.ctx.engine, 'mpv');
  f.ctx.sourceIntent++; f.ctx.engine = 'airplay'; f.complete({ ok: true }); await Promise.resolve();
  assert.equal(f.ctx.engine, 'airplay');
});
test('keyboard and scrubber seek handlers send TV commands without seeking mpv', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  f.ctx.seek.addEventListener = (type, cb) => { f.handlers['seek-' + type] = cb; };
  f.ctx.remoteSeek = t => f.ctx.control('seek', t);
  Object.assign(f.ctx, { paint() {}, curEl: {}, toPlayerTime: String });
  vm.runInContext(source.slice(source.indexOf('function seekBy(d)'), source.indexOf("document.addEventListener('keydown'")) + '\nthis.seekBy = seekBy;', f.ctx);
  f.ctx.seekBy(10); assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'seek', 18]);
  f.complete({ ok: true }); await Promise.resolve();
  vm.runInContext(source.slice(source.indexOf("seek.addEventListener('change'"), source.indexOf('// ---- scrubber thumbnail')), f.ctx);
  f.ctx.seek.value = '60'; f.handlers['seek-change']();
  assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'seek', 60]);
  assert.equal(f.calls.filter(c => c[0] === 'local' && c[1] === 'seek').length, 0);
});
test('arrow shortcut seeks with slider focus but preserves text entry', () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  let keydown;
  f.ctx.document.addEventListener = (_, cb) => { keydown = cb; };
  f.ctx.seekBy = delta => f.ctx.control('seek', f.ctx.st.currentTime + delta);
  const begin = source.indexOf("document.addEventListener('keydown', (e) => {");
  const end = source.indexOf('\n});', begin) + 4;
  vm.runInContext(source.slice(begin, end), f.ctx);
  let prevented = false;
  keydown({ target: { tagName: 'INPUT', type: 'range' }, keyCode: 39, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.calls.at(-1), ['receiver', 'lg', 'seek', 18]);
  const count = f.calls.length;
  keydown({ target: { tagName: 'INPUT', type: 'text' }, keyCode: 37, preventDefault() { assert.fail('text input must retain arrow navigation'); } });
  assert.equal(f.calls.length, count);
});
