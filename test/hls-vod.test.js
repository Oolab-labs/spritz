'use strict';

// A VOD playlist written before anything is encoded. The project's notes concluded this was
// impractical because "finalizing races the encode" — but the duration is known from the probe, so
// the playlist is arithmetic and can be complete, with ENDLIST, before a single segment exists.

const test = require('node:test');
const assert = require('node:assert');
const { planSegments, segmentSpan, buildVodPlaylist, buildMasterPlaylist } = require('../src/main/hls-vod');

const url = (i) => '/seg/' + i + '.ts';

test('a film divides into whole segments plus a short last one', () => {
  const p = planSegments(6941, 6);   // the 4K feature from the logs
  assert.equal(p.count, Math.ceil(6941 / 6));
  assert.equal(p.segmentSec, 6);
  assert.ok(p.lastSec > 0 && p.lastSec <= 6, 'the last segment is a real, non-zero length');
});

test('an exact multiple does not produce a zero-length tail', () => {
  // A zero-length final segment is a playlist some receivers reject outright.
  const p = planSegments(60, 6);
  assert.equal(p.count, 10);
  assert.equal(p.lastSec, 6);
});

test('each segment knows exactly which slice of the film it is', () => {
  const s = segmentSpan(3, 6941, 6);
  assert.equal(s.start, 18);
  assert.equal(s.duration, 6);
  assert.equal(s.last, false);
  // This is all an encoder needs: seek here, encode this long. Segments are independent, which is
  // what lets them be produced on demand and in whatever order the receiver asks.
});

test('the final segment is short and says so', () => {
  const p = planSegments(100, 6);
  const s = segmentSpan(p.count - 1, 100, 6);
  assert.equal(s.last, true);
  assert.ok(s.duration > 0 && s.duration <= 6);
  assert.equal(Math.round((s.start + s.duration) * 1000) / 1000, 100, 'the segments must cover the film exactly');
});

test('an out-of-range index is refused rather than encoded', () => {
  const p = planSegments(100, 6);
  assert.equal(segmentSpan(p.count, 100, 6), null);
  assert.equal(segmentSpan(-1, 100, 6), null);
  assert.equal(segmentSpan(1.5, 100, 6), null);
});

test('the playlist is complete and seekable the moment it is written', () => {
  const pl = buildVodPlaylist({ durationSec: 100, segmentSec: 6, urlFor: url });
  assert.match(pl, /^#EXTM3U/);
  assert.match(pl, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(pl, /#EXT-X-ENDLIST\n$/, 'ENDLIST is what makes it seekable rather than live');
  const segs = pl.split('\n').filter((l) => l.startsWith('/seg/'));
  assert.equal(segs.length, planSegments(100, 6).count);
});

test('the promised segment length is never shorter than a real one', () => {
  // A receiver may refuse a playlist whose segment exceeds TARGETDURATION.
  const pl = buildVodPlaylist({ durationSec: 100, segmentSec: 6, urlFor: url });
  const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(pl)[1]);
  const longest = Math.max(...[...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1])));
  assert.ok(target >= longest, `TARGETDURATION ${target} must be >= longest segment ${longest}`);
  assert.ok(Number.isInteger(target), 'and it must be an integer');
});

test('the segment times add up to the whole film', () => {
  const pl = buildVodPlaylist({ durationSec: 6941, segmentSec: 6, urlFor: url });
  const total = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  assert.ok(Math.abs(total - 6941) < 0.01, `segments total ${total}, film is 6941`);
});

test('nonsense in refuses rather than producing a broken playlist', () => {
  assert.equal(buildVodPlaylist({ durationSec: 0, urlFor: url }), null);
  assert.equal(buildVodPlaylist({ durationSec: -5, urlFor: url }), null);
  assert.equal(buildVodPlaylist({ durationSec: NaN, urlFor: url }), null);
  assert.equal(buildVodPlaylist({ durationSec: 100 }), null, 'no url builder, no playlist');
});

test('the master carries CODECS only when it can be stated truthfully', () => {
  // A guessed codec string is worse than none: a speculative one made AVPlayer reject the master
  // outright and AirPlay stopped working for days.
  const withCodecs = buildMasterPlaylist({ mediaUrl: '/m.m3u8', width: 1920, height: 1080, codecs: 'avc1.640028,mp4a.40.2' });
  assert.match(withCodecs, /CODECS="avc1\.640028,mp4a\.40\.2"/);
  assert.match(withCodecs, /RESOLUTION=1920x1080/);
  const without = buildMasterPlaylist({ mediaUrl: '/m.m3u8' });
  assert.ok(!/CODECS=/.test(without), 'no codecs claimed when none were supplied');
  assert.ok(!/RESOLUTION=/.test(without), 'and no resolution invented');
});

test('the master is single-rendition', () => {
  // Multi-rendition switching is what actually failed on this hardware, not HLS. A playlist with
  // one variant cannot switch.
  const pl = buildMasterPlaylist({ mediaUrl: '/m.m3u8', bandwidth: 20000000 });
  assert.equal((pl.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
});

test('a subtitle rendition is declared and linked from the variant', () => {
  const pl = buildMasterPlaylist({ mediaUrl: '/m.m3u8', subtitlesUrl: '/subs.m3u8' });
  assert.match(pl, /#EXT-X-MEDIA:TYPE=SUBTITLES.*URI="\/subs\.m3u8"/);
  assert.match(pl, /SUBTITLES="subs"/);
});

const { segmentsFromKeyframes, buildVodPlaylistFromSegments } = require('../src/main/hls-vod');

// The constraint that invalidated the first design, and only showed up against real ffmpeg: a stream
// copy can only be cut on a keyframe. Asking for "18s in, 6s long" on a fixture with keyframes every
// 10s returned a segment starting at 10s and lasting 14.21s — overlapping its neighbours and
// matching nothing the playlist promised. Boundaries must be the source's own keyframes.

test('segments land on keyframes, so a copy can actually cut there', () => {
  const segs = segmentsFromKeyframes([0, 10, 20, 30], 40, 6);
  assert.deepEqual(segs.map((s) => s.start), [0, 10, 20, 30]);
  // Not the 6s that was asked for — the keyframes decide, and HLS allows it via per-segment EXTINF.
  assert.deepEqual(segs.map((s) => s.duration), [10, 10, 10, 10]);
});

test('segments cover the film exactly, with no gap and no overlap', () => {
  const segs = segmentsFromKeyframes([0, 7, 13.5, 22, 28], 33, 6);
  for (let i = 1; i < segs.length; i++) {
    const prevEnd = Math.round((segs[i - 1].start + segs[i - 1].duration) * 1000) / 1000;
    assert.equal(prevEnd, segs[i].start, `segment ${i - 1} must end exactly where ${i} begins`);
  }
  const last = segs[segs.length - 1];
  assert.equal(Math.round((last.start + last.duration) * 1000) / 1000, 33);
});

test('keyframes closer together than the target are merged, not made into tiny segments', () => {
  // A film with a keyframe every second would otherwise produce thousands of one-second segments.
  const kf = Array.from({ length: 40 }, (_, i) => i);
  const segs = segmentsFromKeyframes(kf, 40, 6);
  assert.ok(segs.length <= 8, 'segments should be at least the target length, got ' + segs.length);
  for (const s of segs.slice(0, -1)) assert.ok(s.duration >= 6, 'each non-final segment reaches the target');
});

test('a missing leading keyframe is assumed, because a film starts at a cut', () => {
  const segs = segmentsFromKeyframes([10, 20], 30, 6);
  assert.equal(segs[0].start, 0);
});

test('a keyframe at the very end does not produce an empty final segment', () => {
  const segs = segmentsFromKeyframes([0, 10, 20, 30], 30, 6);
  for (const s of segs) assert.ok(s.duration > 0, 'no zero-length segment: ' + JSON.stringify(s));
});

test('unusable keyframe data refuses rather than guessing', () => {
  assert.equal(segmentsFromKeyframes(null, 40, 6), null);
  assert.equal(segmentsFromKeyframes([0, 10], 0, 6), null);
});

test('the keyframe-aligned playlist promises the longest segment it contains', () => {
  const segs = segmentsFromKeyframes([0, 7, 13.5, 22, 28], 33, 6);
  const pl = buildVodPlaylistFromSegments({ segments: segs, urlFor: (i) => '/s/' + i + '.ts' });
  const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(pl)[1]);
  const longest = Math.max(...segs.map((s) => s.duration));
  assert.ok(target >= longest, `TARGETDURATION ${target} >= longest ${longest}`);
  assert.match(pl, /#EXT-X-ENDLIST\n$/);
  assert.equal((pl.match(/\/s\/\d+\.ts/g) || []).length, segs.length);
});
