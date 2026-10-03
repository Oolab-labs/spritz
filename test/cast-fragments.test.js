'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lan = require('../src/main/lanserver');

// Measured on an LG webOS TV over Google Cast, with the live fragmented-MP4 pipe:
//   one fragment per keyframe, 10 s apart, 4 Mbps   -> BUFFERING forever (the receiver gives up and
//                                                       closes the connection after a minute)
//   same file, 3 Mbps                                -> plays
//   same file, fragments cut every second            -> plays at 4 Mbps, and a 4K HEVC copy too
// A fragment per keyframe makes each fragment as large as a whole GOP, which grows with bitrate, so
// real films (long GOPs, high bitrates) failed while thin test clips passed.
test('the cast pipe cuts fragments by time as well as at keyframes', () => {
  const flags = lan.CAST_PIPE_MUXFLAGS;
  assert.ok(Array.isArray(flags));
  const i = flags.indexOf('-frag_duration');
  assert.ok(i >= 0, 'a maximum fragment length must be set');
  const us = Number(flags[i + 1]);
  assert.ok(us > 0 && us <= 2000000, 'fragments must be at most two seconds, got ' + us + 'us');
  const mov = flags[flags.indexOf('-movflags') + 1];
  for (const f of ['empty_moov', 'delay_moov', 'default_base_moof']) assert.ok(mov.includes(f), f + ' is load-bearing');
});

test('mkvArgs uses the shared flags rather than a private copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'lanserver.js'), 'utf8');
  assert.ok(!/const MKV_MUXFLAGS\s*=\s*\[/.test(src), 'a second literal copy of the flags would drift');
  assert.ok(/MKV_MUXFLAGS\s*=\s*CAST_PIPE_MUXFLAGS/.test(src));
});

test('a live cast session asks the receiver for its position', () => {
  // The receiver only reports on state changes; a silent stretch froze the clock (LG, 16 s into a film).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'cast.js'), 'utf8');
  assert.ok(/startStatusPoll\(p\)/.test(src), 'the poll starts when the player is up');
  assert.ok(/pollStatus\(p\)/.test(src) && !/p\.getStatus\(/.test(src), 'the leaking library call is not used');
  const teardown = src.slice(src.indexOf('function teardownClient()'), src.indexOf('function teardownClient()') + 200);
  assert.ok(/stopStatusPoll\(\)/.test(teardown), 'and stops with the session');
});
