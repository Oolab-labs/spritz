'use strict';
// A master playlist's subtitle renditions are on the critical path to the first frame: AVPlayer
// fetches every rendition it names before it will start. A release with eighteen text tracks failed
// to load at all — CoreMediaErrorDomain -16839, "Unable to get playlist before long download timer"
// — while the same master loaded once the session had settled, which is what made it look random.
// The cast path already had this lesson (MAX_REMOTE_SIDELOAD_SUBS); these pin it for AirPlay too.
const test = require('node:test');
const assert = require('node:assert');
const { capSubSources, MAX_REMOTE_SIDELOAD_SUBS } = require('../src/main/lanserver');

const track = (lang, name) => ({ idx: 0, lang, name: name || lang.toUpperCase() });

test('a streamed source never advertises more renditions than the cap', () => {
  const many = ['eng', 'cze', 'dan', 'ger', 'spa', 'fin', 'fre', 'hun', 'ita', 'kor', 'nob', 'dut', 'pol', 'por', 'swe', 'jpn', 'rus', 'tur'].map((l) => track(l));
  assert.strictEqual(many.length, 18);
  assert.strictEqual(capSubSources(many).length, MAX_REMOTE_SIDELOAD_SUBS);
});

// The rule these used to pin — ONE rendition per language, first occurrence wins — was wrong, and
// wrong in a way that looked like subtitles being broken. Measured on a real release: three English
// tracks, and the first is signs-only (103 cues across 108 minutes) while the two real dialogue
// tracks (903 and 1257 cues) were dropped before reaching the menu. Nothing in the metadata separates
// them — forced=0 on all three, no titles, and default=1 is set on the SIGNS track — so no automatic
// rule can choose correctly. The budget now goes to the primary language in full, then one per other
// language, and the viewer picks. Under the cap nothing is dropped at all.
test('a second track of the primary language is kept, not discarded', () => {
  const many = [track('eng', 'Signs'), track('eng', 'Dialogue'), track('eng', 'SDH')];
  for (const l of ['cze', 'dan', 'ger', 'spa', 'fin', 'fre', 'hun', 'ita']) many.push(track(l));
  const kept = capSubSources(many);
  assert.strictEqual(kept.filter((s) => s.lang === 'eng').length, 3, 'all three English tracks survive');
  assert.strictEqual(kept.length, MAX_REMOTE_SIDELOAD_SUBS);
});

test('secondary languages still get exactly one slot each', () => {
  const many = [track('eng')];
  for (const l of ['cze', 'cze', 'dan', 'dan', 'ger', 'spa', 'fin', 'fre', 'hun', 'ita']) many.push(track(l));
  const kept = capSubSources(many);
  assert.strictEqual(kept.filter((s) => s.lang === 'cze').length, 1);
  assert.strictEqual(kept.filter((s) => s.lang === 'dan').length, 1);
});

test('language matching ignores case for secondary languages', () => {
  const many = [track('eng')];
  for (const l of ['CZE', 'cze', 'dan', 'ger', 'spa', 'fin', 'fre', 'hun', 'ita']) many.push(track(l));
  const kept = capSubSources(many);
  assert.strictEqual(kept.filter((s) => String(s.lang).toLowerCase() === 'cze').length, 1);
});

test('a list within the cap keeps every track, including duplicate languages', () => {
  // Extraction is on-demand now, so an unselected rendition costs a 52-byte stub. If it fits, offer it.
  const few = [track('eng', 'Signs'), track('eng', 'Dialogue'), track('cze')];
  assert.deepStrictEqual(capSubSources(few), few);
});

test('order is preserved — the first tracks of a release are the ones anyone reaches for', () => {
  const kept = capSubSources([track('eng'), track('fre'), track('ger')]);
  assert.deepStrictEqual(kept.map((s) => s.lang), ['eng', 'fre', 'ger']);
});

test('a short list is returned untouched, so an ordinary file is unaffected', () => {
  const few = [track('eng'), track('fre')];
  assert.deepStrictEqual(capSubSources(few), few);
});

test('no input is not a crash', () => {
  assert.deepStrictEqual(capSubSources(null), []);
  assert.deepStrictEqual(capSubSources([]), []);
});
