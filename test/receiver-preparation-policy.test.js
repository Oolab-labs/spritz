'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceWaiting, stallAction } = require('../src/main/receiver-preparation-policy');
const source = 'http://localhost:1234/webtorrent/media';
const context = { source, generation: 3, now: 10000 };
const sample = { source, generation: 3, at: 9000, health: { known: true, sustainable: false, secondsBuffered: 0 } };
test('only fresh current torrent starvation can suppress recovery', () => {
  assert.equal(sourceWaiting(sample, context), true);
  for (const change of [{ generation: 2 }, { source: 'other' }, { at: 4000 }, { at: 11000 }, { health: null },
    { health: { known: false, sustainable: false, secondsBuffered: 0 } },
    { health: { known: true, sustainable: true, secondsBuffered: 0 } },
    { health: { known: true, sustainable: false, secondsBuffered: 2 } }]) {
    assert.equal(sourceWaiting({ ...sample, ...change }, context), false);
  }
  assert.equal(sourceWaiting(sample, { ...context, source: '/movie.mkv' }), false);
});
test('starved preparation waits only inside the original bounded budget', () => {
  assert.equal(stallAction({ sourceWaiting: true, category: 'no-output', elapsedMs: 25001 }), 'wait');
  assert.equal(stallAction({ sourceWaiting: true, category: 'no-output', elapsedMs: 60000 }), 'expire');
  assert.equal(stallAction({ sourceWaiting: false, category: 'no-output', elapsedMs: 25001 }), 'recover');
  for (const category of ['timestamp-or-mux-error', 'conversion-error', 'source-request-error', 'probe-or-demux-error', 'process-failed']) {
    assert.equal(stallAction({ sourceWaiting: true, category, elapsedMs: 25001 }), 'recover');
  }
});

// One definition of "this is a torrent stream" (receiver-playhead's isTorrentSource). torrent.js always
// serves 'http://localhost:' + port + '/webtorrent/...', so a portless URL is not one, here or anywhere.
const { isTorrentSource } = require('../src/main/receiver-playhead');
test('torrent starvation applies exactly to what isTorrentSource calls a torrent stream', () => {
  for (const url of ['http://localhost:1234/webtorrent/media', 'http://127.0.0.1:40123/webtorrent/ab/Film.mkv',
    'HTTP://LOCALHOST:8080/WEBTORRENT/ab/Film.mkv', 'http://localhost/webtorrent/media', 'http://127.0.0.1/webtorrent/x',
    'http://192.168.1.9:5000/webtorrent/x', 'https://localhost:1234/webtorrent/x', '/movie.mkv']) {
    assert.equal(sourceWaiting({ ...sample, source: url }, { ...context, source: url }), isTorrentSource(url), url);
  }
});
test('lanserver gates its owned torrent source on the same check', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/main/lanserver.js'), 'utf8');
  assert.match(src, /registerSourceProducer === 'function' &&\s*isTorrentSource\(input\)/);
});
