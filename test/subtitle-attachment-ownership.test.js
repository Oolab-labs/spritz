'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const handlers = {}, attachments = []; let finish;
  const deferred = () => new Promise((resolve) => { finish = resolve; });
  const node = (name) => ({ addEventListener: (_, fn) => { handlers[name] = fn; }, classList: { remove() {} } });
  const ctx = { clearErrorStop() {}, applyRouteHints() {}, sourceIntent: 1, currentLocalPath: '/A.mp4', engine: 'mpv', closeMenus() {}, toast() {},
    subAddBtn: node('picker'), $: node,
    soda: { dialog: { openFile: deferred }, player: { onlineSubtitles: deferred, addSubtitleFile: (file) => attachments.push(file) } } };
  vm.createContext(ctx);
  const owner = source.slice(source.indexOf('let playbackTargetIntent ='), source.indexOf('function ownsSubtitle('));
  const owns = source.slice(source.indexOf('function ownsSubtitle('), source.indexOf('\n', source.indexOf('function ownsSubtitle(')));
  const handlersCode = source.slice(source.indexOf("subAddBtn.addEventListener('click'"), source.indexOf('const clampDelay'));
  vm.runInContext(owner + owns + '\n' + handlersCode + '\nthis.changeEngine = setPlaybackEngine;', ctx);
  return { handlers, attachments, ctx, finish: (v) => finish(v), resolve: () => finish({ ok: true, srt: '/A.srt', filePaths: ['/A.srt'] }) };
}
for (const kind of ['picker', '#sub-online']) {
  for (const change of ['none', 'source', 'target-roundtrip']) {
    test(`${kind} attachment with ${change}`, async () => {
      const f = fixture(); const pending = f.handlers[kind]();
      if (change === 'source') f.ctx.sourceIntent++;
      if (change === 'target-roundtrip') { f.ctx.changeEngine('dlna'); f.ctx.changeEngine('mpv'); }
      f.resolve(); await pending;
      assert.deepEqual(f.attachments, change === 'none' ? ['/A.srt'] : []);
    });
  }
}
// Whisper was removed, so a failed OpenSubtitles lookup must not point the user at it.
test('#sub-online failure toast does not offer Whisper', async () => {
  const f = fixture(); const toasts = []; f.ctx.toast = (m) => toasts.push(m);
  const pending = f.handlers['#sub-online']();
  f.finish({ ok: false }); await pending;
  assert.equal(toasts.at(-1), 'No subtitles found');
});
