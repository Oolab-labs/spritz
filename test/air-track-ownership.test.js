'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const pending = []; let writes = 0;
  const toggle = { toggle() {}, contains: () => false };
  const ctx = { engine: 'airplay', sourceIntent: 1, playbackTargetIntent: 1,
    soda: { airplay: { mediaTracks: () => new Promise((resolve) => { pending.push(resolve); }) } },
    audioList: { set innerHTML(value) { writes++; } },
    subList: { querySelectorAll: () => [], querySelector: () => ({ classList: toggle }) },
    btnAudio: { classList: toggle }, btnSubs: { classList: toggle }, castIsMkv: false };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function subtitleOwner()'), source.indexOf('let currentKey')) +
    source.slice(source.indexOf('let airTrackRequest ='), source.indexOf('function exitCasting()')) +
    '\nthis.populate = populateAirTracks;', ctx);
  return { ctx, finish: (index = pending.length - 1) => pending[index]({ audio: [], subs: [] }), writes: () => writes };
}
test('source replacement rejects a pending AirPlay track menu', async () => {
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
test('leaving AirPlay rejects a pending track menu', async () => {
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

test('retired AirPlay menu clicks send no selection while fresh menu clicks work', async () => {
  const f = fixture(), clicks = [], commands = [];
  f.ctx.document = { createElement: () => ({ dataset: {}, classList: { toggle() {} }, addEventListener: (_, cb) => clicks.push(cb) }) };
  f.ctx.audioList.appendChild = () => {};
  f.ctx.subList.appendChild = () => {};
  f.ctx.closeMenus = () => {};
  f.ctx.setTimeout = () => {};
  f.ctx.soda.airplay.selectAudio = i => commands.push(['audio', i]);
  f.ctx.soda.airplay.selectSubtitle = i => commands.push(['subtitle', i]);
  const pending = [];
  f.ctx.soda.airplay.mediaTracks = () => new Promise(resolve => pending.push(resolve));
  const load = f.ctx.populate(); pending[0]({ audio: [{ name: 'English' }], subs: [{ name: 'Text' }] }); await load;
  f.ctx.sourceIntent++; clicks[0](); clicks[1](); assert.deepEqual(commands, []);
  const fresh = f.ctx.populate(); pending[1]({ audio: [{ name: 'English' }], subs: [] }); await fresh;
  clicks[2](); assert.deepEqual(commands, [['audio', 0]]);
});

test('retired AirPlay selection refresh timer cannot start a replacement lookup', async () => {
  const f = fixture(), clicks = [], timers = []; let lookups = 0;
  f.ctx.document = { createElement: () => ({ dataset: {}, classList: { toggle() {} }, addEventListener: (_, cb) => clicks.push(cb) }) };
  f.ctx.audioList.appendChild = () => {};
  f.ctx.closeMenus = () => {};
  f.ctx.setTimeout = cb => { timers.push(cb); return timers.length; };
  f.ctx.soda.airplay.selectAudio = () => {};
  f.ctx.soda.airplay.mediaTracks = async () => { lookups++; return { audio: [{ name: 'English' }], subs: [] }; };
  await f.ctx.populate(); clicks[0](); assert.equal(timers.length, 1);
  f.ctx.playbackTargetIntent += 2; timers[0]();
  assert.equal(lookups, 1);
  await f.ctx.populate(); clicks[1](); timers[1]();
  assert.equal(lookups, 3);
});
