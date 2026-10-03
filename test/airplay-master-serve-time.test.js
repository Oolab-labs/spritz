'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lan = require('../src/main/lanserver');

// ffmpeg rewrites master.m3u8 after it has measured the first segments' bandwidth, which overwrites any
// patch applied once at announce time. On a long film the rewrite lands after our patch, so AVFoundation
// got ffmpeg's master (RESOLUTION/CODECS, no subtitle group) and refused it, while a 60 s clip finished
// before the rewrite and worked. The shape is therefore applied when the file is SERVED.
const RAW = [
  '#EXTM3U', '#EXT-X-VERSION:7',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="eng",CHANNELS="1",URI="stream_1/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4167081,AVERAGE-BANDWIDTH=3980001,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"',
  'stream_0/index.m3u8', ''].join('\n');
const SUBS = [{ pl: 'sub_0_eng.m3u8', lang: 'eng', name: 'ENG' }, { pl: 'sub_1_spa.m3u8', lang: 'spa', name: 'SPA' }];

test('with subtitle renditions the served master carries them and the reduced stream line', () => {
  const out = lan.servedMaster(RAW, { subEntries: SUBS });
  assert.strictEqual((out.match(/TYPE=SUBTITLES/g) || []).length, 2);
  assert.ok(/SUBTITLES="subs"/.test(out));
  assert.ok(!/RESOLUTION|CODECS/.test(out));
  assert.ok(out.indexOf('TYPE=SUBTITLES') > out.indexOf('#EXT-X-VERSION'), 'after the version tag');
});

test('without subtitle renditions it is only reduced', () => {
  const out = lan.servedMaster(RAW, { subEntries: [] });
  assert.ok(!/RESOLUTION|CODECS|SUBTITLES/.test(out));
  assert.ok(/AUDIO="group_aud"/.test(out) && /stream_0\/index\.m3u8/.test(out));
});

test('serving is idempotent, so an unrewritten master is not mangled twice', () => {
  const once = lan.servedMaster(RAW, { subEntries: SUBS });
  assert.strictEqual(lan.servedMaster(once, { subEntries: SUBS }), once);
});

test('a session that is not shaped (the receiver) is served untouched', () => {
  assert.strictEqual(lan.servedMaster(RAW, null), RAW);
});

test('a master cut off mid-write is recognised, and a patched-then-truncated one is regenerated', () => {
  // Observed: the first fetch landed 75 ms after announce on a file holding our subtitle lines and the
  // audio lines but NO stream line, because the earlier one-shot patch had read ffmpeg's master while it
  // was still being written and written the fragment back. AVFoundation refused it outright.
  assert.strictEqual(lan.isCompleteMaster(RAW), true);
  const cut = RAW.slice(0, RAW.indexOf('#EXT-X-STREAM-INF'));
  assert.strictEqual(lan.isCompleteMaster(cut), false, 'no stream line');
  assert.strictEqual(lan.isCompleteMaster(RAW.slice(0, RAW.indexOf('stream_0') + 6)), false, 'URI cut mid-name');
  assert.strictEqual(lan.isCompleteMaster(RAW.replace(/\nstream_0\/index\.m3u8\n$/, '\n')), false, 'stream line without its URI');
  assert.strictEqual(lan.isCompleteMaster(''), false);
});

test('stale subtitle lines already in the file never survive: the shape is rebuilt from the entries', () => {
  const stale = lan.servedMaster(RAW, { subEntries: [{ pl: 'old.m3u8', lang: 'eng', name: 'OLD' }] });
  const out = lan.servedMaster(stale, { subEntries: SUBS });
  assert.ok(!/OLD/.test(out), 'the old rendition is gone');
  assert.strictEqual((out.match(/TYPE=SUBTITLES/g) || []).length, 2);
  assert.strictEqual((out.match(/SUBTITLES="subs"/g) || []).length, 1, 'one reference on the stream line, not two');
});

test('serveHlsFile shapes master.m3u8 at serve time', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'lanserver.js'), 'utf8');
  const body = src.slice(src.indexOf('function serveHlsFile('), src.indexOf('function deliverFile('));
  assert.ok(/servedMaster\(/.test(body) && /master\.m3u8/.test(body));
});

// ffmpeg writes the master in two steps. First only the audio renditions (276 bytes in the field), and the
// stream line only once it has measured the video, which on a source that arrives slowly (a torrent) was
// more than a minute after the player needed it. The variant is always stream_0, so the line is synthesised.
const PARTIAL = [
  '#EXTM3U', '#EXT-X-VERSION:7',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="eng",CHANNELS="1",URI="stream_1/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_2",DEFAULT=NO,LANGUAGE="spa",CHANNELS="1",URI="stream_2/index.m3u8"', ''].join('\n');

test('a master that has the audio renditions but no stream line yet is completed, not waited for', () => {
  assert.strictEqual(lan.isCompleteMaster(PARTIAL), false);
  assert.strictEqual(lan.canSynthesizeMaster(PARTIAL), true);
  const out = lan.servedMaster(PARTIAL, { subEntries: SUBS, bandwidth: 5000000 });
  assert.ok(/#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="group_aud",SUBTITLES="subs"\nstream_0\/index\.m3u8\n$/.test(out), out);
  assert.strictEqual(lan.isCompleteMaster(out), true);
});

test('without subtitles the synthesised stream line carries only the audio group, with a default bandwidth', () => {
  const out = lan.servedMaster(PARTIAL, { subEntries: [] });
  assert.ok(/#EXT-X-STREAM-INF:BANDWIDTH=\d{6,},AUDIO="group_aud"\nstream_0\/index\.m3u8/.test(out), out);
  assert.ok(!/SUBTITLES/.test(out));
});

test('nothing to build from yet means wait', () => {
  assert.strictEqual(lan.canSynthesizeMaster('#EXTM3U\n#EXT-X-VERSION:7\n'), false);
  assert.strictEqual(lan.canSynthesizeMaster(''), false);
  assert.strictEqual(lan.canSynthesizeMaster(RAW), true, 'a complete one trivially can');
});
