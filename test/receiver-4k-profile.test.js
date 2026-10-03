'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const profile = require('../src/main/device-profile');
test('receiver UHD requires both platform evidence and HEVC decoder support', () => {
  for (const reported of [null, {}, { screen: '3840x2160', hevc: 'probably' }, { uhd: true, hevc: 'no' }, { uhd: 'true', hevc: 'probably' }]) {
    assert.equal(profile.fromReceiver(reported, 'tv').maxHeight, 1080);
  }
  const p = profile.fromReceiver({ uhd: true, hevc: 'probably' }, 'tv');
  assert.equal(p.maxHeight, 2160); assert.equal(p.hevc4k, true);
  assert.equal(p.h264_4k, false); assert.equal(p.source, 'reported'); assert.equal(p.id, 'tv');
});
