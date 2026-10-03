'use strict';

// The invariant here is byte-identity: a strict webOS renderer refuses an item whose HTTP
// contentFeatures.dlna.org header disagrees with the protocolInfo in the SOAP DIDL. Both sites now
// call the same function, so the test is that the function is stable and that the opt-in moves
// BOTH — which is only meaningful because there is only one of it.

const { test } = require('node:test');
const assert = require('assert');
const { STATIC, LIVE, flagsFor } = require('../src/main/dlna-flags');

const withSeek = (on, fn) => {
  const prev = process.env.SPRITZ_TORRENT_SEEK;
  if (on) process.env.SPRITZ_TORRENT_SEEK = '1'; else delete process.env.SPRITZ_TORRENT_SEEK;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SPRITZ_TORRENT_SEEK; else process.env.SPRITZ_TORRENT_SEEK = prev;
  }
};

test('the literals are exactly what strict webOS was observed to accept', () => {
  // Pinned, not derived. These strings are matched character by character by the renderer, so a
  // "tidy-up" that reorders or reformats them is a break, and this is what catches it.
  assert.equal(STATIC, 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
  assert.equal(LIVE, 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=0D500000000000000000000000000000');
});

test('a complete file is always advertised as seekable', () => {
  withSeek(false, () => {
    assert.equal(flagsFor('http://192.168.1.9:5000/file/abcd'), STATIC);
    assert.equal(flagsFor('http://192.168.1.9:5000/hls/tok/master.m3u8'), STATIC);
  });
});

test('the torrent proxy is NOT seekable by default', () => {
  // The default must stay the conservative one: OP=00 is why the LG stopped dropping mid-play.
  withSeek(false, () => {
    assert.equal(flagsFor('http://192.168.1.9:5000/dlna/tok/Film.mkv'), LIVE);
  });
});

test('SPRITZ_TORRENT_SEEK=1 opts the torrent proxy into byte-range seeking', () => {
  withSeek(true, () => {
    assert.equal(flagsFor('http://192.168.1.9:5000/dlna/tok/Film.mkv'), STATIC);
  });
});

test('the opt-in does not disturb anything that was already seekable', () => {
  withSeek(true, () => {
    assert.equal(flagsFor('http://192.168.1.9:5000/file/abcd'), STATIC);
  });
});

test('a missing url is treated as a complete file, not as a proxy', () => {
  withSeek(false, () => {
    assert.equal(flagsFor(null), STATIC);
    assert.equal(flagsFor(''), STATIC);
  });
});
