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
  const ctx = { clearErrorStop() {}, applyRouteHints() {}, sourceIntent: 1, currentLocalPath: '/A.mp4', engine: 'mpv', closeMenus() {}, toast() {}, showSponsorToast() {},
    subAddBtn: node('picker'), $: node,
    soda: { dialog: { openFile: deferred }, player: { onlineSubtitles: deferred, generateSubtitles: deferred, addSubtitleFile: (file) => attachments.push(file) } } };
  vm.createContext(ctx);
  const owner = source.slice(source.indexOf('let playbackTargetIntent ='), source.indexOf('function ownsSubtitle('));
  const owns = source.slice(source.indexOf('function ownsSubtitle('), source.indexOf('\n', source.indexOf('function ownsSubtitle(')));
  const handlersCode = source.slice(source.indexOf("subAddBtn.addEventListener('click'"), source.indexOf('const clampDelay'));
  vm.runInContext(owner + owns + '\n' + handlersCode + '\nthis.changeEngine = setPlaybackEngine;', ctx);
  return { handlers, attachments, ctx, resolve: () => finish({ ok: true, srt: '/A.srt', filePaths: ['/A.srt'] }) };
}
for (const kind of ['picker', '#sub-online', '#sub-generate']) {
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
