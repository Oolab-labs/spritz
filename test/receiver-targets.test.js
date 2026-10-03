'use strict';

const { test } = require('node:test');
const assert = require('assert');
const T = require('../src/main/receiver-targets');
const R = require('../src/main/receiver-registry');

test('target snapshots retain epoch identity without mutating local adoption clocks', () => {
  const session = { receiverId: 'lg-1', authenticated: true, mediaId: 'film', epoch: 'epoch-2',
    state: 'paused', currentTime: 2, durationSec: 20 };
  const before = { ...session };
  const targets = T.targetsFrom({ registry: reg('lg-1'), sessions: [session] });
  assert.equal(targets[0].playback.epoch, 'epoch-2');
  assert.equal(targets[0].playback.currentTime, 2);
  targets[0].playback.currentTime = 602;
  assert.deepEqual(session, before);
});
test('direct and offline target snapshots have explicit timeline identity', () => {
  const online = T.targetsFrom({ registry: reg('lg-1'), sessions: [{ receiverId: 'lg-1', authenticated: true, currentTime: 0 }] });
  assert.equal(online[0].playback.epoch, null); assert.equal(online[0].playback.currentTime, 0);
  const offline = T.targetsFrom({ registry: reg('lg-1'), sessions: [] });
  assert.equal(offline[0].playback, null);
});

// The Mac's device list shows which receiver build a TV is running, so a TV on an old receiver can be
// told to update instead of failing in a way nobody can explain.
test('an online target carries the receiver version it announced; offline and unannounced ones say null', () => {
  const online = T.targetsFrom({ registry: reg('lg-1'), sessions: [{ receiverId: 'lg-1', authenticated: true, version: '0.2.9' }] });
  assert.equal(online[0].version, '0.2.9');
  assert.equal(T.targetsFrom({ registry: reg('lg-1'), sessions: [{ receiverId: 'lg-1', authenticated: true }] })[0].version, null);
  assert.equal(T.targetsFrom({ registry: reg('lg-1'), sessions: [] })[0].version, null);
});

function reg(...ids) {
  const r = R.emptyRegistry();
  for (const id of ids) R.confirmPairing(r, { code: R.beginPairing(r, { sessionId: 's-' + id, receiverId: id, name: 'LG ' + id }).code });
  return r;
}

test('a paired but unconnected receiver is an offline target', () => {
  const t = T.targetsFrom({ registry: reg('lg-1'), sessions: [] });
  assert.equal(t.length, 1);
  assert.equal(t[0].status, T.OFFLINE);
  assert.equal(t[0].playback, null, 'an offline receiver has no playback state to report');
  assert.equal(t[0].type, 'spritz-receiver');
});

test('identity is the receiver id, never an address', () => {
  const t = T.targetsFrom({ registry: reg('lg-1'), sessions: [{ receiverId: 'lg-1', authenticated: true, host: '192.168.1.5' }] });
  assert.equal(t[0].id, 'lg-1');
  assert.ok(!JSON.stringify(t[0]).includes('192.168.1.5'), 'an address leaked into the target');
});

test('an authenticated session makes a receiver online and carries its playback', () => {
  const t = T.targetsFrom({
    registry: reg('lg-1'),
    sessions: [{ receiverId: 'lg-1', authenticated: true, state: 'playing', mediaId: 'm1',
      currentTime: 5901.2, durationSec: 5981, at: 1000, now: 1400 }]
  });
  assert.equal(t[0].status, T.ONLINE);
  assert.equal(t[0].playback.state, 'playing');
  assert.equal(t[0].playback.currentTime, 5901.2);
  assert.equal(t[0].playback.ageMs, 400, 'a position without its age is not knowledge');
});

// An unauthenticated socket is not a place a film can be sent.
test('an unauthenticated session does not bring a receiver online', () => {
  const t = T.targetsFrom({ registry: reg('lg-1'), sessions: [{ receiverId: 'lg-1', authenticated: false, state: 'playing' }] });
  assert.equal(t[0].status, T.OFFLINE);
});

test('a revoked receiver is not offered as a target', () => {
  const r = reg('lg-1', 'lg-2');
  R.revoke(r, 'lg-1');
  const t = T.targetsFrom({ registry: r, sessions: [] });
  assert.deepEqual(t.map((x) => x.id), ['lg-2'], 'a forgotten television was still offered');
});

test('several receivers are supported, and ordering is stable', () => {
  const r = reg('lg-b', 'lg-a');
  const once = T.targetsFrom({ registry: r, sessions: [] }).map((x) => x.id);
  const twice = T.targetsFrom({ registry: r, sessions: [{ receiverId: 'lg-a', authenticated: true }] }).map((x) => x.id);
  assert.deepEqual(once, twice, 'the device list reshuffled when a connection changed');
});

test('a credential never reaches a target', () => {
  const r = reg('lg-1');
  const token = r.receivers['lg-1'].token;
  const json = JSON.stringify(T.targetsFrom({ registry: r, sessions: [{ receiverId: 'lg-1', authenticated: true }] }));
  assert.ok(!json.includes(token), 'the credential leaked into the device list');
});

test('the newer of two sessions for one receiver wins', () => {
  const t = T.targetsFrom({
    registry: reg('lg-1'),
    sessions: [
      { receiverId: 'lg-1', authenticated: true, state: 'paused', since: 100 },
      { receiverId: 'lg-1', authenticated: true, state: 'playing', since: 200 }
    ]
  });
  assert.equal(t[0].playback.state, 'playing');
});

test('pending pairings are listed without the code', () => {
  const p = T.pendingFrom({ pending: [{ receiverId: 'lg-1', name: 'webOS TV', platform: 'webos', expiresAt: 5, code: '4821' }] });
  assert.equal(p[0].receiverId, 'lg-1');
  assert.ok(!JSON.stringify(p).includes('4821'), 'the pairing code was passed on towards the UI');
});
