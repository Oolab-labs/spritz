'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');

// Just enough DOM for the menu builders: lists of <li> with dataset, class toggles and click handlers.
function list() {
  const node = { children: [], innerHTML: '' };
  Object.defineProperty(node, 'innerHTML', { set() { node.children = node.children.filter(c => c.dataset.sid === 'off'); }, get() { return ''; } });
  node.appendChild = c => { c.parent = node; node.children.push(c); };
  node.querySelector = sel => sel === 'li[data-sid="off"]' ? node.children.find(c => c.dataset.sid === 'off') : null;
  node.querySelectorAll = () => node.children.filter(c => c.dataset.track !== undefined || c.className === 'cast-subsync');
  return node;
}
function li() {
  const handlers = [];
  const el = { dataset: {}, textContent: '', className: '', classList: { toggle() {}, add() {}, remove() {} },
    addEventListener: (_t, cb) => handlers.push(cb), click: () => { handlers.forEach(h => h()); if (el.onclick) el.onclick(); } };
  el.remove = () => { el.parent.children = el.parent.children.filter(c => c !== el); };
  return el;
}
test('the local subtitle menu works again after the TV menu replaced it', () => {
  const props = [];
  const subList = list(), audioList = list(); const off = li(); off.dataset.sid = 'off'; subList.appendChild(off);
  const ctx = { subList, audioList, sourceIntent: 1, st: { loaded: true },
    document: { createElement: li }, btnAudio: { classList: { toggle() {}, remove() {} } }, btnSubs: { classList: { remove() {} } },
    soda: { player: { setProperty: (k, v) => props.push([k, v]) } }, recordLangPref() {}, closeMenus() {}, applyLangPref() {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function trackLabel('), source.indexOf('// ---- per-show audio/subtitle language memory')) +
    '\nthis.onTrackList = onTrackList; this.restore = restoreLocalTrackMenus;', ctx);
  ctx.onTrackList([{ type: 'audio', id: 1, lang: 'eng', selected: true }, { type: 'sub', id: 3, lang: 'eng', title: 'English (UK)' }]);
  // Casting: the TV's track list takes the menu over, with handlers that only act in receiver mode.
  subList.querySelectorAll().forEach(n => n.remove());
  const tvItem = li(); tvItem.dataset.track = 'source-subtitle-0'; tvItem.textContent = 'ENG · English (UK)'; subList.appendChild(tvItem);
  ctx.restore();
  const items = subList.querySelectorAll();
  assert.deepEqual(items.map(i => i.dataset.track), [3], 'the TV items are gone and the local track is back');
  items[0].click();
  assert.deepEqual(props.at(-1), ['sid', '3']);
});
test('a remembered track list never crosses into another source', () => {
  const subList = list(), audioList = list(); const off = li(); off.dataset.sid = 'off'; subList.appendChild(off);
  const ctx = { subList, audioList, sourceIntent: 1, st: { loaded: true },
    document: { createElement: li }, btnAudio: { classList: { toggle() {}, remove() {} } }, btnSubs: { classList: { remove() {} } },
    soda: { player: { setProperty() {} } }, recordLangPref() {}, closeMenus() {}, applyLangPref() {} };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function trackLabel('), source.indexOf('// ---- per-show audio/subtitle language memory')) +
    '\nthis.onTrackList = onTrackList; this.restore = restoreLocalTrackMenus;', ctx);
  ctx.onTrackList([{ type: 'sub', id: 3, lang: 'eng' }]);
  subList.querySelectorAll().forEach(n => n.remove());
  ctx.sourceIntent = 2;
  ctx.restore();
  assert.equal(subList.querySelectorAll().length, 0);
});
