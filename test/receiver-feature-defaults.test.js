'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { receiverFeatures } = require('../src/main/receiver-preparation-policy');

// A Finder launch has no shell environment: the packaged app must behave as qualified on hardware.
test('a Finder launch (empty env) enables source audio and keeps near-position off', () => {
  assert.deepStrictEqual(receiverFeatures({}), { sourceAudio: true, nearAudio: false });
});

test('SPRITZ_RECEIVER_SOURCE_AUDIO=0 is a kill switch', () => {
  assert.strictEqual(receiverFeatures({ SPRITZ_RECEIVER_SOURCE_AUDIO: '0' }).sourceAudio, false);
});

test('near-position stays opt-in', () => {
  assert.strictEqual(receiverFeatures({ SPRITZ_RECEIVER_NEAR_AUDIO: '1' }).nearAudio, true);
  assert.strictEqual(receiverFeatures({ SPRITZ_RECEIVER_SOURCE_AUDIO: '1' }).nearAudio, false);
});
