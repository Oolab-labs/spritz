'use strict';
/* LG 55NANO80T6A (webOS 24), 19 AirPlay handoffs on 2026-10-10, three builds: every start 0.07–5.27s
 * into an HLS segment played; every start 6.00–7.57s into one stalled (TV fetched 5 segments, posted
 * PlaybackStalled, failed -11870/-60080). Controlled starts confirmed it 6/6. Segments follow the
 * source's keyframes in a stream copy (8.333s on the fixture), so the boundary must come from the
 * live playlist, not a constant. Separately, 2 handoffs started the TV at the hidden AVPlayer's
 * free-running position instead of the Mac's (33.1s -> 20.0s, 40.6s -> 7.1s). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { segmentStarts, safeAirplayStart } = require('../src/main/airplay-start-snap');

const playlist = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:8\n#EXT-X-MAP:URI="init.mp4"\n' +
  [8.333, 8.334, 8.333, 8.333, 8.333, 8.333].map((d, i) => `#EXTINF:${d},\nseg0000${i}.m4s`).join('\n') + '\n';

test('segment starts accumulate EXTINF durations', () => {
  const s = segmentStarts(playlist);
  assert.equal(s.length, 6);
  assert.ok(Math.abs(s[3].start - 25.0) < 0.001 && Math.abs(s[3].duration - 8.333) < 0.001);
});

test('every observed stall position is moved to its segment start; every observed play position is kept', () => {
  for (const [pos, want] of [[31.0, 25.0], [32.1, 25.0], [31.9, 25.0], [48.4, 41.667], [7.1, 0], [15.9, 8.333]])
    assert.ok(Math.abs(safeAirplayStart(pos, playlist) - want) < 0.01, `${pos} -> ${safeAirplayStart(pos, playlist)}, want ${want}`);
  for (const pos of [33.4, 36.9, 25.4, 10.2, 8.6, 3.3, 4.0, 20.0, 26.0, 34.5])
    assert.equal(safeAirplayStart(pos, playlist), pos, `${pos} should be kept`);
  // Inside the 4s margin's extra band (played in trials, up to 5.27s): rewound too, by design.
  assert.equal(safeAirplayStart(4.9, playlist), 0);
});

test('positions the playlist cannot vouch for are left alone', () => {
  assert.equal(safeAirplayStart(500, playlist), 500, 'beyond the produced segments');
  assert.equal(safeAirplayStart(31.9, null), 31.9);
  assert.equal(safeAirplayStart(31.9, 'garbage'), 31.9);
  assert.equal(safeAirplayStart(NaN, playlist), 0);
});

// Wiring in main.js: the handoff seeks to the snapped position and then verifies the TV is there.
function handoffHarness({ statCur }) {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = src.indexOf('  function handOffToAirplay(');
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  const seeks = [], timers = [];
  const ctx = { require: require('module').createRequire(path.join(__dirname, '../src/main/main.js')), console: { log() {}, error() {} },
    setEngine() {}, captureTracks() {}, mpvPos: () => 31.9, castEngine: 'airplay', apExternalActive: true,
    mpvAddon: { command() {} }, lan: { airplayMediaPlaylist: () => playlist },
    apAddon: { seek: (t) => seeks.push(t), play() {}, stat: () => ({ cur: statCur(), externalActive: true }) },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, Date };
  vm.createContext(ctx);
  vm.runInContext(body + '\nthis.handOffToAirplay = handOffToAirplay;', ctx);
  return { ctx, seeks, timers };
}

test('handoff from a stall-zone position starts the TV at the segment start', () => {
  const h = handoffHarness({ statCur: () => 25.5 });
  h.ctx.handOffToAirplay('test');
  assert.ok(h.seeks.length >= 1 && Math.abs(h.seeks[0] - 25.0) < 0.01, 'first seek: ' + h.seeks[0]);
  while (h.timers.length) h.timers.shift()();
  assert.equal(h.seeks.length, 1, 'player was where it should be: no corrective seek');
});

test('a handoff seek the TV did not honour is corrected', () => {
  const h = handoffHarness({ statCur: () => 7.1 });   // free-running hidden player, not the Mac's position
  h.ctx.handOffToAirplay('test');
  while (h.timers.length) h.timers.shift()();
  assert.ok(h.seeks.length >= 2, 'expected a corrective seek, got ' + JSON.stringify(h.seeks));
  assert.ok(Math.abs(h.seeks[1] - 25.0) < 0.01);
});
