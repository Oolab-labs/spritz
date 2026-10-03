'use strict';

// The gate between a receiver's reported position and the torrent's critical download window.
//
// The failure this exists to prevent is not a crash: it is the window being aimed somewhere the
// viewer is not, which looks exactly like a slow swarm. So most of these tests are about what must
// be REFUSED.

const { test } = require('node:test');
const assert = require('assert');
const { isTorrentSource, playheadFraction, playheadUpdate } = require('../src/main/receiver-playhead');

const TOR = 'http://127.0.0.1:51413/webtorrent/deadbeef/Film.mkv';

test('a torrent stream URL is recognised on either localhost spelling', () => {
  assert.equal(isTorrentSource(TOR), true);
  assert.equal(isTorrentSource('http://localhost:8080/webtorrent/ab/Film.mkv'), true);
  assert.equal(isTorrentSource('HTTP://LOCALHOST:8080/WEBTORRENT/ab/Film.mkv'), true);
});

test('anything that is not a webtorrent stream is not one', () => {
  assert.equal(isTorrentSource('file:///Users/x/Film.mkv'), false);
  assert.equal(isTorrentSource('http://192.168.1.9:5000/file/abcd'), false, 'the LAN server is not the torrent server');
  assert.equal(isTorrentSource('https://example.com/webtorrent/x.mkv'), false, 'https, and not localhost');
  assert.equal(isTorrentSource('http://127.0.0.1:5000/dlna/tok/video'), false);
  assert.equal(isTorrentSource(null), false);
  assert.equal(isTorrentSource(''), false);
});

test('a real reading becomes a fraction of the film', () => {
  assert.equal(playheadFraction({ cur: 3600, dur: 7200 }), 0.5);
  assert.equal(playheadFraction({ cur: 7200, dur: 7200 }), 1, 'the very end is still a real position');
});

test('a transitional zero never moves the window', () => {
  // The measured failure behind this: a Chromecast reports currentTime 0 while IDLE and BUFFERING.
  assert.equal(playheadFraction({ cur: 0, dur: 7200 }), null);
  assert.equal(playheadFraction({ cur: -5, dur: 7200 }), null);
});

test('a position with no duration is unusable', () => {
  // The critical window is sized in SECONDS of playback; without a length there is nothing to size.
  assert.equal(playheadFraction({ cur: 600, dur: 0 }), null);
  assert.equal(playheadFraction({ cur: 600, dur: null }), null);
  assert.equal(playheadFraction({ cur: 600 }), null);
});

test('a position past the end is stale, not a seek to the end', () => {
  assert.equal(playheadFraction({ cur: 7300, dur: 7200 }), null);
});

test('junk is refused rather than coerced', () => {
  assert.equal(playheadFraction({ cur: NaN, dur: 7200 }), null);
  assert.equal(playheadFraction({ cur: 'half way', dur: 7200 }), null);
  assert.equal(playheadFraction({ cur: 600, dur: NaN }), null);
  assert.equal(playheadFraction({}), null);
  assert.equal(playheadFraction(), null);
});

test('seeking BACKWARDS is a legitimate move, not a bad reading', () => {
  // Nothing here is monotonic: the viewer may jump back with the remote, and the window has to
  // follow. Only impossible readings are refused.
  assert.equal(playheadFraction({ cur: 60, dur: 7200 }), 60 / 7200);
});

test('an update is produced only for a torrent source', () => {
  const u = playheadUpdate({ source: TOR, cur: 1800, dur: 7200 });
  assert.deepEqual(u, { frac: 0.25, durationSec: 7200 });
});

test('casting a LOCAL file never aims an unrelated torrent window at it', () => {
  // There is one active torrent. A local file cast while it downloads is a different timeline, and
  // pointing the window at that timeline would starve the film someone is actually waiting for.
  assert.equal(playheadUpdate({ source: 'file:///Users/x/Other.mp4', cur: 1800, dur: 7200 }), null);
  assert.equal(playheadUpdate({ source: null, cur: 1800, dur: 7200 }), null);
});

test('a torrent source with an untrustworthy reading still yields nothing', () => {
  assert.equal(playheadUpdate({ source: TOR, cur: 0, dur: 7200 }), null);
  assert.equal(playheadUpdate({ source: TOR, cur: 1800, dur: 0 }), null);
});
