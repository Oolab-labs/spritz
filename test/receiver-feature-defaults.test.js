'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { receiverFeatures } = require('../src/main/receiver-preparation-policy');

// A Finder launch has no shell environment: the packaged app must behave as qualified on hardware.
test('a Finder launch (empty env) enables source audio', () => {
  assert.deepStrictEqual(receiverFeatures({}), { sourceAudio: true });
});

test('SPRITZ_RECEIVER_SOURCE_AUDIO=0 is a kill switch', () => {
  assert.strictEqual(receiverFeatures({ SPRITZ_RECEIVER_SOURCE_AUDIO: '0' }).sourceAudio, false);
});
