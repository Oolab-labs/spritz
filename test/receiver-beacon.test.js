'use strict';

// How a television finds the port.
//
// lanserver listens on an EPHEMERAL port by design — 61255 on one run, something else on the next —
// and a receiver sweeping the LAN cannot guess it. Discovery therefore needs one stable, well-known
// port whose only job is to answer "Spritz is here, and the control channel is on port N".
//
// This is a second listener, and that is deliberate rather than an oversight: it does a different
// job from the media server, it is tiny, and it lets lanserver keep its ephemeral-port policy
// untouched. What it must NOT become is a second way into anything — it answers one question.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createReceiverService = require('../src/main/receiver-service');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-beacon-'));

function req(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    }).on('error', reject);
  });
}

async function withBeacon(fn) {
  const dir = tmpdir();
  const lan = require('../src/main/lanserver')({});
  // Port 0 so the test does not fight anything real for a fixed port; the production default is
  // the well-known one.
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), lan, beaconPort: 0 });
  svc.start();
  await new Promise((r) => setTimeout(r, 250));
  try { await fn({ svc, lan, port: svc.beaconPort() }); } finally {
    svc.stop(); lan.teardown(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the beacon answers on a stable port and names the control port', async () => {
  await withBeacon(async ({ lan, port }) => {
    assert.ok(port > 0, 'no beacon is listening, so a television cannot find Spritz');
    const res = await get('http://127.0.0.1:' + port + '/spritz/hello');
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.spritz, true);
    assert.equal(j.port, lan.serverPort(), 'the beacon must point at the port the control channel is really on');
    assert.equal(typeof j.name, 'string');
  });
});

test('the beacon reveals nothing else, and answers nothing else', async () => {
  await withBeacon(async ({ port }) => {
    const j = JSON.parse((await get('http://127.0.0.1:' + port + '/spritz/hello')).body);
    for (const forbidden of ['receivers', 'paired', 'token', 'media', 'files', 'pending']) {
      assert.ok(!(forbidden in j), 'the beacon exposed "' + forbidden + '"');
    }
    // Any other path is refused: it is a beacon, not a server.
    assert.equal((await get('http://127.0.0.1:' + port + '/')).status, 404);
    assert.equal((await get('http://127.0.0.1:' + port + '/spritz/receivers')).status, 404);
  });
});

test('the beacon is reachable cross-origin', async () => {
  await withBeacon(async ({ port }) => {
    const res = await get('http://127.0.0.1:' + port + '/spritz/hello');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});

// Stopping the service must free the well-known port, or a restart cannot bind it again.
test('stopping the service closes the beacon', async () => {
  const dir = tmpdir();
  const lan = require('../src/main/lanserver')({});
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), lan, beaconPort: 0 });
  svc.start();
  await new Promise((r) => setTimeout(r, 250));
  const port = svc.beaconPort();
  svc.stop();
  lan.teardown();
  try {
    await assert.rejects(() => get('http://127.0.0.1:' + port + '/spritz/hello'), /ECONNREFUSED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The beacon's CORS header advertises GET, HEAD, OPTIONS, and its whole justification is that it
// answers exactly one question. A surface reachable by anything on the network before any trust
// exists should refuse everything it does not serve, rather than quietly treating a POST as a GET.
test('the beacon refuses methods it does not serve', async () => {
  await withBeacon(async ({ port }) => {
    const base = 'http://127.0.0.1:' + port + '/spritz/hello';
    assert.equal((await req(base, 'GET')).status, 200);
    assert.equal((await req(base, 'HEAD')).status, 200);
    assert.equal((await req(base, 'OPTIONS')).status, 204);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await req(base, method);
      assert.equal(res.status, 405, method + ' was not refused');
      assert.equal(res.headers.allow, 'GET, HEAD, OPTIONS', method + ' should be told what is allowed');
    }
  });
});

test('a HEAD probe carries no body', async () => {
  await withBeacon(async ({ port }) => {
    const res = await req('http://127.0.0.1:' + port + '/spritz/hello', 'HEAD');
    assert.equal(res.body, '');
  });
});

// The beacon is recorded only once its listen completes, and stop() closes what is recorded. A
// stop in the same tick as start — the application quitting immediately, or a test fixture that
// never yields — therefore found nothing to close, and the listen callback then installed a live
// listener on a service that had already stopped. Nothing ever closed it: the process could not
// exit, and the well-known port stayed taken. Found as a whole test suite that printed every pass
// and never printed its summary.
test('a stop in the same tick as start still closes the beacon', async () => {
  const dir = tmpdir();
  const lan = require('../src/main/lanserver')({});
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), lan, beaconPort: 0 });
  svc.start();
  svc.stop();
  lan.teardown();
  await new Promise((r) => setTimeout(r, 250));
  try {
    assert.equal(svc.beaconPort(), 0, 'a stopped service is still listening for televisions');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
