'use strict';
/* Reported on hardware (LG 55NANO80T6A, 2026-10-09): English chosen from the AirPlay subtitle menu
 * was lost when playback returned to the Mac — local resumed with sid=no, the track that was active
 * at handoff. The AirPlay menu selects an AVMediaSelectionOption by index; the return path restores
 * mpv's `sid`, and nothing connected the two. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { sidForAirplaySubtitle } = require('../src/main/airplay-subtitle-restore');

const hash = (p) => crypto.createHash('sha1').update(String(p)).digest('hex').slice(0, 12);
// mpv track-list (subs only matter): two embedded (one bitmap PGS first), then an external .srt.
const mpvTracks = [
  { id: 1, type: 'video' }, { id: 1, type: 'audio' },
  { id: 1, type: 'sub', external: false, codec: 'hdmv_pgs_subtitle' },
  { id: 2, type: 'sub', external: false, codec: 'subrip', lang: 'eng' },
  { id: 3, type: 'sub', external: true, 'external-filename': '/films/Movie.fr.srt' }
];
// Renditions in master order: bitmap ordinal 0 is skipped (not WebVTT-able), so rendition 0 is ordinal 1.
const renditions = [
  { id: 'source-subtitle-1', name: 'ENG', lang: 'eng' },
  { id: 'external-subtitle-' + hash('/films/Movie.fr.srt'), name: 'Subtitle 2', lang: 'fra' }
];
const options = [{ name: 'ENG - English' }, { name: 'Subtitle 2 - French' }];

test('an embedded rendition maps to the mpv track at the same subtitle-stream ordinal', () => {
  assert.equal(sidForAirplaySubtitle({ index: 0, options, renditions, mpvTracks }), '2');
});
test('an external rendition maps to the mpv track loaded from the same file', () => {
  assert.equal(sidForAirplaySubtitle({ index: 1, options, renditions, mpvTracks }), '3');
});
test('Off maps to no subtitles', () => {
  assert.equal(sidForAirplaySubtitle({ index: -1, options, renditions, mpvTracks }), 'no');
});
test('unverifiable mappings return null instead of guessing', () => {
  assert.equal(sidForAirplaySubtitle({ index: 0, options: [{ name: 'CC1' }, ...options], renditions, mpvTracks }), null, 'option count differs');
  assert.equal(sidForAirplaySubtitle({ index: 0, options: [{ name: 'French' }, { name: 'English' }], renditions, mpvTracks }), null, 'names disagree');
  assert.equal(sidForAirplaySubtitle({ index: 0, options, renditions, mpvTracks: [] }), null, 'no mpv tracks known');
  assert.equal(sidForAirplaySubtitle({ index: 5, options, renditions, mpvTracks }), null, 'out of range');
});

// The wiring: selecting a subtitle over AirPlay must change what the return to local restores.
test('a subtitle chosen over AirPlay is what local playback restores', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const tracks = src.slice(src.indexOf('  let savedAid = null, savedSid = null;'), src.indexOf('  // Send whatever is currently open to a Spritz Receiver.'));
  const handlerStart = src.indexOf("  ipcMain.on('airplay:selectMedia'");
  const handler = src.slice(handlerStart, src.indexOf('  });', handlerStart) + 6);
  let onSelect;
  const mainRequire = require('module').createRequire(path.join(__dirname, '../src/main/main.js'));
  const ctx = { require: mainRequire, console: { log() {}, error: console.error }, castEngine: 'airplay', castSubs: renditions, mpvTrackList: mpvTracks,
    isCasting: () => true, mpvAddon: { playerStat: () => ({}) },
    apAddon: { selectMedia() {}, mediaTracks: () => ({ audio: [], subs: options }) },
    ipcMain: { on: (name, fn) => { if (name === 'airplay:selectMedia') onSelect = fn; } } };
  vm.createContext(ctx);
  vm.runInContext(tracks + handler + '\nthis.loadOpts = loadOpts;', ctx);
  onSelect(null, { kind: 'subs', index: 0 });
  assert.match(ctx.loadOpts(120, true), /sid=2\b/);
  onSelect(null, { kind: 'subs', index: -1 });
  assert.match(ctx.loadOpts(120, true), /sid=no\b/);
});
