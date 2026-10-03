'use strict';

// The television's HMAC must agree with the Mac's, byte for byte, or every authentication fails on
// hardware for a reason no log would explain. So it is checked against Node's own crypto rather
// than against itself.

const { test } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const H = require('../webos-receiver/hmac.js');
const R = require('../src/main/receiver-registry');

const nodeHmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

test('matches the RFC 4231 test vector', () => {
  // Case 1 from RFC 4231, so this is anchored to the standard and not merely to Node.
  const key = '\x0b'.repeat(20);
  assert.equal(H.hmacSha256Hex(key, 'Hi There'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});

test('agrees with node crypto across realistic inputs', () => {
  const cases = [
    ['', ''],
    ['k', 'm'],
    [R.newToken(), R.newNonce()],
    [R.newToken(), R.newNonce()],
    // A key longer than the 64-byte block, which is the branch that hashes the key first.
    ['x'.repeat(200), R.newNonce()],
    // Exactly the block size, the classic off-by-one.
    ['y'.repeat(64), 'nonce'],
    ['z'.repeat(63), 'nonce'],
    ['z'.repeat(65), 'nonce'],
    // Multibyte, to prove the UTF-8 step is real rather than charCode luck.
    ['ключ', 'сообщение'],
    ['clé', 'message with spaces and — punctuation']
  ];
  for (const [k, m] of cases) {
    assert.equal(H.hmacSha256Hex(k, m), nodeHmac(k, m), 'mismatch for key length ' + k.length);
  }
});

// Messages spanning the SHA-256 padding boundaries, where a wrong length field shows up.
test('agrees with node crypto across message lengths around the block boundary', () => {
  const key = R.newToken();
  for (const n of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 128, 200]) {
    const m = 'a'.repeat(n);
    assert.equal(H.hmacSha256Hex(key, m), nodeHmac(key, m), 'mismatch at message length ' + n);
  }
});

// The whole point: a proof the television computes must satisfy the Mac's verifier.
test('a proof computed on the TV authenticates against the registry', () => {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
  const paired = R.confirmPairing(reg, { code: b.code });
  const nonce = R.newNonce();
  const proofFromTv = H.hmacSha256Hex(paired.token, nonce);
  assert.equal(R.authenticate(reg, { receiverId: 'lg-1', nonce, proof: proofFromTv }).ok, true);
});
