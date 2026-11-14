'use strict';
// Pins the live-HLS options resolveCastable hands lanserver, so folding hlsOpts into named locals
// (one receiverFeatures read, receiverSubtitles following `receiver`) cannot change what reaches serveHls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

function resolveWith(env, extra) {
  let seen = null;
  const ctx = { loadGen: 1, AIRPLAY_4K: false, AIRPLAY_CAPS: { base: true }, externalSubs: ['ext'], airplayCaps: c => c,
    process: { env }, receiverSourceWaiting: () => false, ctypeFor: () => 'video/x-matroska',
    require: name => require(name.startsWith('./') ? path.join(__dirname, '../src/main', name) : name),
    lan: { avCompatible: () => false, serveHls: (_src, _cb, opts) => { seen = opts; } } };
  vm.createContext(ctx);
  vm.runInContext(main.slice(main.indexOf('  function resolveCastable('), main.indexOf('  // Resolve the CHROMECAST')) + '\nthis.resolve = resolveCastable;', ctx);
  ctx.resolve('http://localhost:51234/webtorrent/abc/film.mkv', () => {}, null, true, extra);
  return seen;
}

test('a receiver preparation sideloads receiver subtitles and, by default, selects source audio from its start', () => {
  const opts = resolveWith({}, { startSec: 12, receiver: true, receiverSubtitles: true, audioHint: 2 });
  assert.equal(opts.sideloadSubs, true);
  assert.equal(opts.receiverSubtitles, true);
  assert.equal(opts.sourceSelectedAudio, true);
  assert.equal(opts.receiverStartSec(), 12);
  assert.equal(opts.audioHint, 2);
  assert.deepEqual(opts.caps, { base: true });
  assert.deepEqual(opts.extraSubs, ['ext']);
});

test('the source-audio kill switch keeps receiver subtitles but drops source audio and its start', () => {
  const opts = resolveWith({ SPRITZ_RECEIVER_SOURCE_AUDIO: '0' }, { startSec: 12, receiver: true, receiverSubtitles: true });
  assert.equal(opts.receiverSubtitles, true);
  assert.equal(opts.sideloadSubs, true);
  assert.equal(opts.sourceSelectedAudio, false);
  assert.equal('receiverStartSec' in opts, false);
});

test('a non-receiver cast gets none of the receiver options', () => {
  const opts = resolveWith({}, undefined);
  assert.equal(opts.sideloadSubs, false);
  assert.equal(opts.receiverSubtitles, false);
  assert.equal(opts.sourceSelectedAudio, false);
  assert.equal('receiverStartSec' in opts, false);
  assert.equal('audioHint' in opts, false);
});
