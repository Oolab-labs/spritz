'use strict';
/* Every local build from 2026-10-09 shipped app.asar with 5 of ~200 npm packages: node_modules was a
 * symlink, electron-builder logged "cannot find path for dependency" and dropped WebTorrent's whole
 * dependency tree (bittorrent-protocol and ~190 more). Torrents failed with "Cannot find package
 * 'bittorrent-protocol'", and verify-package passed, because nothing looked at the JS dependencies. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { readAsar, missingDependencies } = require('../build/asar-deps');

const { writeAsar } = require('./helpers/asar');
const pkg = (name, deps = {}, extra = {}) => JSON.stringify({ name, version: '1.0.0', dependencies: deps, ...extra });

function fixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-asar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.asar'); writeAsar(file, entries); return file;
}

test('the reader returns file contents from an asar archive', (t) => {
  const file = fixture(t, { 'package.json': pkg('spritz', { a: '1' }), 'node_modules/a/package.json': pkg('a') });
  const asar = readAsar(file);
  assert.equal(JSON.parse(asar.read('node_modules/a/package.json')).name, 'a');
  assert.equal(asar.read('node_modules/missing/package.json'), null);
});

test('a complete dependency tree (hoisted and nested) has nothing missing', (t) => {
  const file = fixture(t, {
    'package.json': pkg('spritz', { webtorrent: '2' }),
    'node_modules/webtorrent/package.json': pkg('webtorrent', { 'bittorrent-protocol': '4', debug: '4' }),
    'node_modules/bittorrent-protocol/package.json': pkg('bittorrent-protocol', { debug: '3' }),
    'node_modules/bittorrent-protocol/node_modules/debug/package.json': pkg('debug'),   // nested wins
    'node_modules/debug/package.json': pkg('debug')
  });
  assert.deepEqual(missingDependencies(readAsar(file)), []);
});

test('the 2026-10-09 failure: webtorrent bundled without its dependencies is reported', (t) => {
  const file = fixture(t, {
    'package.json': pkg('spritz', { webtorrent: '2' }),
    'node_modules/webtorrent/package.json': pkg('webtorrent', { 'bittorrent-protocol': '4', 'bittorrent-dht': '11' })
  });
  const missing = missingDependencies(readAsar(file));
  assert.deepEqual(missing.map((m) => m.name).sort(), ['bittorrent-dht', 'bittorrent-protocol']);
  assert.equal(missing[0].neededBy, 'webtorrent');
});

test('optional dependencies may be absent; a missing top-level dependency is reported', (t) => {
  const file = fixture(t, {
    'package.json': pkg('spritz', { webtorrent: '2', 'castv2-client': '1' }),
    'node_modules/webtorrent/package.json': pkg('webtorrent', {}, { optionalDependencies: { 'utp-native': '2' } })
  });
  assert.deepEqual(missingDependencies(readAsar(file)).map((m) => m.name), ['castv2-client']);
});

test('verify-package reports missing JS dependencies of the packaged app', () => {
  const src = fs.readFileSync(path.join(__dirname, '../build/verify-package.js'), 'utf8');
  assert.match(src, /require\('\.\/asar-deps'\)/);
  assert.match(src, /missingDependencies\(/);
});
