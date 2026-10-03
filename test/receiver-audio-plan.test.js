'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectSourceAudio } = require('../src/main/receiver-audio-plan');
const source = { vcodec: 'hevc', width: 3840, height: 2160, audio: [
  { idx: 0, name: 'English commentary', lang: 'eng', codec: 'aac', channels: 2 },
  { idx: 1, name: 'English original', lang: 'eng', codec: 'dts', channels: 6 }
] };
test('selected source codec and channels drive planning without losing source choices', () => {
  const plan = selectSourceAudio(source, 1);
  assert.equal(plan.index, 1);
  assert.deepEqual(plan.info.audio, [source.audio[1]]);
  assert.equal(plan.info.height, 2160);
  assert.deepEqual(plan.catalog.map(t => [t.id, t.selected]), [['source-audio-0', false], ['source-audio-1', true]]);
  assert.equal(plan.catalog[1].title, 'English original');
  assert.equal(source.audio.length, 2);
});
test('source ordinal is not its array position or native track index', () => {
  const plan = selectSourceAudio({ audio: [{ idx: 3, codec: 'aac' }] }, 3);
  assert.equal(plan.index, 3);
  assert.equal(plan.catalog[0].id, 'source-audio-3');
  assert.throws(() => selectSourceAudio({ audio: [{ idx: 3 }] }, 0), /unavailable/);
});
test('explicit selection requires a verified inventory and valid source ordinal', () => {
  for (const index of [-1, 32, 1.5, '1', NaN]) assert.throws(() => selectSourceAudio(source, index), /Invalid/);
  assert.throws(() => selectSourceAudio(null, 1), /inventory unavailable/);
  assert.throws(() => selectSourceAudio(source, 2), /unavailable/);
  assert.equal(selectSourceAudio(null).index, 0);
});

test('near-position preparation falls back to zero for unqualified sources', () => {
  const { nearInputStart } = require('../src/main/receiver-audio-plan');
  assert.equal(nearInputStart(100, 3000, false), 100);
  assert.equal(nearInputStart(100, 3000, true), 0);
  assert.equal(nearInputStart(100, null, false), 0);
  assert.equal(nearInputStart(100, 50, false), 0);
  assert.equal(nearInputStart(NaN, 3000, false), 0);
});

// The first cast must start on the language the Mac is playing. mpv's aid is 1-based per type and
// FFmpeg's 0:a:N is 0-based, so the ordinal is aid - 1.
test('audioOrdinalFromAid maps mpv aid to a source audio ordinal, or null when there is no explicit track', () => {
  const { audioOrdinalFromAid } = require('../src/main/receiver-audio-plan');
  assert.strictEqual(audioOrdinalFromAid('2'), 1);
  assert.strictEqual(audioOrdinalFromAid(1), 0);
  for (const v of ['auto', 'no', '', null, undefined, '0', '-1', '1.5', 'x']) assert.strictEqual(audioOrdinalFromAid(v), null, String(v));
});

test('a first-cast hint selects that track when the source has it', () => {
  const { selectSourceAudio } = require('../src/main/receiver-audio-plan');
  const info = { audio: [{ idx: 0, lang: 'eng' }, { idx: 1, lang: 'fra' }] };
  const r = selectSourceAudio(info, null, 1);
  assert.strictEqual(r.index, 1);
  assert.ok(r.catalog.find(t => t.id === 'source-audio-1').selected);
});

test('a hint the source lacks (external audio, stale id) falls back to track 0 instead of failing the cast', () => {
  const { selectSourceAudio } = require('../src/main/receiver-audio-plan');
  assert.strictEqual(selectSourceAudio({ audio: [{ idx: 0 }, { idx: 1 }] }, null, 7).index, 0);
  assert.strictEqual(selectSourceAudio({ audio: [] }, null, 1).index, 0);
});

test('an explicit request is still strict and wins over the hint', () => {
  const { selectSourceAudio } = require('../src/main/receiver-audio-plan');
  const info = { audio: [{ idx: 0 }, { idx: 1 }] };
  assert.strictEqual(selectSourceAudio(info, 0, 1).index, 0);
  assert.throws(() => selectSourceAudio(info, 5, 1), /unavailable/);
});
