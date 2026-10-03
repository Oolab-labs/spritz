'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// libmpv 0.41.0's CoreAudio output crashes the app on the next audio-device change after a failed
// init (reproduced with a synthetic CoreAudio device hotplug). The player must not try CoreAudio
// first. The native addon is not unit-testable here, so pin the source; the behaviour was verified
// by firing a device hotplug at a running build (see IMPLEMENTATION-PROGRESS 2026-10-02).
const src = fs.readFileSync(path.join(__dirname, '..', 'native', 'mpv', 'mpv_addon.mm'), 'utf8');

test('the player prefers AVFoundation over CoreAudio and keeps CoreAudio only as a fallback', () => {
  const m = /mpv_set_option_string\(gMpv,\s*"ao",\s*"([^"]+)"\)/.exec(src);
  assert.ok(m, 'no ao option set on the player handle');
  const order = m[1].split(',');
  assert.strictEqual(order[0], 'avfoundation');
  assert.ok(order.indexOf('coreaudio') > 0, 'coreaudio should remain as a fallback');
});

test('playerStat reports which audio output started, so the choice can be checked on a live build', () => {
  assert.ok(/"current-ao"/.test(src) && /"currentAo"/.test(src));
});

test('the verbose-logging experiment is not left in: error level only', () => {
  assert.ok(/mpv_request_log_messages\(gMpv,\s*"error"\)/.test(src));
  assert.ok(/"msg-level",\s*"all=error"\)/.test(src));
});
