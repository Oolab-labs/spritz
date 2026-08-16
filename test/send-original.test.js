'use strict';

// The fast path skips ffmpeg entirely, so every guard here is protecting against sending a receiver
// something it cannot play — with no transcoder in the way to notice. False negatives cost a little
// CPU; a false positive is a black screen.

const test = require('node:test');
const assert = require('node:assert');
const { canSendOriginal } = require('../src/main/send-original');

const okPlan = { video: 'copy', speculative: false, stripDovi: false, tonemap: false, audioTracks: [{ action: 'copy' }] };
const okInfo = { vcodec: 'h264', width: 1920, height: 1080, audio: [{ codec: 'aac' }] };
const okOpts = { input: '/movies/Film.mp4', remote: false, audioTrack: 0, burnSub: null };

const why = (r) => r.why || '';

test('a plain H.264 MP4 that needs nothing done goes untouched', () => {
  const r = canSendOriginal(okPlan, okInfo, okOpts);
  assert.equal(r.ok, true, why(r));
});

test('HEVC in MP4 also goes untouched', () => {
  const r = canSendOriginal(okPlan, Object.assign({}, okInfo, { vcodec: 'hevc' }), okOpts);
  assert.equal(r.ok, true, why(r));
});

test('a streamed torrent is refused — it is not a complete file on disk', () => {
  const r = canSendOriginal(okPlan, okInfo, Object.assign({}, okOpts, { remote: true }));
  assert.equal(r.ok, false);
  assert.match(r.why, /streamed/);
});

test('MKV is refused, on evidence rather than caution', () => {
  // Tried against this receiver twice, with two different codecs inside, and refused both times.
  const r = canSendOriginal(okPlan, okInfo, Object.assign({}, okOpts, { input: '/movies/Film.mkv' }));
  assert.equal(r.ok, false);
  assert.match(r.why, /container/);
});

test('anything that would change a byte is refused', () => {
  const cases = [
    [{ video: 'transcode' }, /re-encoded/],
    [{ stripDovi: true }, /Dolby Vision/],
    [{ tonemap: true }, /tone-mapped/],
    [{ speculative: true }, /inconclusive/]
  ];
  for (const [patch, rx] of cases) {
    const r = canSendOriginal(Object.assign({}, okPlan, patch), okInfo, okOpts);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.why, rx);
  }
});

test('a burned-in subtitle is refused', () => {
  const r = canSendOriginal(okPlan, okInfo, Object.assign({}, okOpts, { burnSub: 2 }));
  assert.equal(r.ok, false);
  assert.match(r.why, /burned in/);
});

test('a chosen non-default audio track is refused', () => {
  // Sending the file whole sends every track and lets the receiver pick. If the viewer asked for a
  // particular language, only ffmpeg can honour that.
  const info = { vcodec: 'h264', audio: [{ codec: 'aac' }, { codec: 'ac3' }] };
  const r = canSendOriginal(okPlan, info, Object.assign({}, okOpts, { audioTrack: 1 }));
  assert.equal(r.ok, false);
  assert.match(r.why, /audio track/);
});

test('several audio tracks are refused even at the default, because the receiver chooses', () => {
  const info = { vcodec: 'h264', audio: [{ codec: 'aac' }, { codec: 'ac3' }] };
  const r = canSendOriginal(okPlan, info, okOpts);
  assert.equal(r.ok, false);
  assert.match(r.why, /several audio tracks/);
});

test('an undecodable codec is refused in either stream', () => {
  const v = canSendOriginal(okPlan, Object.assign({}, okInfo, { vcodec: 'vp9' }), okOpts);
  assert.equal(v.ok, false);
  assert.match(v.why, /video codec vp9/);
  const a = canSendOriginal(okPlan, { vcodec: 'h264', audio: [{ codec: 'truehd' }] }, okOpts);
  assert.equal(a.ok, false);
  assert.match(a.why, /audio codec truehd/);
});

test('the plan overrules the codec list on whether audio survives', () => {
  // AC3 is directly playable in principle, but if the plan says it is being converted for this
  // receiver then the file as it stands is not what the receiver would get.
  const plan = Object.assign({}, okPlan, { audioTracks: [{ action: 'transcode' }] });
  const r = canSendOriginal(plan, { vcodec: 'h264', audio: [{ codec: 'ac3' }] }, okOpts);
  assert.equal(r.ok, false);
  assert.match(r.why, /audio has to be converted/);
});

test('missing inputs refuse rather than assume', () => {
  assert.equal(canSendOriginal(null, okInfo, okOpts).ok, false);
  assert.equal(canSendOriginal(okPlan, null, okOpts).ok, false);
  assert.equal(canSendOriginal(okPlan, okInfo, {}).ok, false);
});

test('every refusal explains itself', () => {
  // "We did not take the fast path" is otherwise indistinguishable from "there is no fast path".
  const r = canSendOriginal(okPlan, okInfo, Object.assign({}, okOpts, { input: '/x.mkv' }));
  assert.ok(r.why && r.why.length > 10);
});
