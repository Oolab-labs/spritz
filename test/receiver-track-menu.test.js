'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const menu = require('../webos-receiver/track-menu');
test('opening and browsing a track menu leaves selection unchanged until explicit commit', () => {
  const tracks = [{ id: 'source-audio-0', selected: true }, { id: 'source-audio-1', selected: false }];
  const state = menu.open('audio', tracks);
  assert.equal(menu.choice(state).id, 'source-audio-0');
  menu.move(state, 1); assert.equal(menu.choice(state).id, 'source-audio-1');
  assert.equal(tracks[0].selected, true); assert.equal(tracks[1].selected, false);
  menu.move(state, 100); assert.equal(state.index, 1);
  menu.move(state, -100); assert.equal(state.index, 0);
});
test('subtitle menu includes Off and opens at the selected subtitle', () => {
  const state = menu.open('subtitle', [{ id: '0', title: 'English', selected: false }, { id: '1', title: 'French', selected: true }]);
  assert.equal(state.items[0].id, 'off'); assert.equal(state.index, 2);
  assert.equal(menu.open('subtitle', []).items[0].selected, true);
  assert.equal(menu.choice(menu.open('audio', [])), null);
});

test('remote journey opens visible choices and Back returns through list, control and playback', () => {
  const vm = require('vm'), fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../webos-receiver/index.html'), 'utf8');
  const elements = {}, selected = [], document = { activeElement: null };
  function element(id) {
    return elements[id] || (elements[id] = { id, children: [], hidden: true,
      focus() { document.activeElement = this; }, blur() { document.activeElement = null; },
      appendChild(child) { this.children.push(child); },
      click() { if (this.onclick) this.onclick(); }, setAttribute() {},
      set innerHTML(_) { this.children = []; } });
  }
  document.createElement = () => ({ children: [], appendChild(child) { this.children.push(child); }, setAttribute() {}, focus() { document.activeElement = this; } });
  let keydown, stopped = 0;
  document.addEventListener = (_, fn) => { keydown = fn; };
  const ctx = { SpritzTrackMenu: menu, document, el: element, media: { id: 'film' },
    showUi() {}, clearTimeout() {}, uiTimer: null, selectMediaTrack: (kind, id) => selected.push({ kind, id }),
    requestPlayback() { assert.fail('menu navigation changed playback'); }, stop() { stopped++; } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('var trackInventory ='), html.indexOf('\nfunction selectMediaTrack')) +
    html.slice(html.indexOf('var controlIds ='), html.indexOf('/* appinfo disables')), ctx);
  ctx.trackInventory = { audio: [{ id: 'a', selected: true }, { id: 'b', selected: false }], subtitles: [{ id: 's', title: 'English', selected: false }] };
  const key = code => keydown({ keyCode: code, target: document.activeElement, preventDefault() {}, stopPropagation() {} });
  element('audio-choice').onclick = () => ctx.openTrackMenu('audio');
  element('subtitle-choice').onclick = () => ctx.openTrackMenu('subtitle');
  key(40); assert.equal(document.activeElement.id, 'play-pause');
  key(39); key(39); assert.equal(document.activeElement.id, 'audio-choice');
  key(13); assert.equal(element('track-panel').hidden, false); assert.equal(element('track-options').children.length, 2);
  key(40); assert.equal(selected.length, 0);
  key(461); assert.equal(element('track-panel').hidden, true); assert.equal(document.activeElement.id, 'audio-choice');
  key(39); assert.equal(document.activeElement.id, 'subtitle-choice');
  key(13); assert.equal(element('track-options').children.length, 2);
  key(40); key(13); assert.deepEqual(selected, [{ kind: 'subtitle', id: 's' }]);
  assert.equal(document.activeElement.id, 'subtitle-choice'); assert.equal(stopped, 0);
  key(461); assert.equal(document.activeElement, null); assert.equal(stopped, 0);
  key(461); assert.equal(stopped, 1);
});

test('live inventory refresh preserves the browsed track, with current loading status', () => {
  const state = menu.open('subtitle', [{ id: 's', title: 'English', selected: true }]);
  const updated = menu.refresh(state, [{ id: 's', title: 'English', selected: true, readyState: 3 }]);
  assert.equal(menu.choice(updated).id, 's');
  assert.match(menu.detail(menu.choice(updated), 'subtitle'), /Unavailable/);
  assert.equal(menu.label({ id: 's', lang: 'en', title: 'English SDH' }), 'English');
});

function paintFixture() {
  const vm = require('vm'), fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../webos-receiver/index.html'), 'utf8');
  const elements = {}, document = { activeElement: null };
  const make = (id) => ({ id, children: [], hidden: false, scrollTop: 0,
    focus() { document.activeElement = this; if (this.onfocus) this.onfocus(); },
    appendChild(child) { this.children.push(child); }, setAttribute() {},
    set innerHTML(_) { this.children = []; } });
  document.createElement = () => make('');
  const el = id => elements[id] || (elements[id] = make(id));
  const ctx = { SpritzTrackMenu: menu, document, el, showUi() {} };
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('var trackInventory ='), html.indexOf('\nfunction selectMediaTrack')), ctx);
  ctx.trackInventory = { audio: [{ id: 'a', selected: true }, { id: 'b' }], subtitles: [] };
  ctx.openTrackMenu('audio');
  return { ctx, document, el };
}
test('actual focus determines which track OK will select', () => {
  const f = paintFixture();
  f.el('track-options').children[1].focus();
  assert.equal(menu.choice(f.ctx.trackMenu).id, 'b');
});
test('background track repaint does not steal Close or tab focus', () => {
  for (const id of ['track-close', 'track-audio-tab', 'track-subtitle-tab']) {
    const f = paintFixture();
    f.el(id).focus();
    f.ctx.paintTrackMenu(true);
    assert.equal(f.document.activeElement.id, id);
  }
});
