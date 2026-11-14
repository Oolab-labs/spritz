'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {completedPlaylist}=require('../src/main/receiver-hls-finalize');
const text='#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000,\nseg0.m4s\n#EXTINF:1.968,\nseg1.m4s\n';
test('clean, complete receiver presentation adds only ENDLIST',()=>{
  assert.equal(completedPlaylist(text,4.021,0,null),text+'#EXT-X-ENDLIST\n');
  assert.equal(completedPlaylist(text+'#EXT-X-ENDLIST\n',4.021,0,null),null);
});
test('failed, killed, unknown and truncated productions cannot advertise completion',()=>{
  for(const [duration,code,signal] of [[4.021,1,null],[4.021,0,'SIGTERM'],[4.021,null,null],[NaN,0,null],[0,0,null],[60,0,null],[1,0,null]])
    assert.equal(completedPlaylist(text,duration,code,signal),null);
});
test('unfinished segment entries and nonmedia playlists cannot advertise completion',()=>{
  for(const body of [text+'#EXTINF:2.000,\n',text.replace('seg1.m4s','#comment'),text.replace('1.968','bad'),text.replace('EVENT','VOD')])
    assert.equal(completedPlaylist(body,4.021,0,null),null);
});

// The AirPlay serve path (lanserver serveHlsFile) asks for { vod: true }. An LG webOS AirPlay receiver played
// Apple's reference stream (a complete VOD playlist) but not ours: ours stayed an open EVENT playlist, with no
// #EXT-X-ENDLIST, even after ffmpeg had written the whole film, so the TV treated it as live. Once the producer
// has exited cleanly and every segment is accounted for, the playlist is finished and must say so. The receiver
// path calls without the option and keeps EVENT on disk (above).
const playlist = (segs, extra = '') => ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init_0.mp4"',
  ...segs.flatMap((d, i) => ['#EXTINF:' + d.toFixed(6) + ',', 'seg' + String(i).padStart(5, '0') + '.m4s']), extra, ''].filter((l, i, a) => !(l === '' && i < a.length - 1)).join('\n');
const vod = (text, duration, code, signal) => completedPlaylist(text, duration, code, signal, { vod: true });

test('vod: a fully written EVENT playlist becomes a finished VOD one', () => {
  const out = vod(playlist([10, 10, 10, 10]), 40, 0, null);
  assert.ok(/^#EXT-X-PLAYLIST-TYPE:VOD$/m.test(out));
  assert.ok(!/EVENT/.test(out));
  assert.ok(/#EXT-X-ENDLIST\s*$/.test(out));
  assert.ok(out.includes('seg00003.m4s'), 'every segment survives');
});

test('vod: allows the small disagreement between container duration and segment sum, not a missing segment', () => {
  assert.ok(vod(playlist([10, 10, 10, 10.5]), 40, 0, null), 'audio padding / rounding');
  assert.strictEqual(vod(playlist([10, 10, 10]), 40, 0, null), null, 'a whole segment short');
  assert.strictEqual(vod(playlist([10, 10, 10, 10, 10, 10]), 40, 0, null), null, 'far longer than the film');
});

test('vod: never finishes a playlist whose producer did not exit cleanly', () => {
  const text = playlist([10, 10, 10, 10]);
  assert.strictEqual(vod(text, 40, 1, null), null);
  assert.strictEqual(vod(text, 40, null, 'SIGKILL'), null);
  assert.strictEqual(vod(text, 40, undefined, null), null, 'still running');
});

test('vod: leaves alone what it cannot be sure of', () => {
  assert.strictEqual(vod(playlist([10, 10, 10, 10], '#EXT-X-ENDLIST'), 40, 0, null), null, 'already finished');
  assert.strictEqual(vod(playlist([10, 10, 10, 10]).replace('EVENT', 'VOD'), 40, 0, null), null, 'not an event playlist');
  assert.strictEqual(vod(playlist([10, 10, 10, 10]), NaN, 0, null), null, 'unknown duration');
  assert.strictEqual(vod(playlist([10, 10, 10, 10]), 0, 0, null), null);
  assert.strictEqual(vod('', 40, 0, null), null);
  assert.strictEqual(vod(null, 40, 0, null), null);
  assert.strictEqual(vod(playlist([10, 10, 10, 10]).replace(/seg00003\.m4s\n?$/, ''), 40, 0, null), null, 'last segment line cut off');
});

test('a non-string playlist is not complete, with or without vod', () => {
  assert.strictEqual(completedPlaylist(null, 40, 0, null), null);
  assert.strictEqual(completedPlaylist(undefined, 40, 0, null), null);
});

test('the server serves finished playlists once the producer has exited', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'lanserver.js'), 'utf8');
  const serve = src.slice(src.indexOf('function serveHlsFile('), src.indexOf('function deliverFile('));
  assert.ok(/hlsFinish/.test(serve) && /completedPlaylist\([^;]*\{ vod: true \}\)/.test(serve));
  assert.ok(serve.indexOf('const start = ') < serve.indexOf('completedPlaylist('), 'it must come after `start` is defined');
  assert.ok(/hlsFinish = \{ token: tok/.test(src), 'the producer exit records it');
});
