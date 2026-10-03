'use strict';

const { test } = require('node:test');
const assert = require('assert');
const R = require('../src/main/receiver-registry');

const pair = (reg, sessionId, receiverId, at) => {
  const b = R.beginPairing(reg, { sessionId, receiverId, name: 'TV', platform: 'webos', at });
  return R.confirmPairing(reg, { code: b.code, at });
};

test('pairing issues a strong credential that is not derived from the code', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1', name: 'Living Room' });
  assert.equal(b.code.length, R.CODE_DIGITS);
  const c = R.confirmPairing(reg, { code: b.code });
  assert.equal(c.ok, true);
  // 32 bytes base64url. The point of the assertion is the LENGTH class, not the exact encoding:
  // a credential short enough to guess would pass a naive "is it a string" check.
  assert.ok(c.token.length >= 40, 'credential is too short to be 256 bits');
  assert.ok(!c.token.includes(b.code), 'the credential must not contain the pairing code');
});

test('two pairings never mint the same credential', () => {
  const reg = R.emptyRegistry();
  const a = pair(reg, 's1', 'lg-1');
  const b = pair(reg, 's2', 'lg-2');
  assert.notEqual(a.token, b.token);
});

test('a wrong code fails', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
  const wrong = String((Number(b.code) + 1) % 10000).padStart(4, '0');
  assert.equal(R.confirmPairing(reg, { code: wrong }).ok, false);
});

test('an expired code fails', () => {
  const reg = R.emptyRegistry();
  const t = 1000;
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1', at: t });
  const after = t + R.CODE_TTL_MS + 1;
  assert.equal(R.confirmPairing(reg, { code: b.code, at: after }).ok, false);
});

test('a code is single use', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
  assert.equal(R.confirmPairing(reg, { code: b.code }).ok, true);
  // A replayed code must not mint a second credential for a connection that has already been served.
  assert.equal(R.confirmPairing(reg, { code: b.code }).ok, false);
});

test('a pending pairing is burned after too many wrong attempts', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
  const wrong = String((Number(b.code) + 7) % 10000).padStart(4, '0');
  for (let i = 0; i < R.MAX_CODE_ATTEMPTS; i++) R.confirmPairing(reg, { code: wrong });
  // Even the RIGHT code must now fail: the pairing is gone, and the human starts again on the TV.
  assert.equal(R.confirmPairing(reg, { code: b.code }).ok, false, 'grinding the code space stayed possible');
});

test('a cancelled pairing cannot be redeemed', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
  R.cancelPairing(reg, 's1');
  assert.equal(R.confirmPairing(reg, { code: b.code }).ok, false);
});

test('a valid credential authenticates a later connection', () => {
  const reg = R.emptyRegistry();
  const c = pair(reg, 's1', 'lg-1');
  const nonce = R.newNonce();
  const a = R.authenticate(reg, { receiverId: 'lg-1', nonce, proof: R.proofFor(c.token, nonce) });
  assert.equal(a.ok, true);
});

test('a wrong credential fails', () => {
  const reg = R.emptyRegistry();
  pair(reg, 's1', 'lg-1');
  const nonce = R.newNonce();
  const a = R.authenticate(reg, { receiverId: 'lg-1', nonce, proof: R.proofFor(R.newToken(), nonce) });
  assert.equal(a.ok, false);
  assert.equal(a.why, 'bad proof');
});

// The multi-television case. Only one LG exists today, but a design that assumes a singleton would
// have to be unpicked later, and credential separation is the part that must not be got wrong.
test("receiver A's credential cannot authenticate receiver B", () => {
  const reg = R.emptyRegistry();
  const a = pair(reg, 's1', 'lg-A');
  pair(reg, 's2', 'lg-B');
  const nonce = R.newNonce();
  const bad = R.authenticate(reg, { receiverId: 'lg-B', nonce, proof: R.proofFor(a.token, nonce) });
  assert.equal(bad.ok, false, "A's credential authenticated as B");
});

// Replaying a proof captured from an earlier connection must not work, because the nonce differs.
// This is the whole reason the token is never sent over the wire.
test('a proof for one nonce does not authenticate another', () => {
  const reg = R.emptyRegistry();
  const c = pair(reg, 's1', 'lg-1');
  const n1 = R.newNonce(), n2 = R.newNonce();
  const captured = R.proofFor(c.token, n1);
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce: n2, proof: captured }).ok, false);
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce: n1, proof: captured }).ok, true);
});

test('an unknown receiver fails', () => {
  const reg = R.emptyRegistry();
  const nonce = R.newNonce();
  assert.equal(R.authenticate(reg, { receiverId: 'ghost', nonce, proof: 'x' }).ok, false);
});

test('a revoked credential fails, and re-pairing issues a different one', () => {
  const reg = R.emptyRegistry();
  const first = pair(reg, 's1', 'lg-1');
  assert.equal(R.revoke(reg, 'lg-1').ok, true);
  const nonce = R.newNonce();
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce, proof: R.proofFor(first.token, nonce) }).ok, false,
    'a revoked credential still worked');

  const second = pair(reg, 's2', 'lg-1');
  assert.notEqual(second.token, first.token, 're-pairing reissued the same credential');
  const n2 = R.newNonce();
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce: n2, proof: R.proofFor(second.token, n2) }).ok, true);
  // And the old one is still dead after re-pairing.
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce: n2, proof: R.proofFor(first.token, n2) }).ok, false);
});

test('a malformed proof is rejected, not thrown on', () => {
  const reg = R.emptyRegistry();
  pair(reg, 's1', 'lg-1');
  const nonce = R.newNonce();
  // timingSafeEqual throws on a length mismatch; a receiver sending junk must get a clean failure.
  for (const bad of [undefined, null, '', 'short', 12345, {}]) {
    assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce, proof: bad }).ok, false);
  }
});

// Secrets must not reach a log or a UI listing. This asserts the shape rather than trusting review.
test('listReceivers never exposes the credential', () => {
  const reg = R.emptyRegistry();
  const c = pair(reg, 's1', 'lg-1');
  const listed = R.listReceivers(reg);
  const json = JSON.stringify(listed);
  assert.ok(!json.includes(c.token), 'the credential leaked into the receiver listing');
  assert.equal(listed[0].paired, true);
});

test('pendingList shows who is waiting, without the code', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1', name: 'Living Room' });
  const p = R.pendingList(reg);
  assert.equal(p.length, 1);
  assert.equal(p[0].receiverId, 'lg-1');
  assert.ok(!JSON.stringify(p).includes(b.code), 'the pairing code leaked into the pending listing');
});

test('identifiers are truncated consistently for logs', () => {
  assert.equal(R.short('lg-ixu03wxh1b4u'), 'lg-ixu03');
  assert.equal(R.short(null), 'none');
});


test('simultaneous pairing code collisions cannot approve another television', (t) => {
  const crypto = require('crypto');
  const values = [1234, 1234, 5678];
  t.mock.method(crypto, 'randomInt', () => values.shift());
  const reg = R.emptyRegistry();
  const a = R.beginPairing(reg, { sessionId: 'a', receiverId: 'tv-a', at: 100 });
  const b = R.beginPairing(reg, { sessionId: 'b', receiverId: 'tv-b', at: 100 });
  assert.equal(a.code, '1234'); assert.equal(b.code, '5678');
  const confirmed = R.confirmPairing(reg, { code: b.code, at: 101 });
  assert.equal(confirmed.receiverId, 'tv-b');
  assert.ok(reg.pending.a);
});

test('pairing collision retry is bounded and preserves the existing challenge', (t) => {
  const crypto = require('crypto');
  let calls = 0;
  t.mock.method(crypto, 'randomInt', () => { calls++; return 1234; });
  const reg = R.emptyRegistry();
  const first = R.beginPairing(reg, { sessionId: 'a', receiverId: 'tv-a', at: 100 });
  const denied = R.beginPairing(reg, { sessionId: 'b', receiverId: 'tv-b', at: 100 });
  assert.equal(denied.ok, false); assert.equal(calls, 33);
  assert.equal(reg.pending.a.code, first.code); assert.equal(reg.pending.b, undefined);
  const renewed = R.beginPairing(reg, { sessionId: 'b', receiverId: 'tv-b', at: 100 + R.CODE_TTL_MS });
  assert.equal(renewed.ok, true); assert.equal(reg.pending.a, undefined);
});
