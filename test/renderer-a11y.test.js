'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// UI audit 2026-10-02: only Play/Pause was a real button, sliders and inputs had no names, dialogs had no
// roles, toasts were silent, and Continue Watching cards could not be reached from the keyboard. These are
// static checks on the shipped markup/handlers; layout is covered by test/renderer-layout.test.js.
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'player.css'), 'utf8');
const tagOf = (id) => { const m = new RegExp('<([a-z]+)\\b[^>]*\\bid="' + id + '"[^>]*>', 'i').exec(html); return m && { name: m[1].toLowerCase(), open: m[0] }; };

test('every control-bar item is a real, named button', () => {
  for (const id of ['btn-prev', 'playpause', 'btn-next', 'stop', 'mute', 'btn-tune', 'btn-playlist', 'btn-audio', 'btn-subs', 'cast', 'fullscreen']) {
    const t = tagOf(id);
    assert.ok(t, id + ' missing');
    assert.strictEqual(t.name, 'button', id + ' is a <' + t.name + '>, not a <button>');
    assert.ok(/aria-label="[^"]+"/.test(t.open), id + ' has no aria-label');
  }
});

test('the menu triggers announce that they open a menu', () => {
  for (const id of ['btn-tune', 'btn-playlist', 'btn-audio', 'btn-subs', 'cast']) assert.ok(/aria-haspopup="menu"/.test(tagOf(id).open), id);
  assert.ok(/aria-expanded/.test(js), 'aria-expanded is never updated');
});

test('sliders and inputs have accessible names', () => {
  for (const id of ['seek', 'vol', 'home-code', 'receiver-code', 'url-input', 'url-referer', 'set-interp', 'set-sponsors', 'set-subbg', 'set-requirevpn', 'set-anime4k', 'set-cast-hosts', 'set-subsize']) {
    const t = tagOf(id);
    assert.ok(t, id + ' missing');
    assert.ok(/aria-label="[^"]+"/.test(t.open) || new RegExp('<label[^>]*for="' + id + '"').test(html), id + ' has no accessible name');
  }
});

test('dialogs are dialogs and the toast is announced', () => {
  for (const id of ['url-modal', 'settings-modal', 'torrent-modal']) {
    const t = tagOf(id);
    assert.ok(/role="dialog"/.test(t.open) && /aria-modal="true"/.test(t.open) && /aria-label="[^"]+"/.test(t.open), id);
  }
  const toast = tagOf('torrent-status');
  assert.ok(/aria-live="polite"/.test(toast.open) && /role="status"/.test(toast.open), 'toast is not a live region');
});

test('Continue Watching cards are keyboard-operable buttons', () => {
  assert.ok(/card\.setAttribute\('role', 'button'\)/.test(js));
  assert.ok(/card\.tabIndex = 0/.test(js));
  assert.ok(/card\.addEventListener\('keydown'/.test(js));
  assert.ok(/\.cw-card:focus-visible/.test(css));
});

// A focused <button> must not also trigger the global Space shortcut (it would toggle play/pause AND
// press the button).
test('the global shortcuts stand down for Space/Enter on a focused button', () => {
  assert.ok(/closest\('button, \[role="button"\]'\)/.test(js), 'no guard for focused buttons in the global keydown handler');
});

test('contrast and motion: no sub-4.5:1 primary button, no low-opacity 11px text, reduced motion honoured', () => {
  assert.ok(!/\.btn\.primary \{ background: var\(--accent\)/.test(css), 'primary button still uses the light accent with white text');
  assert.ok(/prefers-reduced-motion/.test(css));
  assert.ok(!/\.device-meta \{[^}]*opacity: \.55/.test(css), 'device-meta is still dimmed with opacity');
});
