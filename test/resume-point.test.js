'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resumePosition, REWIND_SEC } = require('../src/main/resume-point');

test('the first request honours the position the user asked for', () => {
  assert.equal(resumePosition({ first: true, startSec: 3032, livePos: 0, durationSec: 6941 }), 3032);
  // Even if a stale position from a previous session is lying around.
  assert.equal(resumePosition({ first: true, startSec: 3032, livePos: 5000, durationSec: 6941 }), 3032);
});

test('a restart resumes from where the receiver actually is', () => {
  // The whole bug: this used to return 3032 while the receiver sat at 3212, feeding it three minutes
  // of video it had already played and leaving it buffering until ffmpeg caught up.
  const at = resumePosition({ first: false, startSec: 3032, livePos: 3212, durationSec: 6941 });
  assert.ok(at > 3032, 'must not drag the receiver back to the original seek point');
  assert.equal(at, 3212 - REWIND_SEC);
});

test('a small rewind is applied, because a gap is worse than an overlap', () => {
  const at = resumePosition({ first: false, startSec: 0, livePos: 1000, durationSec: 6941 });
  assert.ok(at < 1000 && at >= 1000 - REWIND_SEC - 1);
});

test('a receiver that has never reported falls back to the original point', () => {
  assert.equal(resumePosition({ first: false, startSec: 3032, livePos: 0, durationSec: 6941 }), 3032);
  assert.equal(resumePosition({ first: false, startSec: 3032, durationSec: 6941 }), 3032);
  assert.equal(resumePosition({ first: false, startSec: 3032, livePos: NaN, durationSec: 6941 }), 3032);
});

test('a position past the end of the film is not believed', () => {
  // A stale or bogus reading must not seek past the media and produce an empty stream.
  assert.equal(resumePosition({ first: false, startSec: 3032, livePos: 99999, durationSec: 6941 }), 3032);
});

test('a position behind the start is ignored rather than rewinding', () => {
  // The receiver has not caught up yet. Restarting even earlier would lengthen the catch-up it is
  // already sitting through — the exact spiral this exists to break.
  assert.equal(resumePosition({ first: false, startSec: 3032, livePos: 2000, durationSec: 6941 }), 3032);
  assert.equal(resumePosition({ first: false, startSec: 3032, livePos: 3032, durationSec: 6941 }), 3032);
});

test('a cast that started at zero still resumes forward', () => {
  const at = resumePosition({ first: false, startSec: 0, livePos: 600, durationSec: 6941 });
  assert.equal(at, 600 - REWIND_SEC);
});

test('an unknown duration does not block resuming', () => {
  // Duration is only used to reject nonsense; not knowing it must not disable the fix.
  assert.equal(resumePosition({ first: false, startSec: 100, livePos: 500 }), 500 - REWIND_SEC);
});

test('the result is never negative and never behind the start', () => {
  assert.equal(resumePosition({ first: false, startSec: 0, livePos: 2, durationSec: 100 }), 0);
  for (const live of [1, 3, 5, 50]) {
    const at = resumePosition({ first: false, startSec: 10, livePos: live, durationSec: 100 });
    assert.ok(at >= 10, `startSec floor held for livePos=${live}`);
  }
});
