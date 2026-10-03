'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/renderer/cast-routes');

const lg = { name: '[LG] webOS TV NANO80T6A', host: '192.168.1.5' };
const casts = [{ name: lg.name, host: lg.host }];
const dlnas = [{ name: lg.name, location: 'http://192.168.1.5:1/desc.xml' }];
const NOW = 1_700_000_000_000;

// The menu used to show "[LG] webOS TV NANO80T6A — native 4K/HDR (best)" next to a second, bare
// "[LG] webOS TV NANO80T6A" and never said which was which.
test('every route says what it is, and the same TV shows two clearly different rows', () => {
  const rows = R.describeRoutes({ casts, dlnas, failures: {}, now: NOW });
  assert.strictEqual(rows.length, 2);
  const dlna = rows.find((r) => r.kind === 'dlna'), cast = rows.find((r) => r.kind === 'chromecast');
  assert.strictEqual(dlna.name, lg.name);
  assert.match(dlna.detail, /DLNA/);
  assert.match(dlna.detail, /original/i);
  assert.strictEqual(cast.name, lg.name);
  assert.match(cast.detail, /Google Cast/);
  assert.notStrictEqual(dlna.detail, cast.detail);
});

test('the best route for a dual-capable TV (DLNA, original file) is listed first', () => {
  assert.strictEqual(R.describeRoutes({ casts, dlnas, failures: {}, now: NOW })[0].kind, 'dlna');
});

test('a TV that only speaks one protocol is labelled with that protocol', () => {
  const onlyDlna = R.describeRoutes({ casts: [], dlnas: [{ name: 'Living room', location: 'http://10.0.0.9/d.xml' }], failures: {}, now: NOW });
  assert.strictEqual(onlyDlna.length, 1); assert.match(onlyDlna[0].detail, /DLNA/);
  const onlyCast = R.describeRoutes({ casts: [{ name: 'Chromecast', host: '10.0.0.4' }], dlnas: [], failures: {}, now: NOW });
  assert.strictEqual(onlyCast.length, 1); assert.match(onlyCast[0].detail, /Google Cast/);
});

test('a Cast route that failed to connect is demoted to last and says so, then recovers after 30 minutes', () => {
  const failures = { [lg.host]: NOW - 60_000 };
  const rows = R.describeRoutes({ casts, dlnas, failures, now: NOW });
  assert.strictEqual(rows[rows.length - 1].kind, 'chromecast');
  assert.ok(rows[rows.length - 1].failed);
  assert.match(rows[rows.length - 1].detail, /didn.t connect last time/i);
  const later = R.describeRoutes({ casts, dlnas, failures, now: NOW + 31 * 60_000 });
  assert.ok(!later.find((r) => r.kind === 'chromecast').failed, 'a stale failure should not stick');
});

test('only connect failures are recognised as such', () => {
  for (const m of ['Chromecast connect timed out', 'connect timeout', 'Connect timed out']) assert.ok(R.isConnectFailure(m), m);
  for (const m of ['This source can’t be cast (needs an MP4/WebM the TV can play).', 'Cast connection lost.', '', null, undefined]) assert.ok(!R.isConnectFailure(m), String(m));
});

test('a connect failure names the DLNA alternative when the same TV has one', () => {
  const msg = R.failureNote('Chromecast connect timed out', { name: lg.name, hasDlna: true });
  assert.match(msg, new RegExp(lg.name.replace(/[[\]]/g, '\\$&')));
  assert.match(msg, /Google Cast/);
  assert.match(msg, /DLNA/);
});

test('a connect failure without an alternative says what to check', () => {
  const msg = R.failureNote('Chromecast connect timed out', { name: 'Chromecast', hasDlna: false });
  assert.match(msg, /on and awake|asleep|turned on/i);
  assert.ok(!/DLNA/.test(msg));
});

test('other errors pass through unchanged', () => {
  assert.strictEqual(R.failureNote('Cast connection lost.', { name: 'TV', hasDlna: true }), 'Cast: Cast connection lost.');
});

test('names are returned as plain strings (the renderer sets them with textContent)', () => {
  const rows = R.describeRoutes({ casts: [{ name: '<img src=x onerror=alert(1)>', host: '1.2.3.4' }], dlnas: [], failures: {}, now: NOW });
  assert.strictEqual(rows[0].name, '<img src=x onerror=alert(1)>');
});

test('the renderer loads cast-routes.js before itself and uses it for the menu and for Cast errors', () => {
  const fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(html.indexOf('cast-routes.js') !== -1 && html.indexOf('cast-routes.js') < html.indexOf('renderer.js'));
  assert.ok(/SpritzCastRoutes\.describeRoutes/.test(js));
  assert.ok(/SpritzCastRoutes\.failureNote/.test(js));
  assert.ok(/castFailures\[lastCastAttempt\.host\]/.test(js));
});

test('every row carries a tooltip with the full sentence', () => {
  const rows = R.describeRoutes({ casts: [{ name: 'TV', host: '1.2.3.4' }], dlnas: [{ name: 'TV', location: 'http://1.2.3.4:1/' }], failures: {}, now: Date.now() });
  assert.strictEqual(rows.length, 2);
  for (const r of rows) assert.ok(r.tooltip && r.tooltip.length > r.detail.length, r.kind);
});
