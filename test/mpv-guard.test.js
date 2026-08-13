'use strict';

// The renderer→mpv allow lists. These are a security boundary: the renderer displays remote
// metadata, subtitle text, torrent filenames and page titles, so a bug there must not become
// arbitrary file access or code execution through mpv.
//
// Every case below is either something the app genuinely does (must keep working — a guard that
// breaks playback gets loosened until it stops guarding) or something the old deny lists let
// through (must not come back).

const { test } = require('node:test');
const assert = require('assert');
const { allowProperty, allowCommand } = require('../src/main/mpv-guard');

test('every property the app actually sets is permitted', () => {
  // Sourced from preload's fixed wrappers plus direct soda.player.setProperty calls in the
  // renderer. If a feature stops working after a guard change, it is because this list moved.
  for (const p of ['pause', 'time-pos', 'volume', 'mute', 'aid', 'sid', 'sub-delay', 'hwdec',
    'audio-delay', 'speed', 'sub-back-color', 'sub-border-size', 'sub-codepage', 'sub-font-size',
    'video-aspect-override', 'video-zoom']) {
    assert.ok(allowProperty(p), p + ' is used by the app and must be allowed');
  }
});

test('properties that reach the filesystem or load code are refused', () => {
  // The first four were NOT in the old deny list — they are why this became an allow list.
  for (const p of ['log-file', 'screenshot-directory', 'dump-stats', 'sub-file-paths',
    // these were in the old deny list and must stay refused
    'input-ipc-server', 'scripts', 'load-scripts', 'script-opts', 'input-conf', 'config-dir',
    'ytdl-raw-options']) {
    assert.ok(!allowProperty(p), p + ' must be refused');
  }
});

test('property matching is case-insensitive and type-safe', () => {
  assert.ok(allowProperty('PAUSE'), 'case must not be a bypass');
  assert.ok(!allowProperty('LOG-FILE'), 'case must not be a bypass for refusals either');
  for (const bad of [null, undefined, 42, {}, [], ['pause'], { toString: () => 'pause' }]) {
    assert.ok(!allowProperty(bad), JSON.stringify(bad) + ' is not a property name');
  }
});

test('every command the app actually issues is permitted', () => {
  assert.ok(allowCommand(['frame-step']));
  assert.ok(allowCommand(['frame-back-step']));
  assert.ok(allowCommand(['stop']));
  assert.ok(allowCommand(['sub-add', '/Users/me/Movie.en.srt', 'select']));
  assert.ok(allowCommand(['add', 'chapter', 1]), 'PgDn chapter navigation');
  assert.ok(allowCommand(['add', 'chapter', -1]), 'PgUp chapter navigation');
  assert.ok(allowCommand(['cycle', 'sub-visibility']));
});

test('commands that execute programs or load scripts are refused', () => {
  for (const c of [['run', '/bin/sh', '-c', 'id'], ['subprocess', 'args'], ['load-script', '/tmp/x.lua'],
    ['loadlist', '/tmp/list'],
    // none of these were in the old deny list
    ['dump-cache', '0', 'no', '/tmp/exfil'], ['load-config-file', '/tmp/evil.conf'],
    ['screenshot-to-file', '/tmp/shot.png']]) {
    assert.ok(!allowCommand(c), c[0] + ' must be refused');
  }
});

test('add/cycle cannot be used to reach a property they should not', () => {
  // `add` and `cycle` take a property NAME as their first argument, so allowing the verb alone
  // would reopen the whole property surface through the command channel.
  assert.ok(!allowCommand(['add', 'volume', 100]), 'add must not target arbitrary properties');
  assert.ok(!allowCommand(['cycle', 'pause']), 'cycle must not target arbitrary properties');
  assert.ok(!allowCommand(['add', 'log-file']), 'add must not reach a refused property');
  assert.ok(!allowCommand(['add']), 'add with no target is not a valid chapter step');
});

test('malformed command payloads are refused rather than forwarded', () => {
  const cases = [
    ['null', null], ['undefined', undefined], ['empty array', []], ['bare string', 'stop'],
    ['array-like object', { 0: 'stop' }], ['nested array', [['stop']]], ['object arg', [{}]],
    ['object trailing arg', ['stop', {}]], ['symbol arg', [Symbol('stop')]]
  ];
  for (const [label, bad] of cases) {
    assert.ok(!allowCommand(bad), label + ' must be refused');
  }
});
