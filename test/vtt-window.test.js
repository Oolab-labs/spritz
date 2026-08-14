'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { trimToCompleteCues, coverageEnd } = require('../src/main/vtt-window');

const DOC = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:03.000',
  'First line.',
  '',
  '00:00:04.500 --> 00:00:07.250',
  'Second line.'
].join('\n');

test('a complete document survives unchanged in substance', () => {
  const out = trimToCompleteCues(DOC + '\n');
  assert.ok(out.startsWith('WEBVTT'));
  assert.match(out, /First line\./);
  assert.match(out, /Second line\./);
});

test('a cue cut off mid-text is kept, because it still renders', () => {
  // The extractor was killed part-way through writing the text of the last cue. Its timing line is
  // intact, so the receiver can show it.
  const out = trimToCompleteCues(DOC + '\n\n00:00:09.000 --> 00:00:11.000\nHalf a li');
  assert.match(out, /Half a li/);
});

test('a trailing timing line with no text is dropped', () => {
  // Killed between writing the timing line and the text. Nothing to display, and some receivers
  // reject the whole track over it.
  const out = trimToCompleteCues(DOC + '\n\n00:00:09.000 --> 00:00:11.000');
  assert.ok(!/00:00:09\.000/.test(out), 'the empty trailing cue should be gone');
  assert.match(out, /Second line\./, 'earlier complete cues stay');
});

test('a half-written timing line is dropped', () => {
  const out = trimToCompleteCues(DOC + '\n\n00:00:09.000 --> 00:0');
  assert.ok(!/00:00:09/.test(out));
  assert.match(out, /Second line\./);
});

test('a file with no usable cue reports nothing rather than an empty track', () => {
  // Serving a header-only track shows the subtitle as available and then displays nothing, which is
  // worse than reporting that it is not ready.
  assert.equal(trimToCompleteCues('WEBVTT\n\n'), null);
  assert.equal(trimToCompleteCues('WEBVTT'), null);
});

test('output that is not WebVTT at all is refused', () => {
  assert.equal(trimToCompleteCues('<html>404</html>'), null);
  assert.equal(trimToCompleteCues(''), null);
  assert.equal(trimToCompleteCues(null), null);
});

test('CRLF line endings do not cost every cue', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const out = trimToCompleteCues(crlf);
  assert.match(out, /First line\./);
  assert.match(out, /Second line\./);
});

test('coverage reports how far the cues actually reach', () => {
  assert.equal(coverageEnd(DOC), 7.25);
  // Hour-length timestamps are the normal case for a feature film, not an edge case.
  assert.equal(coverageEnd('WEBVTT\n\n01:02:03.500 --> 01:02:05.000\nx'), 3725);
  assert.equal(coverageEnd('WEBVTT'), 0);
});
