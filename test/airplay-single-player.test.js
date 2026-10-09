'use strict';
/* AirPlay reached only the FIRST AVPlayer a process created (LG 55NANO80T6A, macOS system log,
 * 2026-10-08/09: 5 of 5 endpoint activations fit). macOS activated the TV endpoint every time, but
 * after teardownPlayer() replaced the AVPlayer (new file, route-loss re-arm, failed-item rebuild,
 * stop), the new player's route reported "Selected endpoint from routing context [0x0]" and never got
 * the destination change, so externalPlaybackActive stayed false. AVFoundation's routing cannot be
 * exercised in a unit test; this pins the invariant that avoids it: one AVPlayer per process, bound to
 * the picker once, with media swapped as items. Verified on hardware separately. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const mm = fs.readFileSync(path.join(__dirname, '../native/airplay/airplay_addon.mm'), 'utf8')
  .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (sig) => { const i = mm.indexOf(sig); assert.ok(i >= 0, sig + ' missing'); let d = 0, j = mm.indexOf('{', i); for (let k = j; k < mm.length; k++) { if (mm[k] === '{') d++; else if (mm[k] === '}' && --d === 0) return mm.slice(j, k + 1); } return ''; };

test('the AVPlayer is created in exactly one place, and only when none exists', () => {
  const creations = mm.match(/\[\s*AVPlayer\s+(playerWith\w*|new)\b|\[\[\s*AVPlayer\s+alloc\]/g) || [];
  assert.equal(creations.length, 1, 'AVPlayer creation sites: ' + creations.join(', '));
  const ensure = fn('static AVPlayer* ensurePlayer(');
  assert.match(ensure, /if\s*\(\s*gPlayer\s*\)\s*return\s+gPlayer\s*;/, 'ensurePlayer must reuse an existing player');
  assert.match(ensure, /\[\s*AVPlayer\s+(playerWith\w*|new)\b|\[\[\s*AVPlayer\s+alloc\]/, 'the one creation site is ensurePlayer');
});

test('nothing discards the player or rebinds the picker to a different one', () => {
  assert.doesNotMatch(mm, /^(?!\s*static\b).*\bgPlayer\s*=\s*nil/m, 'gPlayer is never cleared (outside its declaration)');
  for (const m of mm.matchAll(/gPicker\.player\s*=\s*([^;]+);/g)) assert.equal(m[1].trim(), 'gPlayer', 'picker only ever binds the one player: ' + m[0]);
});

test('prepare swaps the item on the existing player; teardown empties it but keeps it', () => {
  const prepare = fn('Napi::Value Prepare(');
  assert.match(prepare, /ensurePlayer\(\)/);
  assert.match(prepare, /replaceCurrentItemWithPlayerItem:\s*item/);
  const teardown = fn('static void teardownPlayer() {');
  assert.match(teardown, /allowsExternalPlayback\s*=\s*NO/, 'teardown still revokes external playback');
  assert.match(teardown, /replaceCurrentItemWithPlayerItem:\s*nil/, 'teardown still empties the player so the route drops');
  assert.match(teardown, /retireRouteWork\(\)/);
});

test('player-level observers are registered once, at creation, not per prepare', () => {
  const prepare = fn('Napi::Value Prepare(');
  assert.doesNotMatch(prepare, /forKeyPath:@"externalPlaybackActive"/);
  assert.doesNotMatch(prepare, /addPeriodicTimeObserverForInterval/);
  const ensure = fn('static AVPlayer* ensurePlayer(');
  assert.match(ensure, /forKeyPath:@"externalPlaybackActive"/);
  assert.match(ensure, /addPeriodicTimeObserverForInterval/);
});
