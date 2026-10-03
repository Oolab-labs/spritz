'use strict';

// The authentication boundary on the live socket.
//
// Written BEFORE the gate existed, and it failed: until this milestone any device on the LAN could
// open ws://mac:8099/receiver and drive the television. These tests are the definition of "closed".
//
// They run against a real http.Server upgrade and a real masked client, for the same reason the hub
// tests do: the property being asserted is about what crosses a socket, and a mock transport would
// assert nothing about that.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const wsf = require('../src/main/ws-frame');
const proto = require('../src/main/receiver-protocol');
const R = require('../src/main/receiver-registry');
const createReceiverHub = require('../src/main/receiver-hub');

function connect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(['GET ' + (path || '/receiver') + ' HTTP/1.1', 'Host: 127.0.0.1:' + port,
        'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    let head = Buffer.alloc(0), upgraded = false, buf = Buffer.alloc(0), st = null;
    const msgs = [], waiters = [];
    const client = {
      socket, msgs,
      send(m) {
        const body = Buffer.from(proto.serialize(m), 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(body);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        let h;
        if (body.length < 126) { h = Buffer.alloc(2); h[1] = 0x80 | body.length; }
        else { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(body.length, 2); }
        h[0] = 0x81;
        socket.write(Buffer.concat([h, mask, masked]));
      },
      next(type, ms) {
        const i = msgs.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for ' + type)), ms || 3000);
          waiters.push({ type, res, timer });
        });
      },
      // Deliberately resolves rather than rejects: "nothing arrived" is the EXPECTED result for a
      // blocked command, and a rejection would make the happy path read as an error.
      quiet(type, ms) {
        return new Promise((res) => setTimeout(() => res(!msgs.some((m) => m.type === type)), ms || 400));
      },
      close() { try { socket.destroy(); } catch (e) {} }
    };
    socket.on('data', (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!/101 Switching Protocols/.test(head.slice(0, i).toString())) return reject(new Error('no upgrade'));
        upgraded = true; buf = head.slice(i + 4); resolve(client);
      } else buf = Buffer.concat([buf, chunk]);
      const out = wsf.decode(buf, st);
      buf = out.rest; st = out.state || st;
      for (const f of out.frames) {
        if (f.type !== 'text') continue;
        const r = proto.parse(f.text);
        if (!r.ok) continue;
        const w = waiters.findIndex((x) => x.type === r.msg.type);
        if (w >= 0) { const it = waiters.splice(w, 1)[0]; clearTimeout(it.timer); it.res(r.msg); }
        else msgs.push(r.msg);
      }
    });
    socket.on('error', reject);
  });
}

async function withHub(fn, opts) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const registry = (opts && opts.registry) || R.emptyRegistry();
  const logs = [];
  const hub = createReceiverHub({ registry, onLog: (m) => logs.push(m) });
  hub.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn({ hub, port: server.address().port, registry, logs });
  } finally {
    try { hub.teardown(); } catch (e) {}
    await new Promise((r) => server.close(r));
  }
}

// Greet, identify, and come back with the controller's hello (which carries the auth nonce).
async function greet(port, receiverId) {
  const c = await connect(port);
  const hello = await c.next('hello');
  c.send(Object.assign(proto.helloFrom(hello.sid, { receiverId, name: 'TV', platform: 'webos' })));
  return { c, hello };
}

// ---- 1 & 2: an unpaired receiver cannot drive playback --------------------------------------

test('an unpaired receiver cannot issue LOAD', async () => {
  await withHub(async ({ hub, port }) => {
    const { c, hello } = await greet(port, 'intruder-1');
    let leaked = false;
    hub.on('load', () => { leaked = true; });
    c.send(proto.envelope('load', hello.sid, { url: 'http://evil/x.m3u8', mediaId: 'x' }));
    assert.equal(await c.quiet('load'), true);
    assert.equal(leaked, false, 'an unauthenticated LOAD reached the controller');
    c.close();
  });
});

test('an unpaired receiver cannot SEEK', async () => {
  await withHub(async ({ hub, port }) => {
    const { c, hello } = await greet(port, 'intruder-1');
    let leaked = false;
    hub.on('seek', () => { leaked = true; });
    c.send(proto.envelope('seek', hello.sid, { toSec: 4000 }));
    // Wait before asserting. Checking the flag synchronously passes even with NO gate at all,
    // because the message has not crossed the socket yet — a test that cannot fail is worthless.
    await c.quiet('nothing');
    assert.equal(leaked, false, 'an unauthenticated SEEK reached the controller');
    c.close();
  });
});

// The controller must not be able to drive an unauthenticated socket either. Blocking only the
// inbound direction would leave a hostile connection receiving media URLs.
test('the hub refuses to send playback commands to an unauthenticated receiver', async () => {
  await withHub(async ({ hub, port }) => {
    const { c, hello } = await greet(port, 'intruder-1');
    const sent = hub.send(hello.sid, proto.load(hello.sid, { url: 'http://mac/private/media.m3u8', mediaId: 'm' }));
    assert.equal(sent, false, 'the hub sent a media URL to an unauthenticated socket');
    assert.equal(await c.quiet('load'), true);
    c.close();
  });
});

test('an unpaired receiver may still ping', async () => {
  await withHub(async ({ port }) => {
    const { c, hello } = await greet(port, 'intruder-1');
    c.send(proto.ping(hello.sid, { nonce: 'n1' }));
    const pong = await c.next('pong');
    assert.equal(pong.nonce, 'n1');
    c.close();
  });
});

// ---- pairing over the wire --------------------------------------------------------------------

test('pairing: request, code, confirm, credential', async () => {
  await withHub(async ({ hub, port, registry }) => {
    const { c, hello } = await greet(port, 'lg-1');
    c.send(proto.envelope('pair.request', hello.sid, {}));
    const ch = await c.next('pair.challenge');
    assert.equal(String(ch.code).length, R.CODE_DIGITS);
    assert.ok(ch.expiresAt > Date.now(), 'the challenge must carry its expiry');

    // The human types the code on the Mac.
    const done = hub.confirmPairing(ch.code);
    assert.equal(done.ok, true);
    const acc = await c.next('pair.accepted');
    assert.ok(acc.token && acc.token.length >= 40, 'no usable credential was issued');
    assert.equal(registry.receivers['lg-1'].token, acc.token);

    // And the socket is now authenticated: a command flows.
    let got = null;
    hub.on('position', (e) => { got = e.msg; });
    c.send(proto.position(hello.sid, { mediaId: 'm', currentTime: 5 }));
    await c.quiet('nothing');
    assert.ok(got, 'a paired receiver could not report position');
    c.close();
  });
});

test('a wrong code does not pair anyone', async () => {
  await withHub(async ({ hub, port }) => {
    const { c, hello } = await greet(port, 'lg-1');
    c.send(proto.envelope('pair.request', hello.sid, {}));
    const ch = await c.next('pair.challenge');
    const wrong = String((Number(ch.code) + 1) % 10000).padStart(4, '0');
    assert.equal(hub.confirmPairing(wrong).ok, false);
    assert.equal(await c.quiet('pair.accepted'), true, 'a wrong code still issued a credential');
    c.close();
  });
});

// ---- authenticating a later connection --------------------------------------------------------

test('a valid credential authenticates a later connection automatically', async () => {
  const registry = R.emptyRegistry();
  const b = R.beginPairing(registry, { sessionId: 'earlier', receiverId: 'lg-1' });
  const paired = R.confirmPairing(registry, { code: b.code });

  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    assert.ok(hello.nonce, 'the greeting must offer a nonce to prove against');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-1', name: 'TV', platform: 'webos' }));
    c.send(proto.envelope('auth', hello.sid, { receiverId: 'lg-1', proof: R.proofFor(paired.token, hello.nonce) }));
    const ok = await c.next('auth.ok');
    assert.equal(ok.receiverId, 'lg-1');
    assert.equal(hub.isAuthenticated(hello.sid), true);
    c.close();
  }, { registry });
});

test('a wrong credential fails and leaves the socket unauthenticated', async () => {
  const registry = R.emptyRegistry();
  const b = R.beginPairing(registry, { sessionId: 'earlier', receiverId: 'lg-1' });
  R.confirmPairing(registry, { code: b.code });

  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }));
    c.send(proto.envelope('auth', hello.sid, { receiverId: 'lg-1', proof: R.proofFor(R.newToken(), hello.nonce) }));
    const failed = await c.next('auth.failed');
    assert.match(failed.reason, /proof/);
    assert.equal(hub.isAuthenticated(hello.sid), false);
    c.close();
  }, { registry });
});

test("receiver A's credential cannot authenticate as receiver B over the wire", async () => {
  const registry = R.emptyRegistry();
  const a = R.confirmPairing(registry, { code: R.beginPairing(registry, { sessionId: 'e1', receiverId: 'lg-A' }).code });
  R.confirmPairing(registry, { code: R.beginPairing(registry, { sessionId: 'e2', receiverId: 'lg-B' }).code });

  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-B' }));
    c.send(proto.envelope('auth', hello.sid, { receiverId: 'lg-B', proof: R.proofFor(a.token, hello.nonce) }));
    await c.next('auth.failed');
    assert.equal(hub.isAuthenticated(hello.sid), false);
    c.close();
  }, { registry });
});

test('a revoked credential fails', async () => {
  const registry = R.emptyRegistry();
  const paired = R.confirmPairing(registry, { code: R.beginPairing(registry, { sessionId: 'e', receiverId: 'lg-1' }).code });
  const token = paired.token;
  R.revoke(registry, 'lg-1');

  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }));
    c.send(proto.envelope('auth', hello.sid, { receiverId: 'lg-1', proof: R.proofFor(token, hello.nonce) }));
    const failed = await c.next('auth.failed');
    assert.match(failed.reason, /revoked|unknown/);
    assert.equal(hub.isAuthenticated(hello.sid), false);
    c.close();
  }, { registry });
});

// Revoking must reach a session that is ALREADY authenticated, or "forget this device" only takes
// effect the next time the television happens to reconnect.
test('revoking drops a live authenticated session', async () => {
  const registry = R.emptyRegistry();
  const paired = R.confirmPairing(registry, { code: R.beginPairing(registry, { sessionId: 'e', receiverId: 'lg-1' }).code });

  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }));
    c.send(proto.envelope('auth', hello.sid, { receiverId: 'lg-1', proof: R.proofFor(paired.token, hello.nonce) }));
    await c.next('auth.ok');
    assert.equal(hub.isAuthenticated(hello.sid), true);

    hub.revoke('lg-1');
    await c.quiet('nothing');
    assert.equal(hub.isAuthenticated(hello.sid), false, 'a revoked receiver kept its authority');
    c.close();
  }, { registry });
});

// ---- logging ----------------------------------------------------------------------------------

test('no secret ever reaches the log', async () => {
  await withHub(async ({ hub, port, logs, registry }) => {
    const { c, hello } = await greet(port, 'lg-secretcheck');
    c.send(proto.envelope('pair.request', hello.sid, {}));
    const ch = await c.next('pair.challenge');
    hub.confirmPairing(ch.code);
    const acc = await c.next('pair.accepted');

    const all = logs.join('\n');
    assert.ok(!all.includes(acc.token), 'the credential was logged');
    assert.ok(!all.includes(registry.receivers['lg-secretcheck'].token), 'the stored credential was logged');
    assert.ok(!all.includes(String(ch.code)), 'the pairing code was logged');
    assert.ok(!all.includes(hello.nonce), 'the auth nonce was logged');
    // And identifiers are truncated rather than dumped whole.
    assert.ok(!all.includes('lg-secretcheck'), 'a full receiver id was logged untruncated');
    assert.ok(all.includes('lg-secre'), 'the truncated id should still appear, or the log is useless');
    c.close();
  });
});
