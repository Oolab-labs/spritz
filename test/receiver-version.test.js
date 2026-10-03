'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../src/main/receiver-version');
const T = require('../src/main/receiver-targets');
const R = require('../src/main/receiver-registry');

test('status compares by major.minor; patch differences never matter; unknown when the TV did not say', () => {
  assert.strictEqual(V.status('0.3.0', '0.3.0'), 'ok');
  assert.strictEqual(V.status('0.3.7', '0.3.0'), 'ok');
  assert.strictEqual(V.status('0.4.0', '0.3.0'), 'ok');
  assert.strictEqual(V.status('0.2.9', '0.3.0'), 'update');
  assert.strictEqual(V.status('0.2.0', '0.3.0'), 'update');
  assert.strictEqual(V.status(null, '0.3.0'), 'unknown');
  assert.strictEqual(V.status('garbage', '0.3.0'), 'unknown');
});

// The Mac app ships with one specific receiver. If the constant drifts from the receiver in the repo,
// every TV gets told to "update" to a build that does not exist (or never gets told).
test('the recommended receiver version is the version in webos-receiver/appinfo.json', () => {
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'webos-receiver', 'appinfo.json'), 'utf8'));
  assert.strictEqual(V.RECOMMENDED_RECEIVER_VERSION, info.version);
});

test('targets expose versionStatus so the renderer never has to compare versions itself', () => {
  const reg = R.emptyRegistry();
  R.confirmPairing(reg, { code: R.beginPairing(reg, { sessionId: 's', receiverId: 'lg-1', name: 'LG' }).code });
  const old = T.targetsFrom({ registry: reg, sessions: [{ receiverId: 'lg-1', authenticated: true, version: '0.1.0' }] })[0];
  assert.strictEqual(old.versionStatus, 'update');
  const none = T.targetsFrom({ registry: reg, sessions: [] })[0];
  assert.strictEqual(none.versionStatus, 'unknown');
});
