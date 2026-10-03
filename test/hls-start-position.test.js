'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadUrl, playlist } = require('../src/main/hls-start-position');
test('restart hints only affect live HLS and retain original URL credentials', () => {
  assert.equal(loadUrl('http://tv/file/token/a.mp4', 217), 'http://tv/file/token/a.mp4');
  const u = new URL(loadUrl('http://tv/hls/token/master.m3u8?key=abc', 217));
  assert.equal(u.searchParams.get('key'), 'abc'); assert.equal(u.searchParams.get('spritzStart'), '217');
});
test('hint reaches master and child playlists without altering media segment paths', () => {
  const src = '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nstream_0/index.m3u8\nseg0001.m4s\n';
  const result = playlist(src, 217);
  assert.equal((result.match(/#EXT-X-START:/g) || []).length, 1);
  assert.match(result, /TIME-OFFSET=217,PRECISE=YES/);
  assert.match(result, /stream_0\/index.m3u8\?spritzStart=217/);
  assert.match(result, /\nseg0001.m4s\n/);
  assert.equal(playlist(src, NaN), src);
});

test('replacement readiness waits for the requested clock and headroom, allowing a completed final segment', () => {
  const { coversPosition } = require('../src/main/hls-start-position');
  const first = '#EXTM3U\n#EXT-X-TARGETDURATION:20\n#EXTINF:6.0,\nseg0.m4s\n';
  assert.equal(coversPosition(first, 23.3), false);
  const grown = first + '#EXTINF:20,\nseg1.m4s\n';
  assert.equal(coversPosition(grown, 23.3), false);
  assert.equal(coversPosition(grown, 25), false);
  assert.equal(coversPosition(grown + '#EXT-X-ENDLIST\n', 25), true);
  assert.equal(coversPosition(grown + '#EXT-X-ENDLIST\n', 40), false);
  assert.equal(coversPosition(first, NaN), false);
});

test('unfinished start keeps three target durations of headroom', () => {
  const { coversPosition } = require('../src/main/hls-start-position');
  const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:30,\ns.m4s\n';
  assert.equal(coversPosition(manifest, 24), true);
  assert.equal(coversPosition(manifest, 24.3), false);
  assert.equal(coversPosition(manifest.replace('TARGETDURATION:2', 'TARGETDURATION:6'), 24), false);
  assert.equal(coversPosition(manifest.replace('#EXT-X-TARGETDURATION:2\n', ''), 0), false);
});
