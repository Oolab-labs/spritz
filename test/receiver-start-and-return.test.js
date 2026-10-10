'use strict';
/* Installed rc.16 on the LG 55NANO80T6A (2026-10-10):
 *  1. A cast to Spritz Receiver started via #EXT-X-START:TIME-OFFSET=24.823 — 8.16s into an 8.333s
 *     segment. The webOS player buffered 0–6s and froze at 24.82 (readyState 2). Same late-in-segment
 *     stall as AirPlay (19/19 handoffs); the snap only covered the AirPlay handoff.
 *  2. "Return to Mac" could not be clicked: in a 528px window the button spanned y 433–468 while the
 *     control bar (z-index 13, above the overlay's 12, pointer-events on while casting) started at 442;
 *     elementFromPoint at the button's centre returned .controls. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { safeStartOnTimeline } = require('../src/main/airplay-start-snap');

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:8\n' +
  [8.333, 8.334, 8.333, 8.333, 8.333].map((d, i) => `#EXTINF:${d},\nseg0000${i}.m4s`).join('\n') + '\n';

test('the observed receiver start (24.823) moves to its segment start', () => {
  assert.ok(Math.abs(safeStartOnTimeline(24.823, playlist, 0) - 16.667) < 0.01);
});
test('an early start is kept', () => {
  assert.equal(safeStartOnTimeline(26.0, playlist, 0), 26.0);
});
test('a playlist that starts partway into the film is snapped on its own timeline', () => {
  // origin 100: playlist time 24.823 is film time 124.823 -> segment start 116.667 (film)
  assert.ok(Math.abs(safeStartOnTimeline(124.823, playlist, 100) - 116.667) < 0.01);
  assert.equal(safeStartOnTimeline(50, playlist, 100), 50, 'before the playlist begins: leave it');
});
test('no playlist or no start: unchanged', () => {
  assert.equal(safeStartOnTimeline(24.823, null, 0), 24.823);
  assert.equal(safeStartOnTimeline(0, playlist, 0), 0);
});

test('playToReceiver hands the receiver the snapped start', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const body = src.slice(src.indexOf('  function playToReceiver('), src.indexOf('  function playToReceiver(') + 9000);
  assert.match(body, /safeStartOnTimeline\(/, 'the receiver path snaps its start');
  assert.match(body, /airplayMediaPlaylist\(\)/, 'from the live playlist of the receiver transport');
  assert.match(body, /svc\.play\(receiverId, \{ mediaId, url, title, startSec: playStart,/);
});

test('while casting, the control bar\'s empty top strip does not swallow overlay clicks', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/player.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /body\.casting \.controls\s*\{[^}]*pointer-events:\s*none/, 'the bar container passes clicks through');
  assert.match(css, /body\.casting \.controls > \*\s*\{[^}]*pointer-events:\s*auto/, 'its real controls stay clickable');
});
