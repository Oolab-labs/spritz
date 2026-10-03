'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lan = require('../src/main/lanserver');

// A multi-audio source with NO subtitle tracks. ffmpeg writes the master; it carries RESOLUTION and
// CODECS, which AVFoundation refuses (status=failed, EMPTY error log). Observed on a 10-minute
// two-audio H.264 file: the AirPlay pre-warm item failed on every attempt. The reduction used to be
// applied only when subtitle renditions were being injected.
const FFMPEG_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="eng",CHANNELS="1",URI="stream_1/index.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_2",DEFAULT=NO,LANGUAGE="spa",CHANNELS="1",URI="stream_2/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4167081,AVERAGE-BANDWIDTH=3980001,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"',
  'stream_0/index.m3u8', ''].join('\n');

test('a multi-audio master with no subtitles is reduced to the shape AVFoundation accepts', () => {
  const out = lan.minimalMaster(FFMPEG_MASTER);
  assert.ok(!/RESOLUTION|CODECS/.test(out), 'the picture description must be gone');
  assert.ok(/BANDWIDTH=4167081/.test(out) && /AUDIO="group_aud"/.test(out));
  assert.ok(/stream_0\/index\.m3u8/.test(out), 'the variant URI survives');
  assert.strictEqual((out.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length, 2, 'both audio renditions survive');
});

test('reducing twice changes nothing', () => {
  const once = lan.minimalMaster(FFMPEG_MASTER);
  assert.strictEqual(lan.minimalMaster(once), once);
});
