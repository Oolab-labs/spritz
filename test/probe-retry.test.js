'use strict';

// A probe that returns nothing is not neutral: the planner then knows no codec, no resolution and no
// audio, so it re-encodes everything. Correct given what it knows, and ruinous when what it knows is
// only "the swarm delivered nothing for five seconds". Seen in a real session — an auto-advance
// probed while the torrent was stalled, and a 1080p HEVC episode that would have been copied was
// re-encoded for 46 minutes with nothing reported but the probe failure.

const test = require('node:test');
const assert = require('node:assert');
const { probeWithRetries } = require('../src/main/probe-retry');

// Runs scheduled callbacks immediately, so retry behaviour is tested without waiting for it.
const now = (fn) => { fn(); return 0; };

test('a probe that works first time is not retried', () => {
  let calls = 0;
  let got = null, attempts = 0;
  probeWithRetries((t, cb) => { calls++; cb({ vcodec: 'hevc' }); }, (r, n) => { got = r; attempts = n; }, { schedule: now });
  assert.equal(calls, 1, 'the common path must not get slower');
  assert.deepEqual(got, { vcodec: 'hevc' });
  assert.equal(attempts, 1);
});

test('a probe that fails once and then succeeds returns the real answer', () => {
  let calls = 0;
  let got = null;
  probeWithRetries((t, cb) => { calls++; cb(calls === 1 ? null : { vcodec: 'hevc', height: 1080 }); },
    (r) => { got = r; }, { schedule: now });
  assert.equal(calls, 2);
  assert.equal(got.vcodec, 'hevc', 'the retry is the whole point: this is a copy instead of a re-encode');
});

test('the timeout escalates, because a stalled swarm may just need longer', () => {
  const seen = [];
  probeWithRetries((t, cb) => { seen.push(t); cb(null); }, () => {}, { schedule: now });
  assert.ok(seen.length >= 3, 'should try more than twice');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `attempt ${i + 1} should wait longer than attempt ${i}`);
  }
  assert.equal(seen[0], 5000, 'the first attempt stays short — it is on the path to the cast button');
});

test('giving up eventually is required, or a dead input hangs the cast forever', () => {
  let calls = 0;
  let finished = false, attempts = 0;
  probeWithRetries((t, cb) => { calls++; cb(null); }, (r, n) => { finished = true; attempts = n; }, { schedule: now });
  assert.equal(finished, true, 'must call back even when every attempt fails');
  assert.equal(attempts, calls);
  assert.ok(calls <= 4, 'bounded');
});

test('a result is accepted even when it is unhelpful', () => {
  // An answer of "no video stream" is information. Only nothing at all is worth asking again for.
  let calls = 0;
  let got;
  probeWithRetries((t, cb) => { calls++; cb({ vcodec: null, audio: [] }); }, (r) => { got = r; }, { schedule: now });
  assert.equal(calls, 1);
  assert.deepEqual(got, { vcodec: null, audio: [] });
});

test('failure reports null rather than something falsy-but-shaped', () => {
  let got = 'unset';
  probeWithRetries((t, cb) => cb(undefined), (r) => { got = r; }, { schedule: now });
  assert.equal(got, null, 'callers test this for truthiness; it must be unambiguous');
});

test('retries are spaced, not immediate', () => {
  // Retrying instantly against a swarm that just delivered nothing would fail the same way three
  // times in a row and waste the escalation.
  const delays = [];
  probeWithRetries((t, cb) => cb(null), () => {}, { schedule: (fn, ms) => { delays.push(ms); fn(); } });
  assert.ok(delays.length >= 2);
  for (const d of delays) assert.ok(d > 0, 'each retry should wait before trying again');
});
