'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'src', 'renderer');
const src = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// The track menus carry a line saying who changes the choice (the Mac or the TV), what a change costs and
// what a torrent that is still downloading cannot do. DLNA hands the TV the original file, so there the
// Mac's own list is replaced by the note; hiding the buttons instead read as "no other tracks".
test('the note is part of both menus and is driven by the engine and the torrent state', () => {
  assert.strictEqual((html.match(/class="menu-note hidden"/g) || []).length, 2, 'one under audio, one under subtitles');
  assert.ok(/function applyRouteHints\(\)/.test(src));
  assert.ok(/SpritzRouteHints\.trackNotes\(\{ engine, torrent: torrentActive \}\)/.test(src));
});

test('it is refreshed whenever the engine or the torrent state changes', () => {
  assert.ok(/function setPlaybackEngine\(value\)[^\n]*applyRouteHints\(\)/.test(src), 'every engine switch');
  assert.ok(/torrentActive = true; applyRouteHints\(\)/.test(src) && /torrentActive = false; applyRouteHints\(\)/.test(src), 'torrent start and stop');
});

test('the DLNA note replaces the Mac list and keeps the buttons reachable', () => {
  const fn = src.slice(src.indexOf('function applyRouteHints()'), src.indexOf('function enterChromecast('));
  assert.ok(/note-only/.test(fn) && /btn\.classList\.remove\('hidden'\)/.test(fn));
});

test('the route-hints script loads before the scripts that use it, and torrentActive is declared before first use', () => {
  assert.ok(html.indexOf('route-hints.js') > 0 && html.indexOf('route-hints.js') < html.indexOf('cast-routes.js') && html.indexOf('cast-routes.js') < html.indexOf('renderer.js'));
  assert.ok(src.indexOf('torrentActive = false;') < src.indexOf('function applyRouteHints()') || /pickerShown = false, torrentActive = false;/.test(src));
  assert.ok(/pickerShown = false, torrentActive = false;/.test(src), 'a let used by setPlaybackEngine must be declared at the top, not 800 lines down');
});
