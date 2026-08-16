'use strict';

// The cast path retried with the software encoder on any run that produced nothing. For a hardware
// encoder that could not start that is correct; for a torrent that went quiet it is a second doomed
// attempt on the receiver's patience, logged as an encoder problem it never was.

const test = require('node:test');
const assert = require('node:assert');
const { classifyFailure, shouldRetryInSoftware } = require('../src/main/ffmpeg-failure');

test('a hardware encoder that could not start is an encoder failure', () => {
  // Real VideoToolbox messages; they come from the framework, so they are stable across versions.
  for (const s of [
    'Error: cannot create compression session: -12903',
    'No device available for encoder',
    'The hardware encoder may be busy, or not supported',
    '[h264_videotoolbox @ 0x1] Error encoding frame'
  ]) assert.equal(classifyFailure(s), 'encoder', s);
});

test('a source that went quiet is an input failure', () => {
  // Observed on this project: a starved torrent produces exactly these, and no encoder swap helps.
  for (const s of [
    '[in#0] Error opening input: Server returned 404 Not Found',
    'Error reading HTTP response: Operation timed out',
    'Error during demuxing: Input/output error',
    'Connection timed out'
  ]) assert.equal(classifyFailure(s), 'input', s);
});

test('an input error wins when both appear', () => {
  // A run that could not open its source often prints encoder noise on the way down. The first
  // cause is the real one.
  const mixed = 'Error opening input: Operation timed out\n[h264_videotoolbox] Error encoding frame';
  assert.equal(classifyFailure(mixed), 'input');
  assert.equal(shouldRetryInSoftware(mixed), false);
});

test('an encoder failure is retried in software', () => {
  assert.equal(shouldRetryInSoftware('cannot create compression session'), true);
});

test('an input failure is not retried, because nothing would change', () => {
  assert.equal(shouldRetryInSoftware('Error opening input: Server returned 404 Not Found'), false);
});

test('an unrecognised or empty failure keeps the old behaviour', () => {
  // This must not become a quiet way to stop trying. Retrying once costs little.
  assert.equal(classifyFailure(''), 'unknown');
  assert.equal(classifyFailure(null), 'unknown');
  assert.equal(classifyFailure('something nobody has seen before'), 'unknown');
  assert.equal(shouldRetryInSoftware(''), true);
  assert.equal(shouldRetryInSoftware('something nobody has seen before'), true);
});
