'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mem = require('../src/main/device-memory');
const deviceProfile = require('../src/main/device-profile');

const KEY = 'id:abc';
const apply = (m, profile) => mem.applyMemory(profile, m, KEY, deviceProfile);

test('a stream that played untouched is recorded as what the device can do', () => {
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 2160, hdr: true, videoCopied: true, audioCodec: 'eac3', audioCopied: true });
  const out = apply(m, deviceProfile.defaultProfile());
  assert.equal(out.hevc4k, true);
  assert.equal(out.hdr10, true);
  assert.equal(out.maxHeight, 2160);
  assert.ok(out.audioCopy.includes('eac3'));
  assert.equal(out.source, 'observed', 'and the profile says where that came from');
});

test('a downscaled stream proves nothing about the resolution it was not sent', () => {
  // The file was 4K; 1080p went out. That the receiver played it says nothing about 4K.
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 1080, videoCopied: true });
  const out = apply(m, deviceProfile.defaultProfile());
  assert.equal(out.hevc4k, false);
  assert.equal(out.maxHeight, 1080);
});

test('a re-encoded picture is not evidence about the source format', () => {
  // videoCopied false: the receiver played our H.264, not the file's HEVC/HDR.
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 2160, hdr: true, dovi: true, videoCopied: false });
  const out = apply(m, deviceProfile.defaultProfile());
  assert.equal(out.hevc4k, false);
  assert.equal(out.dovi, false, 'DV especially: it was stripped before sending');
});

test('audio converted to AAC says nothing about passthrough', () => {
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { audioCodec: 'truehd', audioCopied: false, videoCopied: true, height: 1080 });
  const out = apply(m, deviceProfile.defaultProfile());
  assert.ok(!out.audioCopy.includes('truehd'));
});

test('a failure never narrows what the device is allowed to be sent', () => {
  // The core rule. A refusal names one of several possible causes and not which, and guessing turns
  // a working setup into 1080p SDR stereo for reasons no one can reconstruct.
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 2160, hdr: true, videoCopied: true });
  const before = apply(m, deviceProfile.defaultProfile());
  mem.recordFailure(m, KEY, { videoCodec: 'hevc', height: 2160, container: 'matroska', dovi: true }, 'receiver dropped the connection');
  const after = apply(m, deviceProfile.defaultProfile());
  assert.deepEqual(after, before, 'capabilities must be untouched by a failure');
  assert.equal(mem.describe(m, KEY).failures, 1, 'but it is remembered');
});

test('failures are kept bounded', () => {
  const m = mem.emptyMemory();
  for (let i = 0; i < mem.MAX_FAILURES + 15; i++) mem.recordFailure(m, KEY, {}, 'nope ' + i);
  const f = m.devices[KEY].failures;
  assert.equal(f.length, mem.MAX_FAILURES);
  assert.match(f[f.length - 1].reason, /nope \d+$/, 'the most recent are the ones kept');
});

test('observation never overrides what the user set by hand', () => {
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 2160, videoCopied: true });
  const override = Object.assign(deviceProfile.defaultProfile(), { source: 'user-override', hevc4k: false, maxHeight: 1080 });
  const out = apply(m, override);
  assert.equal(out.hevc4k, false);
  assert.equal(out.maxHeight, 1080);
  assert.equal(out.source, 'user-override');
});

test('observation only ever widens a profile', () => {
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 1080, videoCopied: true });
  const reported = Object.assign(deviceProfile.defaultProfile(), { source: 'reported', hevc4k: true, maxHeight: 2160 });
  const out = apply(m, reported);
  assert.equal(out.maxHeight, 2160, 'a smaller observation must not shrink a larger claim');
  assert.equal(out.hevc4k, true);
  assert.equal(out.source, 'reported', 'nothing was added, so the source is unchanged');
});

test('an unknown device is left exactly as it was', () => {
  const m = mem.emptyMemory();
  const base = deviceProfile.defaultProfile();
  assert.deepEqual(apply(m, base), deviceProfile.normalise(base));
});

test('identity survives a DHCP lease', () => {
  // The address is the last resort: keyed on it, a profile would transplant onto whatever answers
  // at that address tomorrow.
  assert.equal(mem.deviceKey({ id: 'ABC', label: 'Living Room', host: '192.168.1.7' }), 'id:abc');
  assert.equal(mem.deviceKey({ label: 'Living Room', host: '192.168.1.7' }), 'label:living room');
  assert.equal(mem.deviceKey({ host: '192.168.1.7' }), 'host:192.168.1.7');
  assert.equal(mem.deviceKey({}), null);
  assert.equal(mem.deviceKey(null), null);
});

test('what a device has played can be described', () => {
  const m = mem.emptyMemory();
  mem.recordSuccess(m, KEY, { videoCodec: 'hevc', height: 2160, hdr: true, videoCopied: true, audioCodec: 'eac3', audioCopied: true, label: 'Living Room' });
  const d = mem.describe(m, KEY);
  assert.equal(d.label, 'Living Room');
  assert.ok(d.played.includes('4K HEVC'));
  assert.ok(d.played.includes('HDR10'));
  assert.ok(d.played.includes('EAC3'));
});
