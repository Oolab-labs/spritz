'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture(pref) {
  const commands = []; let finish, reads = 0;
  const ctx = { sourceIntent: 1, playbackTargetIntent: 1, currentLocalPath: '/show/A.mp4', engine: 'mpv', st: {},
    soda: { prefs: { get: () => { reads++; return new Promise((resolve) => { finish = resolve; }); }, save() {} },
      player: { setProperty: (...args) => commands.push(args) } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function showKeyOf()'), source.indexOf('// mpv emits aid/sid')) + '\nthis.apply = applyLangPref; this.manual = recordLangPref;', ctx);
  return { ctx, commands, resolve: () => finish(pref), reads: () => reads };
}
test('early incomplete lists do not consume a later matching language', async () => {
  const f = fixture({ audioLang: 'jpn', subLang: 'eng' });
  const first = f.ctx.apply([{ id: 1, lang: 'eng' }], []);
  await Promise.resolve(); f.resolve(); await first;
  assert.deepEqual(f.commands, []);
  await f.ctx.apply([{ id: 1, lang: 'eng' }, { id: 2, lang: 'jpn' }], [{ id: 3, lang: 'eng' }]);
  assert.deepEqual(f.commands, [['aid', '2'], ['sid', '3']]);
  assert.equal(f.reads(), 1);
});
test('same-folder replacement rejects an old preference lookup', async () => {
  const f = fixture({ audioLang: 'jpn' });
  const pending = f.ctx.apply([{ id: 2, lang: 'jpn' }], []);
  await Promise.resolve(); f.ctx.sourceIntent++; f.ctx.currentLocalPath = '/show/B.mp4'; f.resolve(); await pending;
  assert.deepEqual(f.commands, []);
});
test('manual Off and untagged audio selection win over pending preferences', async () => {
  const f = fixture({ audioLang: 'jpn', subLang: 'eng' });
  const pending = f.ctx.apply([{ id: 2, lang: 'jpn' }], [{ id: 3, lang: 'eng' }]);
  f.ctx.manual('sub', 'off'); f.ctx.manual('audio', null);
  await Promise.resolve(); f.resolve(); await pending;
  assert.deepEqual(f.commands, []);
});
test('handoff rejects preference commands aimed at the local player', async () => {
  const f = fixture({ audioLang: 'jpn' });
  const pending = f.ctx.apply([{ id: 2, lang: 'jpn' }], []);
  await Promise.resolve(); f.ctx.engine = 'dlna'; f.resolve(); await pending;
  assert.deepEqual(f.commands, []);
});


test('target roundtrip rejects old lookup and fresh local reconciliation still applies', async () => {
  const f = fixture({ audioLang: 'jpn' });
  const pending = f.ctx.apply([{ id: 2, lang: 'jpn' }], []);
  await Promise.resolve();
  f.ctx.engine = 'dlna'; f.ctx.playbackTargetIntent++;
  f.ctx.engine = 'mpv'; f.ctx.playbackTargetIntent++;
  f.resolve(); await pending;
  assert.deepEqual(f.commands, []);
  const current = f.ctx.apply([{ id: 4, lang: 'jpn' }], []);
  await Promise.resolve(); f.resolve(); await current;
  assert.deepEqual(f.commands, [['aid', '4']]);
  assert.equal(f.reads(), 2);
});
