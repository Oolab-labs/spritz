/* HMAC-SHA256 for the receiver, in plain ES5.
 *
 * Why not crypto.subtle: WebCrypto is only exposed in a SECURE CONTEXT. A webOS application is not
 * served over https, and whether its origin counts as secure is a platform detail that varies by
 * webOS version — discovering that on the television, at pairing time, with no console, is the worst
 * possible place to find out. This has one code path on every platform, and hmac.test.js checks it
 * against Node's own crypto so "our SHA-256 is subtly wrong" cannot be the bug.
 *
 * The secret never leaves the television: this computes a proof over the Mac's per-connection nonce.
 * See receiver-registry.proofFor, which must produce byte-identical output.
 *
 * Loadable both as a browser script (window.SpritzHmac) and as a Node module (for the test).
 */
(function (root) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  // Digest of a byte array, returned as a byte array.
  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length;
    // Padding: 0x80, then zeros, then the length in BITS as a 64-bit big-endian value.
    var withPad = l + 9;
    var total = Math.ceil(withPad / 64) * 64;
    var m = new Uint8Array(total);
    m.set(bytes);
    m[l] = 0x80;
    // The high word of the bit length is left zero: a message over 512 MB is not something this is
    // ever handed, and writing a value we cannot compute correctly would be worse than not writing it.
    var bits = l * 8;
    m[total - 4] = (bits >>> 24) & 0xff;
    m[total - 3] = (bits >>> 16) & 0xff;
    m[total - 2] = (bits >>> 8) & 0xff;
    m[total - 1] = bits & 0xff;

    var w = new Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (h[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = h[i] & 0xff;
    }
    return out;
  }

  // UTF-8, done explicitly rather than via TextEncoder: the credential is base64url and the nonce is
  // hex, both ASCII, but relying on that silently would break the day a display name joins the input.
  function utf8(str) {
    var s = unescape(encodeURIComponent(String(str)));
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  function hmacSha256Hex(key, message) {
    var blockSize = 64;
    var k = utf8(key);
    if (k.length > blockSize) k = sha256(k);
    var pad = new Uint8Array(blockSize);
    pad.set(k);
    var inner = new Uint8Array(blockSize), outer = new Uint8Array(blockSize);
    for (var i = 0; i < blockSize; i++) {
      inner[i] = pad[i] ^ 0x36;
      outer[i] = pad[i] ^ 0x5c;
    }
    var msg = utf8(message);
    var innerInput = new Uint8Array(blockSize + msg.length);
    innerInput.set(inner); innerInput.set(msg, blockSize);
    var innerHash = sha256(innerInput);
    var outerInput = new Uint8Array(blockSize + 32);
    outerInput.set(outer); outerInput.set(innerHash, blockSize);
    return hex(sha256(outerInput));
  }

  var api = { hmacSha256Hex: hmacSha256Hex, sha256Hex: function (s) { return hex(sha256(utf8(s))); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzHmac = api;
})(typeof window !== 'undefined' ? window : this);
