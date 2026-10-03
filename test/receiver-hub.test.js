'use strict';

// The hub over a REAL socket, against a real http.Server upgrade.
//
// Deliberately not a mock: the whole value of the hub is that it survives what a TCP stream does to
// frames, and a fake transport that delivers whole messages would test none of that.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const wsf = require('../src/main/ws-frame');
const proto = require('../src/main/receiver-protocol');
const createReceiverHub = require('../src/main/receiver-hub');
const R = require('../src/main/receiver-registry');

// Never await a hub event unbounded. When the auth gate stopped emitting `hello` before
// authentication, an unbounded `await new Promise(res => hub.once('hello', res))` in this file hung
// the WHOLE suite instead of failing one test — the output simply stopped, which is far harder to
// diagnose than a red assertion.
function once(hub, event, ms) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out waiting for hub event ' + event)), ms || 3000);
    hub.once(event, (e) => { clearTimeout(timer); res(e); });
  });
}

// Put a paired receiver in the registry and drive the proof exchange, so tests that are about
// TRANSPORT do not have to be about pairing as well.
function pairedRegistry(receiverId) {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 'seed', receiverId, name: 'Living Room LG', platform: 'webos' });
  const c = R.confirmPairing(reg, { code: b.code });
  return { reg, token: c.token };
}

// A minimal client. Client-to-server frames MUST be masked (RFC 6455 §5.3) — an unmasked client
// frame is a protocol violation, so this exercises the server's unmasking for real.
function connect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write([
        'GET ' + (path || '/receiver') + ' HTTP/1.1',
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n'));
    });
    let head = Buffer.alloc(0);
    let upgraded = false;
    let buf = Buffer.alloc(0);
    let st = null;
    const msgs = [];
    const waiters = [];
    const client = {
      socket,
      msgs,
      send(m) {
        const body = Buffer.from(proto.serialize(m), 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(body);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        let head2;
        if (body.length < 126) { head2 = Buffer.alloc(2); head2[1] = 0x80 | body.length; }
        else { head2 = Buffer.alloc(4); head2[1] = 0x80 | 126; head2.writeUInt16BE(body.length, 2); }
        head2[0] = 0x81;
        socket.write(Buffer.concat([head2, mask, masked]));
      },
      next(type) {
        const found = msgs.findIndex((m) => m.type === type);
        if (found >= 0) return Promise.resolve(msgs.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for ' + type)), 4000);
          waiters.push({ type, res, timer });
        });
      },
      close() { try { socket.destroy(); } catch (e) {} }
    };
    socket.on('data', (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        const headers = head.slice(0, i).toString();
        if (!/101 Switching Protocols/.test(headers)) return reject(new Error('no upgrade: ' + headers.split('\r\n')[0]));
        upgraded = true;
        buf = head.slice(i + 4);
        resolve(client);
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
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
  const hub = createReceiverHub({ registry: (opts && opts.registry) || undefined });
  hub.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn({ hub, port, server });
  } finally {
    try { hub.teardown(); } catch (e) {}
    await new Promise((r) => server.close(r));
  }
}

test('a receiver connects and is greeted', async () => {
  await withHub(async ({ port }) => {
    const c = await connect(port);
    const hello = await c.next('hello');
    assert.equal(hello.role, 'controller');
    assert.equal(hello.v, proto.PROTOCOL_VERSION);
    assert.ok(hello.sid, 'the greeting names the session');
    c.close();
  });
});

// The greeting reaches listeners only AFTER authentication — see the hub's inbound gate. Before the
// pairing milestone this test asserted the same thing on an open socket.
test('the hub emits the receiver identity once authenticated', async () => {
  const { reg, token } = pairedRegistry('lg-abc');
  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const greeting = await c.next('hello');
    const seen = once(hub, 'hello');
    c.send(proto.helloFrom(greeting.sid, { receiverId: 'lg-abc', name: 'Living Room LG', platform: 'webos' }));
    c.send(proto.auth(greeting.sid, { receiverId: 'lg-abc', proof: R.proofFor(token, greeting.nonce) }));
    const e = await seen;
    assert.equal(e.receiver.receiverId, 'lg-abc');
    assert.equal(e.receiver.name, 'Living Room LG');
    assert.equal(hub.receiverFor(e.sessionId).platform, 'webos');
    c.close();
  }, { registry: reg });
});

test('a command reaches the receiver and an event comes back', async () => {
  const { reg, token } = pairedRegistry('lg-abc');
  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const greeting = await c.next('hello');
    c.send(proto.helloFrom(greeting.sid, { receiverId: 'lg-abc' }));
    c.send(proto.auth(greeting.sid, { receiverId: 'lg-abc', proof: R.proofFor(token, greeting.nonce) }));
    await c.next('auth.ok');
    hub.send(greeting.sid, proto.load(greeting.sid, { url: 'http://x/media.m3u8', mediaId: 'm1' }));
    const load = await c.next('load');
    assert.equal(load.url, 'http://x/media.m3u8');

    const pos = once(hub, 'position').then((e) => e.msg);
    c.send(proto.position(greeting.sid, { mediaId: 'm1', currentTime: 42.5, durationSec: 100, bufferedUntil: 60 }));
    const got = await pos;
    assert.equal(got.currentTime, 42.5);
    assert.equal(got.bufferedUntil, 60);
    c.close();
  }, { registry: reg });
});

test('ping is answered with pong carrying the nonce', async () => {
  await withHub(async ({ port }) => {
    const c = await connect(port);
    const greeting = await c.next('hello');
    c.send(proto.ping(greeting.sid, { nonce: 'n7' }));
    const pong = await c.next('pong');
    assert.equal(pong.nonce, 'n7');
    c.close();
  });
});

test('a malformed message is logged and does not kill the session', async () => {
  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const greeting = await c.next('hello');
    // Raw garbage, framed correctly — the socket is fine, the payload is not.
    const body = Buffer.from('{"v":1,"type":"nonsense"}', 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const head = Buffer.alloc(2); head[0] = 0x81; head[1] = 0x80 | body.length;
    c.socket.write(Buffer.concat([head, mask, masked]));
    // The session must still work afterwards.
    c.send(proto.ping(greeting.sid, { nonce: 'still-here' }));
    const pong = await c.next('pong');
    assert.equal(pong.nonce, 'still-here');
    assert.equal(hub.sessions().length, 1, 'the session was dropped over one bad message');
    c.close();
  });
});

test('a wrong path is refused rather than left hanging', async () => {
  await withHub(async ({ port }) => {
    await assert.rejects(() => connect(port, '/not-the-receiver'), /no upgrade|404/);
  });
});

test('disconnect is reported with the receiver identity', async () => {
  const { reg, token } = pairedRegistry('lg-abc');
  await withHub(async ({ hub, port }) => {
    const c = await connect(port);
    const greeting = await c.next('hello');
    c.send(proto.helloFrom(greeting.sid, { receiverId: 'lg-abc', name: 'Living Room LG' }));
    c.send(proto.auth(greeting.sid, { receiverId: 'lg-abc', proof: R.proofFor(token, greeting.nonce) }));
    await c.next('auth.ok');
    const gone = once(hub, 'disconnected');
    const t0 = Date.now();
    c.close();
    const e = await gone;
    // Promptly, not eventually. A television that has gone must be noticed on the socket closing,
    // not by a write failing two ping intervals later: for those 20s the Mac believes a film is
    // still playing on a receiver that is not there, which is exactly the stale-state problem this
    // channel exists to remove. Measured before the fix: 20,004ms.
    const took = Date.now() - t0;
    assert.ok(took < 2000, 'disconnect took ' + took + 'ms to notice; a closing socket should be immediate');
    assert.equal(e.sessionId, greeting.sid);
    assert.equal(e.receiver.receiverId, 'lg-abc', 'a reconnecting TV must be recognisable as the same device');
    assert.equal(hub.sessions().length, 0);
  }, { registry: reg });
});

// Two televisions is the ordinary future case, not an exotic one.
test('two receivers get independent sessions', async () => {
  const reg = R.emptyRegistry();
  const ta = R.confirmPairing(reg, { code: R.beginPairing(reg, { sessionId: 'sa', receiverId: 'lg-A' }).code }).token;
  const tb = R.confirmPairing(reg, { code: R.beginPairing(reg, { sessionId: 'sb', receiverId: 'lg-B' }).code }).token;
  await withHub(async ({ hub, port }) => {
    const a = await connect(port);
    const b = await connect(port);
    const ha = await a.next('hello');
    const hb = await b.next('hello');
    assert.notEqual(ha.sid, hb.sid);
    assert.equal(hub.sessions().length, 2);
    a.send(proto.helloFrom(ha.sid, { receiverId: 'lg-A' }));
    a.send(proto.auth(ha.sid, { receiverId: 'lg-A', proof: R.proofFor(ta, ha.nonce) }));
    await a.next('auth.ok');
    b.send(proto.helloFrom(hb.sid, { receiverId: 'lg-B' }));
    b.send(proto.auth(hb.sid, { receiverId: 'lg-B', proof: R.proofFor(tb, hb.nonce) }));
    await b.next('auth.ok');
    hub.send(ha.sid, proto.pause(ha.sid));
    const got = await a.next('pause');
    assert.equal(got.type, 'pause');
    assert.equal(b.msgs.filter((m) => m.type === 'pause').length, 0, 'a command leaked to the other receiver');
    a.close(); b.close();
  }, { registry: reg });
});
