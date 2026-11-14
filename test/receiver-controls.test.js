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
// The television can stop on its own: Back or Stop on its remote, or a fatal media error. It then
// reports idle with mediaId:null (webos-receiver stop() and its error path), and the Mac tears the
// stream down. Before this test the window never noticed: it stayed on "Playing on TV" with the
// cast button hidden, so casting again and choosing subtitles both went nowhere.
const tvIdle = { id: 'lg', status: 'online', playback: { mediaId: null, state: 'idle', currentTime: null, durationSec: null } };
test('a stop on the television returns the window to the Mac, paused where the TV was', () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  f.ctx.targets([{ id: 'lg', status: 'online', playback: { mediaId: 'film', state: 'playing', currentTime: 1078, durationSec: 2710 } }]);
  f.ctx.sync(); assert.equal(f.ctx.engine, 'receiver');
  f.ctx.targets([tvIdle]); f.ctx.sync();
  assert.equal(f.ctx.engine, 'mpv');
  assert.equal(f.ctx.st.paused, true);
  assert.deepEqual(f.calls.filter(c => c[0] === 'local').slice(-2), [['local', 'pause'], ['local', 'seek', 1078]]);
  // The TV has already stopped; telling it to stop again is noise, not recovery.
  assert.equal(f.calls.filter(c => c[0] === 'receiver' && c[2] === 'stop').length, 0);
});
test('an idle report from before the television took this film does not end the cast', () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  // The load has been sent but the TV has not reported it yet: its last report is still the
  // previous idle. That is not a stop of this film.
  f.ctx.targets([tvIdle]); f.ctx.sync();
  assert.equal(f.ctx.engine, 'receiver');
  assert.equal(f.calls.filter(c => c[0] === 'local' && c[1] === 'seek').length, 0);
});
test('a Return to Mac still in flight when the TV stops does not restore twice', async () => {
  const f = fixture(); f.ctx.enter({ id: 'lg' }, 'film');
  f.ctx.targets([{ id: 'lg', status: 'online', playback: { mediaId: 'film', state: 'playing', currentTime: 40 } }]);
  f.ctx.sync();
  const leaving = f.ctx.leave(true);
  f.ctx.targets([tvIdle]); f.ctx.sync();
  f.complete({ ok: true }); await leaving;
  assert.equal(f.ctx.engine, 'mpv');
  assert.equal(f.calls.filter(c => c[0] === 'local' && c[1] === 'seek').length, 1);
});
// While casting, the audio and subtitle menus hold the TV's tracks, whose handlers act only in
// receiver mode. Measured on the LG with the packaged build: after the TV stopped, choosing
// "English (UK)" on the Mac left mpv's sid at "no" with no message. Leaving the TV for the SAME
// film must hand the menus back to mpv.
test('leaving the TV for the same film rebuilds the local track menus', async () => {
  const viaTv = fixture(); let rebuilt = 0; viaTv.ctx.restoreLocalTrackMenus = () => { rebuilt++; };
  viaTv.ctx.enter({ id: 'lg' }, 'film');
  viaTv.ctx.targets([{ id: 'lg', status: 'online', playback: { mediaId: 'film', state: 'playing', currentTime: 30 } }]); viaTv.ctx.sync();
  viaTv.ctx.targets([tvIdle]); viaTv.ctx.sync();
  assert.equal(rebuilt, 1, 'a stop on the TV');
  const viaMac = fixture(); rebuilt = 0; viaMac.ctx.restoreLocalTrackMenus = () => { rebuilt++; };
  viaMac.ctx.enter({ id: 'lg' }, 'film');
  const leaving = viaMac.ctx.leave(true); viaMac.complete({ ok: true }); await leaving;
  assert.equal(rebuilt, 1, 'Return to Mac');
  const newSource = fixture(); rebuilt = 0; newSource.ctx.restoreLocalTrackMenus = () => { rebuilt++; };
  newSource.ctx.enter({ id: 'lg' }, 'film');
  await newSource.ctx.leave(false);
  assert.equal(rebuilt, 0, 'a new source brings its own track list');
});
