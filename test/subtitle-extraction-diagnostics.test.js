'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnostics, classify } = require('../src/main/subtitle-extraction-diagnostics');
test('subtitle diagnostics retain bounded error information and redact private source paths/URLs', () => {
  const source = 'http://localhost:1234/webtorrent/private/movie.mkv';
  const diag = createDiagnostics([source, '/private/movie with spaces.mkv']);
  diag.capture('x'.repeat(10000));
  diag.capture(' Connection refused: ' + source + ' /private/movie with spaces.mkv https://tv/token/secret');
  const summary = diag.summarize({ code: 1, bytes: 0 });
  assert.equal(summary.category, 'source-request-error');
  assert.equal(summary.stderr.length <= 512, true);
  for (const secret of ['private', 'movie', 'token', 'secret', 'localhost']) assert.equal(summary.stderr.includes(secret), false);
});
test('subtitle diagnostics distinguish missing input packets from preserved partial output', () => {
  assert.equal(classify('', { bytes: 0, timedOut: true }), 'deadline-before-output');
  assert.equal(classify('', { bytes: 2000, timedOut: true }), 'partial-output');
  assert.equal(classify('matches no streams', { bytes: 0, code: 1 }), 'stream-map-error');
  assert.equal(classify('Invalid data found when processing input', { bytes: 0, code: 1 }), 'probe-or-demux-error');
});

test('mux timestamp failure takes precedence over an expired progress deadline', () => {
  assert.equal(classify('Non-monotonic DTS; Error submitting a packet to the muxer: Invalid argument', { bytes: 0, timedOut: true }), 'timestamp-or-mux-error');
});

test('terminal mux detection handles split output without treating DTS warnings as fatal', () => {
  const diag = createDiagnostics();
  diag.capture('Non-monotonic DTS; changing to 123'); assert.equal(diag.hasTerminalMuxFailure(), false);
  diag.capture('Error submitting a packet to the '); assert.equal(diag.hasTerminalMuxFailure(), false);
  diag.capture('muxer: Invalid argument'); assert.equal(diag.hasTerminalMuxFailure(), true);
  diag.capture('x'.repeat(5000)); assert.equal(diag.hasTerminalMuxFailure(), true);
});
