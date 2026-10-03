'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lan = require('../src/main/lanserver');

// The cast pipe is fragmented MP4, and the MP4 muxer zeroes the timeline at the first packet it writes
// whatever -copyts says (measured: -ss 4 -copyts, output starts at 0.000). So the receiver's clock
// counts from the START OF THE STREAM, not from the start of the film. A cast resumed at 1:10:00 that
// reported 12 s meant 1:10:12, and sideloaded subtitles whose cues were stamped file-absolute showed
// up an hour late. The stream's zero is the keyframe it starts on; these helpers find it.

test('lastKeyframeAtOrBefore picks the nearest keyframe not after the target', () => {
  const csv = ['10.500000,K__', '10.750000,___', '11.000000,___', '12.000000,K__', '12.250000,___', '14.000000,K__'].join('\n');
  assert.strictEqual(lan.lastKeyframeAtOrBefore(csv, 12.5), 12);
  assert.strictEqual(lan.lastKeyframeAtOrBefore(csv, 12), 12, 'a keyframe exactly on the target counts');
  assert.strictEqual(lan.lastKeyframeAtOrBefore(csv, 11.9), 10.5);
  assert.strictEqual(lan.lastKeyframeAtOrBefore(csv, 99), 14);
});

test('lastKeyframeAtOrBefore says null when it cannot know', () => {
  assert.strictEqual(lan.lastKeyframeAtOrBefore('', 5), null);
  assert.strictEqual(lan.lastKeyframeAtOrBefore('1.0,___\n2.0,___', 5), null, 'no keyframe in the window');
  assert.strictEqual(lan.lastKeyframeAtOrBefore('20.0,K__', 5), null, 'only keyframes after the target');
  assert.strictEqual(lan.lastKeyframeAtOrBefore('N/A,K__\nabc,K__\n,K__', 5), null, 'garbage lines are ignored');
  assert.strictEqual(lan.lastKeyframeAtOrBefore(null, 5), null);
});

test('lastKeyframeAtOrBefore reads the flag, wherever K sits in it', () => {
  assert.strictEqual(lan.lastKeyframeAtOrBefore('3.0,_K_', 4), 3);
  assert.strictEqual(lan.lastKeyframeAtOrBefore('3.0,K_', 4), 3);
});

test('castSeekArgs lands safely past the keyframe', () => {
  // Measured on a file whose keyframe sits at 93.75: -ss 93.75 .. 93.85 landed on the keyframe BEFORE
  // it (ffmpeg compares against the reordered DTS), and only 93.9 landed on it. A seek that lands a
  // keyframe early starts the stream 10 s before the origin we computed.
  assert.deepStrictEqual(lan.castSeekArgs(0), []);
  assert.deepStrictEqual(lan.castSeekArgs(null), []);
  assert.deepStrictEqual(lan.castSeekArgs(12.012), ['-ss', '12.512']);
  assert.ok(!lan.castSeekArgs(5).includes('-copyts'), 'no -copyts: the muxer zeroes the clock anyway, and the origin is added back by the app');
});

test('keyframeProbeArgs reads a bounded window ending at the target', () => {
  const a = lan.keyframeProbeArgs('/f.mkv', 100);
  const i = a.indexOf('-read_intervals');
  assert.ok(i >= 0);
  const [from, to] = a[i + 1].split('%').map(Number);
  assert.ok(to > 100 && to <= 102, 'the window must reach PAST the target, or a keyframe exactly on it is excluded');
  assert.ok(from >= 70 && from < 100, 'a window wide enough to hold a long GOP, not the whole film');
  assert.ok(lan.keyframeProbeArgs('/f.mkv', 5)[lan.keyframeProbeArgs('/f.mkv', 5).indexOf('-read_intervals') + 1].startsWith('0%'), 'never negative');
  assert.strictEqual(a[a.length - 1], '/f.mkv');
});

test('the pipe never starts a track before zero', () => {
  // With -ss on a copy, the video starts at the keyframe and the audio at the seek point, so the video
  // track begins with negative timestamps. An LG Cast receiver played audio-only or video-only streams
  // like that to the end but stalled the combined stream 12-23 s in. -avoid_negative_ts make_zero
  // shifts both tracks so the earliest is zero, keeping them in step, and the stream played to the end.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'lanserver.js'), 'utf8');
  const body = src.slice(src.indexOf('function mkvArgs('), src.indexOf('// serveMkv(input, opts, cb)'));
  assert.ok((body.match(/CAST_HYGIENE/g) || []).length >= 2, 'both the burn-in and the plain branch use the shared hygiene flags');
  assert.ok(lan.CAST_HYGIENE.join(' ').includes('-avoid_negative_ts make_zero'));
});

test('subtitle cues are cut from the origin itself, not from the margin the video seek adds', () => {
  // The video seek lands past the keyframe (castSeekArgs) but the stream's zero is the keyframe; cues cut
  // from the seek point would all show half a second early.
  assert.deepStrictEqual(lan.subSeekArgs(0), []);
  assert.deepStrictEqual(lan.subSeekArgs(null), []);
  assert.deepStrictEqual(lan.subSeekArgs(135.417), ['-ss', '135.417']);
  assert.notDeepStrictEqual(lan.subSeekArgs(135.417), lan.castSeekArgs(135.417));
});
