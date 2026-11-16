'use strict';

// A VOD playlist written before anything is encoded. The project's notes concluded this was
// impractical because "finalizing races the encode" — but the duration is known from the probe, so
// the playlist is arithmetic and can be complete, with ENDLIST, before a single segment exists.

const test = require('node:test');
const assert = require('node:assert');
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
