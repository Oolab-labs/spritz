'use strict';
const test = require('node:test');
const assert = require('node:assert');
const flow = require('../webos-receiver/home-flow');

// A television has a remote, not a keyboard. Whatever a person types for the Mac's address has to
// be forgiven where it is harmless (spaces, a stray trailing dot) and refused where it would send
// the TV off to probe something that is not a LAN Mac.
test('parseHost accepts a plain LAN IPv4 address and trims it', () => {
  assert.deepStrictEqual(flow.parseHost('192.168.1.9'), { host: '192.168.1.9' });
  assert.deepStrictEqual(flow.parseHost('  10.0.0.12 '), { host: '10.0.0.12' });
  assert.deepStrictEqual(flow.parseHost('172.16.5.4.'), { host: '172.16.5.4' });
});

test('parseHost rejects anything that is not a private IPv4 address, with a reason the person can act on', () => {
  for (const bad of ['', '   ', 'hello', '192.168.1', '192.168.1.256', '1.2.3.4.5', '8.8.8.8', '127.0.0.1', '0.0.0.0',
                     '169.254.1.1', 'http://192.168.1.9', '192.168.1.9:3000', 'my-mac.local', '192.168.1.9/24']) {
    const r = flow.parseHost(bad);
    assert.ok(r.error && typeof r.error === 'string' && !r.host, JSON.stringify(bad) + ' -> ' + JSON.stringify(r));
  }
});

test('private ranges are exactly 10/8, 172.16/12 and 192.168/16', () => {
  assert.ok(flow.parseHost('10.255.255.255').host);
  assert.ok(flow.parseHost('172.16.0.1').host);
  assert.ok(flow.parseHost('172.31.255.1').host);
  assert.ok(flow.parseHost('172.15.0.1').error);
  assert.ok(flow.parseHost('172.32.0.1').error);
  assert.ok(flow.parseHost('192.169.0.1').error);
});

// The Mac expires a pairing code after five minutes. Before this, the TV kept showing it forever.
test('countdown: seconds left, never negative, and a refresh is due only once the code has expired', () => {
  assert.strictEqual(flow.secondsLeft(10000, 4000), 6);
  assert.strictEqual(flow.secondsLeft(10000, 9001), 1);
  assert.strictEqual(flow.secondsLeft(10000, 10000), 0);
  assert.strictEqual(flow.secondsLeft(10000, 99999), 0);
  assert.strictEqual(flow.secondsLeft(0, 5), 0);
  assert.strictEqual(flow.secondsLeft(undefined, 5), 0);
  assert.strictEqual(flow.refreshDue(10000, 9999), false);
  assert.strictEqual(flow.refreshDue(10000, 10000), true);
  assert.strictEqual(flow.refreshDue(0, 5), false, 'no expiry known: do not loop requesting codes');
});

test('formatCountdown is m:ss', () => {
  assert.strictEqual(flow.formatCountdown(299), '4:59');
  assert.strictEqual(flow.formatCountdown(60), '1:00');
  assert.strictEqual(flow.formatCountdown(9), '0:09');
  assert.strictEqual(flow.formatCountdown(0), '0:00');
});

// Limits a refresh loop: a Mac that hands out already-expired codes must not be hammered.
test('refresh pacing: at most one request per 5 seconds', () => {
  assert.strictEqual(flow.canRequestCode(0, 100000), true);
  assert.strictEqual(flow.canRequestCode(100000, 102000), false);
  assert.strictEqual(flow.canRequestCode(100000, 105000), true);
});

// The receiver used to announce a hardcoded '0.2.9' that drifted from appinfo.json. The page must read
// its version from appinfo.json and announce that.
test('the page announces the version it read from appinfo.json, never a literal', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'webos-receiver', 'index.html'), 'utf8');
  assert.ok(!/version: '\d+\.\d+\.\d+'/.test(html), 'hardcoded version literal in the hello');
  assert.ok(/version: RECEIVER_VERSION/.test(html));
  assert.ok(/readJson\('appinfo\.json'/.test(html));
});
