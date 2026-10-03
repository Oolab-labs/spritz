'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const pending = []; let writes = 0;
  const toggle = { toggle() {} };
  const ctx = { engine: 'chromecast', sourceIntent: 1, playbackTargetIntent: 1,
    soda: { cast: { mediaTracks: () => new Promise((resolve) => { pending.push(resolve); }) } },
    audioList: { set innerHTML(value) { writes++; } },
    subList: { querySelectorAll: () => [], querySelector: () => ({ classList: toggle }) },
    btnAudio: { classList: toggle }, btnSubs: { classList: toggle }, castIsMkv: false };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function subtitleOwner()'), source.indexOf('let currentKey')) +
    source.slice(source.indexOf('let castTrackRequest ='), source.indexOf('function exitChromecast()')) +
    '\nthis.populate = populateCastTracks;', ctx);
  return { ctx, finish: (index = pending.length - 1) => pending[index]({ audio: [], subs: [] }), writes: () => writes };
}
test('source replacement rejects a pending cast track menu', async () => {
  const f = fixture(), pending = f.ctx.populate();
  f.ctx.sourceIntent++; f.finish(); await pending;
  assert.equal(f.writes(), 0);
});
test('target roundtrip rejects old tracks while fresh lookup updates menus', async () => {
  const f = fixture(), pending = f.ctx.populate();
  f.ctx.playbackTargetIntent += 2; f.finish(); await pending;
  assert.equal(f.writes(), 0);
  const fresh = f.ctx.populate(); f.finish(); await fresh;
  assert.equal(f.writes(), 1);
});
test('leaving Chromecast rejects a pending track menu', async () => {
  const f = fixture(), pending = f.ctx.populate();
  f.ctx.engine = 'mpv'; f.finish(); await pending;
  assert.equal(f.writes(), 0);
});
test('newest lookup wins when same-source track requests finish out of order', async () => {
  const f = fixture(), older = f.ctx.populate(), newer = f.ctx.populate();
  f.finish(1); await newer;
  assert.equal(f.writes(), 1);
  f.finish(0); await older;
  assert.equal(f.writes(), 1);
});

test('retired Chromecast menu clicks send no selection while fresh menu clicks work', async () => {
  const f = fixture(), clicks = [], commands = [];
  f.ctx.document = { createElement: () => ({ dataset: {}, classList: { toggle() {} }, addEventListener: (_, cb) => clicks.push(cb) }) };
  f.ctx.audioList.appendChild = () => {};
  f.ctx.subList.appendChild = () => {};
  f.ctx.closeMenus = () => {};
  f.ctx.setTimeout = () => {};
  f.ctx.soda.cast.selectAudio = i => commands.push(['audio', i]);
  f.ctx.soda.cast.selectSubtitle = i => commands.push(['subtitle', i]);
  const pending = [];
  f.ctx.soda.cast.mediaTracks = () => new Promise(resolve => pending.push(resolve));
  const load = f.ctx.populate(); pending[0]({ audio: [{ id: 0, name: 'English' }], subs: [{ name: 'Text' }] }); await load;
  f.ctx.sourceIntent++; clicks[0](); clicks[1](); assert.deepEqual(commands, []);
  const fresh = f.ctx.populate(); pending[1]({ audio: [{ id: 0, name: 'English' }], subs: [] }); await fresh;
  clicks[2](); assert.deepEqual(commands, [['audio', 0]]);
});

test('retired Chromecast selection refresh timer cannot start a replacement lookup', async () => {
  const f = fixture(), clicks = [], timers = []; let lookups = 0;
  f.ctx.document = { createElement: () => ({ dataset: {}, classList: { toggle() {} }, addEventListener: (_, cb) => clicks.push(cb) }) };
  f.ctx.audioList.appendChild = () => {};
  f.ctx.closeMenus = () => {};
  f.ctx.setTimeout = cb => { timers.push(cb); return timers.length; };
  f.ctx.soda.cast.selectAudio = () => {};
  f.ctx.soda.cast.mediaTracks = async () => { lookups++; return { audio: [{ id: 0, name: 'English' }], subs: [] }; };
  await f.ctx.populate(); clicks[0](); assert.equal(timers.length, 1);
  f.ctx.playbackTargetIntent += 2; timers[0]();
  assert.equal(lookups, 1);
  await f.ctx.populate(); clicks[1](); timers[1]();
  assert.equal(lookups, 3);
});

test('retired MKV menu cannot recast source audio, burn subtitles, or change subtitle delay', async () => {
  const f = fixture(), nodes = [], commands = [];
  f.ctx.castIsMkv = true; f.ctx.castSrcAudio = [{ name: 'Audio' }]; f.ctx.castSrcAudioActive = 0;
  f.ctx.castSrcSubs = [{ name: 'Text', id: 2 }, { name: 'Bitmap', burn: true, subIdx: 1 }];
  f.ctx.castSrcSubActive = 0; f.ctx.castBurnActive = null;
  f.ctx.document = { createElement: () => {
    const node = { dataset: {}, classList: { toggle() {} }, addEventListener: (_, cb) => { node.click = cb; } };
    nodes.push(node); return node;
  } };
  f.ctx.audioList.appendChild = () => {}; f.ctx.subList.appendChild = () => {};
  f.ctx.closeMenus = () => {}; f.ctx.showSpinner = () => {}; f.ctx.setTimeout = () => {};
  for (const name of ['selectSourceAudio', 'selectBurnSub', 'selectSubtitle', 'setSubDelay']) {
    f.ctx.soda.cast[name] = value => commands.push([name, value]);
  }
  const pending = f.ctx.populate(); f.finish(); await pending;
  assert.equal(nodes.length, 5);
  f.ctx.playbackTargetIntent += 2; for (const node of nodes) node.click();
  assert.deepEqual(commands, []);
  const fresh = f.ctx.populate(); f.finish(); await fresh;
  nodes[5].click(); nodes[7].click(); nodes[8].click();
  assert.deepEqual(commands, [['selectSourceAudio', 0], ['selectBurnSub', 1], ['setSubDelay', -0.5]]);
});

test('Chromecast startup poll ladder cannot adopt a replacement target', () => {
  const timers = []; let target = 0, lookups = 0;
  const classes = { add() {}, remove() {} }, element = { classList: classes };
  const ctx = { document: { body: { classList: classes, style: {} } }, castOverlay: { classList: classes, querySelector: () => ({}) },
    castStop: {}, castBtn: element, btnAudio: element, btnSubs: element, controls: element, seek: {},
    soda: { airplay: { hideButton() {} } }, hideSpinner() {}, closeMenus() {}, showIcon() {},
    setPlaybackEngine: engine => { ctx.engine = engine; target++; },
    subtitleOwner: () => ({ target }), ownsSubtitle: o => o.target === target,
    populateCastTracks: () => lookups++, applyRouteHints() {}, setTimeout: cb => timers.push(cb), Date };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function enterChromecast('), source.indexOf('// Single-MKV Chromecast transport')) + '\nthis.enter = enterChromecast;', ctx);
  ctx.enter('chromecast', 'old'); ctx.enter('chromecast', 'new');
  timers.slice(0, 6).forEach(cb => cb()); assert.equal(lookups, 0);
  timers.slice(6).forEach(cb => cb()); assert.equal(lookups, 6);
});
