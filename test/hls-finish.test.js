'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { finishedVariant } = require('../src/main/hls-finish');

// An LG webOS AirPlay receiver played Apple's reference stream (a complete VOD playlist) but not ours: ours
// stayed an open EVENT playlist, with no #EXT-X-ENDLIST, even after ffmpeg had written the whole film, so
// the TV treated it as live. Once the producer has exited cleanly and every segment is accounted for, the
// playlist is finished and must say so.
const playlist = (segs, extra = '') => ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init_0.mp4"',
  ...segs.flatMap((d, i) => ['#EXTINF:' + d.toFixed(6) + ',', 'seg' + String(i).padStart(5, '0') + '.m4s']), extra, ''].filter((l, i, a) => !(l === '' && i < a.length - 1)).join('\n');

test('a fully written EVENT playlist becomes a finished VOD one', () => {
  const text = playlist([10, 10, 10, 10]);
  const out = finishedVariant(text, 40, 0, null);
  assert.ok(/^#EXT-X-PLAYLIST-TYPE:VOD$/m.test(out));
  assert.ok(!/EVENT/.test(out));
  assert.ok(/#EXT-X-ENDLIST\s*$/.test(out));
  assert.ok(out.includes('seg00003.m4s'), 'every segment survives');
});

test('allows the small disagreement between container duration and segment sum, not a missing segment', () => {
  assert.ok(finishedVariant(playlist([10, 10, 10, 10.5]), 40, 0, null), 'audio padding / rounding');
  assert.strictEqual(finishedVariant(playlist([10, 10, 10]), 40, 0, null), null, 'a whole segment short');
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10, 10, 10]), 40, 0, null), null, 'far longer than the film');
});

test('never finishes a playlist whose producer did not exit cleanly', () => {
  const text = playlist([10, 10, 10, 10]);
  assert.strictEqual(finishedVariant(text, 40, 1, null), null);
  assert.strictEqual(finishedVariant(text, 40, null, 'SIGKILL'), null);
  assert.strictEqual(finishedVariant(text, 40, undefined, null), null, 'still running');
});

test('leaves alone what it cannot be sure of', () => {
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10], '#EXT-X-ENDLIST'), 40, 0, null), null, 'already finished');
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10]).replace('EVENT', 'VOD'), 40, 0, null), null, 'not an event playlist');
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10]), NaN, 0, null), null, 'unknown duration');
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10]), 0, 0, null), null);
  assert.strictEqual(finishedVariant('', 40, 0, null), null);
  assert.strictEqual(finishedVariant(null, 40, 0, null), null);
  assert.strictEqual(finishedVariant(playlist([10, 10, 10, 10]).replace(/seg00003\.m4s\n?$/, ''), 40, 0, null), null, 'last segment line cut off');
});

test('the server serves finished playlists once the producer has exited', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'lanserver.js'), 'utf8');
  const serve = src.slice(src.indexOf('function serveHlsFile('), src.indexOf('function deliverFile('));
  assert.ok(/hlsFinish/.test(serve) && /finishedVariant\(/.test(serve));
  assert.ok(serve.indexOf('const start = ') < serve.indexOf('finishedVariant('), 'it must come after `start` is defined');
  assert.ok(/hlsFinish = \{ token: tok/.test(src), 'the producer exit records it');
});
