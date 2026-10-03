'use strict';

// The application-facing receiver service: lifecycle, and the load/adopt boundary.
//
// The second half of this file is the important half. Hardware once showed healthy playback at
// 5905.4s restart at 7.8s because a controller loaded on every greeting. These tests exist so that
// cannot come back through the PRODUCTION path, which has more reasons to be tempted — a resume
// point, an app restart, a reconnect, a user re-picking the film that is already playing.

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-svcroot-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const wsf = require('../src/main/ws-frame');
const proto = require('../src/main/receiver-protocol');
const R = require('../src/main/receiver-registry');
const store = require('../src/main/receiver-store');
const targetProjection = require('../src/main/receiver-targets');
const createReceiverService = require('../src/main/receiver-service');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-svc-'));

// A stand-in for lanserver's onServer seam, so these tests exercise the real attach path without
// starting the whole media server.
function fakeLan(server) {
  const subs = [];
  return {
    onServer(fn) { subs.push(fn); if (server) fn(server); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    _announce(s) { for (const fn of subs) fn(s); }
  };
}

function client(port, initialMessage) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const handshake = ['GET /receiver HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version: 13', '', ''].join('\r\n');
      socket.write(initialMessage ? Buffer.concat([Buffer.from(handshake), wsf.encodeText(proto.serialize(initialMessage))]) : handshake);
    });
    let head = Buffer.alloc(0), up = false, buf = Buffer.alloc(0), st = null;
    const msgs = [], waiters = [];
    const c = {
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
      quiet(type, ms) { return new Promise((res) => setTimeout(() => res(!msgs.some((m) => m.type === type)), ms || 350)); },
      close() { try { socket.destroy(); } catch (e) {} }
    };
    socket.on('data', (chunk) => {
      if (!up) {
        head = Buffer.concat([head, chunk]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!/101 Switching/.test(head.slice(0, i).toString())) return reject(new Error('no upgrade'));
        up = true; buf = head.slice(i + 4); resolve(c);
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

// A registry file with one paired receiver already in it, as a real second run would have.
function seeded(dir, id) {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 'seed', receiverId: id, name: 'Living Room LG', platform: 'webos' });
  const token = R.confirmPairing(reg, { code: b.code }).token;
  const file = path.join(dir, 'receivers.json');
  store.save(file, reg);
  return { file, token };
}

async function withService(fn, opts) {
  const dir = tmpdir();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const seed = (opts && opts.seed) ? seeded(dir, opts.seed) : { file: path.join(dir, 'receivers.json'), token: null };
  const logs = [];
  const svc = createReceiverService({ storePath: seed.file, lan: fakeLan(server), onLog: (m) => logs.push(m), beaconPort: 0, onSelectTrack: opts && opts.onSelectTrack });
  svc.start();
  try {
    await fn({ svc, server, port: server.address().port, token: seed.token, file: seed.file, logs, dir });
  } finally {
    svc.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Connect and authenticate as an already-paired receiver, optionally announcing current playback.
async function authed(port, token, id, playing) {
  const c = await client(port);
  const hello = await c.next('hello');
  c.send(Object.assign(proto.helloFrom(hello.sid, { receiverId: id, name: 'Living Room LG', platform: 'webos', version: '0.2.9' }),
    playing === undefined ? {} : { playing }));
  c.send(proto.auth(hello.sid, { receiverId: id, proof: R.proofFor(token, hello.nonce) }));
  await c.next('auth.ok');
  return { c, hello };
}

// ---- lifecycle --------------------------------------------------------------------------------

test('the service starts once and reports paired receivers as targets', async () => {
  await withService(async ({ svc }) => {
    svc.start();                      // a second call must not build a second hub
    const t = svc.targets();
    assert.equal(t.length, 1);
    assert.equal(t[0].id, 'lg-1');
    assert.equal(t[0].status, 'offline');
  }, { seed: 'lg-1' });
});

test('the receiver version announced in the greeting reaches the device list', async () => {
  await withService(async ({ svc, port, token }) => {
    await authed(port, token, 'lg-1');
    assert.equal(svc.targets()[0].version, '0.2.9');
  }, { seed: 'lg-1' });
});

test('an authenticated receiver becomes online, and disconnecting takes it offline', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1');
    assert.equal(svc.targets()[0].status, 'online');
    const gone = new Promise((res) => svc.once('targets', res));
    c.close();
    await gone;
    assert.equal(svc.targets()[0].status, 'offline');
  }, { seed: 'lg-1' });
});

test('pairing state survives a service restart', async () => {
  const dir = tmpdir();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const file = path.join(dir, 'receivers.json');
  try {
    const a = createReceiverService({ storePath: file, lan: fakeLan(server), beaconPort: 0 });
    a.start();
    const c = await client(server.address().port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-1', name: 'Living Room LG' }));
    c.send(proto.envelope('pair.request', hello.sid, {}));
    const ch = await c.next('pair.challenge');
    a.confirmPairing(ch.code);
    const acc = await c.next('pair.accepted');
    c.close();
    a.stop();

    // A whole new service, as after an application restart.
    const b = createReceiverService({ storePath: file, lan: fakeLan(server), beaconPort: 0 });
    b.start();
    try {
      assert.equal(b.targets().length, 1, 'the pairing did not survive the restart');
      const c2 = await client(server.address().port);
      const h2 = await c2.next('hello');
      c2.send(proto.helloFrom(h2.sid, { receiverId: 'lg-1' }));
      c2.send(proto.auth(h2.sid, { receiverId: 'lg-1', proof: R.proofFor(acc.token, h2.nonce) }));
      await c2.next('auth.ok');
      assert.equal(b.targets()[0].status, 'online');
      c2.close();
    } finally { b.stop(); }
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revocation survives a restart', async () => {
  await withService(async ({ svc, file, port, token }) => {
    svc.revoke('lg-1');
    svc.stop();
    const back = store.load(file).registry;
    const nonce = R.newNonce();
    assert.equal(R.authenticate(back, { receiverId: 'lg-1', nonce, proof: R.proofFor(token, nonce) }).ok, false,
      'a forgotten television came back trusted');
    assert.equal(port > 0, true);
  }, { seed: 'lg-1' });
});

test('stopping leaves no sockets behind', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1');
    assert.equal(svc.targets()[0].status, 'online');
    svc.stop();
    assert.deepEqual(svc.targets(), [], 'targets survived a stop');
    c.close();
  }, { seed: 'lg-1' });
});

test('no credential ever reaches the log', async () => {
  await withService(async ({ svc, logs, port, token }) => {
    await authed(port, token, 'lg-1');
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/media.m3u8', title: 'Film' });
    const all = logs.join('\n');
    assert.ok(!all.includes(token), 'the credential was logged');
    assert.ok(!all.includes('lg-1' + 'xxxx'), 'sanity');
  }, { seed: 'lg-1' });
});

// ---- the load / adopt boundary -----------------------------------------------------------------

test('selecting media for a receiver holding nothing DOES load', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    const r = svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8', startSec: 0 });
    assert.equal(r.loaded, true);
    const load = await c.next('load');
    assert.equal(load.url, 'http://mac/a.m3u8');
    c.close();
  }, { seed: 'lg-1' });
});

test('selecting DIFFERENT media DOES load', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 500, state: 'playing' });
    // The service learns what it is holding from the greeting it just authenticated.
    await c.quiet('load');
    const r = svc.play('lg-1', { mediaId: 'm2', url: 'http://mac/b.m3u8' });
    assert.equal(r.loaded, true, 'a different film must actually be loaded');
    const load = await c.next('load');
    assert.equal(load.mediaId, 'm2');
    c.close();
  }, { seed: 'lg-1' });
});

test('choosing the film ALREADY playing does NOT reload it', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 5905.4, state: 'playing' });
    await c.quiet('load');
    const r = svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8', startSec: 0 });
    assert.equal(r.loaded, false, 're-picking the current film restarted it');
    assert.equal(await c.quiet('load'), true, 'a LOAD was sent for media already playing');
    c.close();
  }, { seed: 'lg-1' });
});

// THE regression. Before shouldLoad existed, this restarted the film from 5905.4s to 7.8s.
test('an authenticated reconnect while playing does NOT load', async () => {
  await withService(async ({ svc, port, token, logs }) => {
    const first = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await first.c.next('load');
    first.c.close();

    // The television reconnects, still holding the film, exactly as it does after a socket drop.
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 5905.4, state: 'playing' });
    assert.equal(await again.c.quiet('load'), true, 'the reconnect restarted the film');
    assert.ok(logs.join('\n').includes('adopted existing playback at 5905.4s'),
      'the adopt decision should be visible in the log — "why did we not load?" must be answerable');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('a receiver that FINISHED the film is loaded again', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.close();
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 5980, state: 'ended' });
    const load = await again.c.next('load');
    assert.equal(load.mediaId, 'm1', 'a finished film should be reloadable');
    again.c.close();
  }, { seed: 'lg-1' });
});

// A resume point is DATA on the first load. It must not become a second reload policy.
test('a resume point sets the start position but never forces a reload', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8', startSec: 1800 });
    const load = await c.next('load');
    assert.equal(load.startSec, 1800, 'the resume point did not reach the receiver');
    c.close();

    // Reconnect, playing PAST the resume point. A resume point that behaved like a policy would drag
    // the viewer back to 1800s — the exact shape of the old cast-pipe bug in resume-point.js.
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 2400, state: 'playing' });
    assert.equal(await again.c.quiet('load'), true, 'a stored resume point restarted healthy playback');
    assert.equal(svc.targets()[0].playback.currentTime, 2400, 'the receiver position should be adopted, not the resume point');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('a paused receiver is adopted, not restarted', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.close();
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 606.2, state: 'paused' });
    assert.equal(await again.c.quiet('load'), true, 'a paused film was restarted');
    assert.equal(svc.targets()[0].playback.state, 'paused');
    again.c.close();
  }, { seed: 'lg-1' });
});

// ---- security -----------------------------------------------------------------------------------

test('an unpaired receiver is never sent a media URL', async () => {
  await withService(async ({ svc, port }) => {
    const c = await client(port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'stranger' }));
    const r = svc.play('stranger', { mediaId: 'm1', url: 'http://mac/private.m3u8' });
    assert.equal(r.ok, false, 'the service tried to play to an unauthenticated receiver');
    assert.equal(await c.quiet('load'), true, 'a media URL reached an unpaired receiver');
    c.close();
  }, { seed: 'lg-1' });
});

test('revoking removes the target and its authority at once', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1');
    assert.equal(svc.targets().length, 1);
    svc.revoke('lg-1');
    assert.deepEqual(svc.targets(), [], 'a revoked receiver was still offered as a target');
    assert.equal(svc.command('lg-1', 'pause').ok, false, 'a revoked receiver could still be commanded');
    c.close();
  }, { seed: 'lg-1' });
});

test('registry.observed stays null through pairing and playback', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.send(proto.capabilities(0, { reported: { hevc: 'probably' } }));
    await c.quiet('nothing');
    // Pairing proves identity, not codecs. Nothing in this milestone may write capability evidence.
    assert.equal(svc._registry().receivers['lg-1'].observed, null,
      'pairing wrote capability evidence — reported is not observed');
    c.close();
  }, { seed: 'lg-1' });
});

// Found by running the real application: lanserver listens LAZILY, only when something casts. At
// rest there was no open port at all, so a television sweeping the network found nothing and could
// never connect — the receiver is the one consumer that must be able to reach Spritz before any
// media exists. Starting the service therefore has to bring the LAN server up.
test('starting the service makes Spritz reachable on the LAN', async () => {
  const dir = tmpdir();
  const realLan = require('../src/main/lanserver')({});
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), lan: realLan, beaconPort: 0 });
  try {
    svc.start();
    // Give the listen a tick; ensureServer is asynchronous.
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(realLan.serverPort() > 0, 'nothing was listening, so no receiver could ever find Spritz');

    // And the probe a television uses actually answers on it.
    const body = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + realLan.serverPort() + '/spritz/hello', (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    assert.equal(JSON.parse(body).spritz, true);
  } finally {
    svc.stop();
    realLan.teardown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Found on hardware, in the real UI: a television that had JUST paired showed as "offline" in the
// device list, and could not be played to. Pairing authenticates the socket — the hub sets the
// connection to AUTHENTICATED inside confirmPairing — but it emits `paired`, not `authenticated`, so
// nothing told the service the session was now trusted. The receiver was connected, authenticated
// and unusable.
test('a receiver is online immediately after pairing, without reconnecting', async () => {
  const dir = tmpdir();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), lan: fakeLan(server), beaconPort: 0 });
  svc.start();
  try {
    const c = await client(server.address().port);
    const hello = await c.next('hello');
    c.send(proto.helloFrom(hello.sid, { receiverId: 'lg-new', name: 'Living Room LG', platform: 'webos' }));
    c.send(proto.envelope('pair.request', hello.sid, {}));
    const ch = await c.next('pair.challenge');
    assert.equal(svc.confirmPairing(ch.code).ok, true);
    await c.next('pair.accepted');

    assert.equal(svc.targets()[0].status, 'online',
      'a freshly paired receiver showed as offline — it is connected and authenticated');
    // And it must actually be playable, which is what "online" is claiming.
    const r = svc.play('lg-new', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    assert.equal(r.ok, true, 'a freshly paired receiver could not be played to: ' + r.why);
    const load = await c.next('load');
    assert.equal(load.mediaId, 'm1');
    c.close();
  } finally {
    svc.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// "Genuinely stale receiver media DOES load."
//
// A receiver that reports a FATAL playback error is no longer holding a playable film, whatever it
// said a moment ago. If the service keeps believing the old claim, choosing that film again does
// nothing — shouldLoad is told the receiver already has it, and the viewer clicks into silence.
// Measured on hardware after quitting Spritz mid-playback: "already holds this film — not
// reloading", twice, with a blank television.
test('a fatal playback error clears what the receiver is believed to hold', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.send(proto.loaded(hello.sid, { mediaId: 'm1', durationSec: 100 }));
    // Actually PLAYING. Without this the session sits at 'idle', shouldLoad reloads for that reason
    // alone, and the assertion below would pass whether or not the fatal error was handled.
    c.send(proto.state(hello.sid, { mediaId: 'm1', state: 'playing' }));
    await c.quiet('nothing');
    assert.equal(svc.targets()[0].playback.mediaId, 'm1');
    assert.equal(svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' }).loaded, false,
      'precondition: while healthy, re-picking must NOT reload');

    const errors = []; svc.on('playback-error', e => errors.push(e));
    c.send(proto.error(hello.sid, { mediaId: 'm1', code: '4', message: 'source gone', fatal: true }));
    await c.quiet('nothing');

    // Choosing it again must now actually load it.
    const r = svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    assert.equal(errors[0].mediaId, 'm1');
    assert.equal(errors[0].identitySupplied, true);
    assert.equal(errors[0].mediaIdentitySupplied, true);
    assert.equal(errors[0].epochIdentitySupplied, false);
    assert.equal(r.loaded, true, 'the film was not reloaded after a fatal error — the viewer clicks into silence');
    const load = await c.next('load');
    assert.equal(load.mediaId, 'm1');
    c.close();
  }, { seed: 'lg-1' });
});

// Seen on hardware after a fatal decode error: the dead video element still fires a trailing DOM
// `pause`, and the receiver dutifully reported "paused" — with no media. The Mac then logged a
// playback transition for a film that no longer exists and showed the television as paused on
// nothing. A state report that names no media, arriving at a session holding no media, is not
// about playback at all, and is ignored.
test('a state report with no media, after a fatal error, does not resurrect playback', async () => {
  await withService(async ({ svc, port, token, logs }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.send(proto.loaded(hello.sid, { mediaId: 'm1', durationSec: 100 }));
    c.send(proto.state(hello.sid, { mediaId: 'm1', state: 'playing' }));
    c.send(proto.error(hello.sid, { mediaId: 'm1', code: '3', message: 'decode', fatal: true }));
    await c.quiet('nothing');
    assert.equal(svc.targets()[0].playback.state, 'idle', 'precondition: a fatal error leaves the session idle');
    const before = logs.length;

    // The trailing DOM pause, as the television actually sends it.
    c.send(proto.state(hello.sid, { mediaId: null, state: 'paused' }));
    await c.quiet('nothing');
    assert.equal(svc.targets()[0].playback.state, 'idle', 'a pause with no media was reported as playback');
    assert.ok(!logs.slice(before).some((l) => /paused/.test(l)), 'a pause of nothing was logged as a transition');
    c.close();
  }, { seed: 'lg-1' });
});

// A NON-fatal error must not throw away healthy playback: the receiver reports autoplay refusal
// this way, and a film sitting paused is still a film the receiver is holding.
test('a non-fatal error does not discard what the receiver holds', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.send(proto.loaded(hello.sid, { mediaId: 'm1', durationSec: 100 }));
    c.send(proto.state(hello.sid, { mediaId: 'm1', state: 'playing' }));
    c.send(proto.error(hello.sid, { mediaId: 'm1', code: 'autoplay-blocked', message: 'no', fatal: false }));
    await c.quiet('nothing');
    const r = svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    assert.equal(r.loaded, false, 'a recoverable error restarted the film');
    c.close();
  }, { seed: 'lg-1' });
});

// ---- transport epochs through the service ------------------------------------------------------
//
// The same film can have more than one TRANSPORT (transport-epoch.js). The service's job is to carry
// the epoch as a fact — into LOAD, out of the receiver's reports, into shouldLoad — and never to
// decide anything about it.

test('a plan with an epoch sends a LOAD naming it, and the receiver re-greeting with that epoch is adopted', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    const r = svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/vod/t/epoch-1/media.m3u8' });
    assert.equal(r.loaded, true);
    const load = await c.next('load');
    assert.equal(load.epoch, 'epoch-1', 'the LOAD names the transport');
    c.close();
    // Control drops; the television reconnects holding the same film in the same epoch.
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', epoch: 'epoch-1', currentTime: 412.5, state: 'playing' });
    assert.equal(await again.c.quiet('load'), true, 'a reconnect within the same epoch must ADOPT, not reload');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('after a far seek made a newer epoch, a receiver still holding the old one is LOADED onto the new transport', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'm1', epoch: 'epoch-1', currentTime: 12.5, state: 'playing' });
    await c.quiet('load');
    const r = svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-2', url: 'http://mac/vod/t/epoch-2/media.m3u8' });
    assert.equal(r.loaded, true, 'same film, newer transport: the receiver must be moved');
    const load = await c.next('load');
    assert.equal(load.mediaId, 'm1', 'the film did not change');
    assert.equal(load.epoch, 'epoch-2');
    c.close();
  }, { seed: 'lg-1' });
});

test('a position report carries the epoch it was measured in', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', { mediaId: 'm1', epoch: 'epoch-2', currentTime: 1, state: 'playing' });
    await c.quiet('load');
    const got = new Promise((resolve) => svc.on('position', resolve));
    c.send(proto.position(hello.sid, { mediaId: 'm1', epoch: 'epoch-2', currentTime: 7.2, durationSec: 100, paused: false }));
    const p = await got;
    assert.equal(p.epoch, 'epoch-2');
    assert.equal(p.currentTime, 7.2, 'epoch-LOCAL, as the television counts it; the epoch says what that means');
    c.close();
  }, { seed: 'lg-1' });
});

// ---- dropping control on purpose ---------------------------------------------------------------
//
// The reconnect/adopt behaviour is the one this receiver was hardest won on, and until now the
// only way to exercise it on hardware was the dev harness. This is the production lever: close a
// receiver's CONTROL socket and nothing else. The television keeps its media connection, notices,
// reconnects, and is adopted.

test('dropControl closes the receiver\'s control socket and the reconnect is adopted, not reloaded', async () => {
  await withService(async ({ svc, port, token, logs }) => {
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'm1', epoch: 'epoch-3', currentTime: 828.7, state: 'playing' });
    await c.quiet('load');
    // The application wants what the television already holds — the state a real cast is in.
    const r0 = svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-3', url: 'http://mac/vod/t/epoch-3/media.m3u8' });
    assert.equal(r0.loaded, false, 'asking for the film it holds does not reload it');
    // Bounded: the hub's idle timeout would close the socket eventually anyway, and a test that
    // waited indefinitely could not tell a deliberate drop from that.
    const closed = new Promise((resolve) => c.socket.once('close', () => resolve('closed')));
    const r = svc.dropControl('lg-1');
    assert.equal(r.ok, true);
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('still open'), 2000))]);
    assert.equal(outcome, 'closed', 'the control socket was closed promptly, by the drop');
    // The television comes back holding exactly what it had.
    const again = await authed(port, token, 'lg-1', { mediaId: 'm1', epoch: 'epoch-3', currentTime: 830.2, state: 'playing' });
    assert.equal(await again.c.quiet('load'), true, 'a reconnect after a control drop must ADOPT');
    assert.ok(logs.some((l) => /adopted existing playback at 830\.2s/.test(l)), 'and say so');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('dropControl on a receiver that is not connected says so', async () => {
  await withService(async ({ svc }) => {
    assert.equal(svc.dropControl('nobody').ok, false);
  }, { seed: 'lg-1' });
});

// ---- stopping releases the media --------------------------------------------------------------
//
// Measured on hardware (2026-09-03): after `stop`, the television went idle and the Mac's live-HLS
// ffmpeg kept transcoding the film for nobody until the NEXT cast happened to cancel it. Stop is the
// application saying it is done with this playback, and the media session is part of that.

// Measured on hardware (2026-09-16): Stop removed the picture and the LAN media session, then the
// receiver sent exactly `{ type: 'state', state: 'idle', mediaId: null }`. The desktop changed only
// the state word and kept publishing the old film, time and duration. This uses the real wire path
// and checks both the event and the public snapshot: an explicit no-media idle report is the TV's
// acknowledgement that its presentation state is empty.
test('an explicit no-media idle report clears stale playback presentation state', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: '9887df4163aa19ed', epoch: 'epoch-2', url: 'http://mac/a.m3u8' });
    await c.next('load');
    c.send(proto.loaded(hello.sid, { mediaId: '9887df4163aa19ed', epoch: 'epoch-2', durationSec: 3302 }));
    c.send(proto.state(hello.sid, { mediaId: '9887df4163aa19ed', epoch: 'epoch-2', state: 'playing' }));
    c.send(proto.position(hello.sid, {
      mediaId: '9887df4163aa19ed', epoch: 'epoch-2', currentTime: 2832.903, durationSec: 3302,
      paused: false, bufferedUntil: 2860
    }));
    await c.quiet('nothing');
    const beforeStop = svc.targets()[0].playback;
    assert.deepEqual({
      state: beforeStop.state, mediaId: beforeStop.mediaId,
      currentTime: beforeStop.currentTime, durationSec: beforeStop.durationSec
    }, {
      state: 'playing', mediaId: '9887df4163aa19ed', currentTime: 2832.903, durationSec: 3302
    }, 'precondition: the desktop holds the hardware state that became stale');

    const changed = new Promise((resolve) => svc.once('targets', resolve));
    // The actual Stop acknowledgement: position, duration and epoch are deliberately omitted.
    c.send(proto.envelope('state', hello.sid, { state: 'idle', mediaId: null }));
    const published = await changed;

    assert.equal(published[0].status, 'online', 'clearing playback must not disconnect the receiver');
    assert.deepEqual(published[0].playback, {
      state: 'idle', mediaId: null, epoch: null, currentTime: null, durationSec: null,
      ageMs: published[0].playback.ageMs
    });
    const current = svc.targets()[0].playback;
    assert.deepEqual(
      { state: current.state, mediaId: current.mediaId, currentTime: current.currentTime, durationSec: current.durationSec },
      { state: published[0].playback.state, mediaId: published[0].playback.mediaId,
        currentTime: published[0].playback.currentTime, durationSec: published[0].playback.durationSec },
      'the event and public snapshot disagree about the cleared playback facts'
    );
    c.close();
  }, { seed: 'lg-1' });
});

test('idle with receiver flags clears every presentation field before target projection', async () => {
  const projected = [];
  const targetsFrom = targetProjection.targetsFrom;
  targetProjection.targetsFrom = (input) => {
    projected.push((input.sessions || []).map((s) => Object.assign({}, s)));
    return targetsFrom(input);
  };
  try {
    await withService(async ({ svc, port, token }) => {
      const { c, hello } = await authed(port, token, 'lg-1', null);
      svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-2', url: 'http://mac/a.m3u8' });
      await c.next('load');
      c.send(proto.loaded(hello.sid, { mediaId: 'm1', epoch: 'epoch-2', durationSec: 3302 }));
      c.send(proto.state(hello.sid, {
        mediaId: 'm1', epoch: 'epoch-2', state: 'buffering', flags: ['waiting', 'stalled']
      }));
      c.send(proto.position(hello.sid, {
        mediaId: 'm1', epoch: 'epoch-2', currentTime: 2832.903, durationSec: 3302,
        paused: false, bufferedUntil: 2860
      }));
      await c.quiet('nothing');

      const changed = new Promise((resolve) => svc.once('targets', resolve));
      // Reachable from the reviewed receiver when Stop occurs while waiting/stalled. The receiver
      // omits epoch, clock and duration; explicit mediaId:null is the authoritative unload fact.
      c.send(proto.envelope('state', hello.sid, {
        state: 'idle', mediaId: null, flags: ['waiting', 'stalled']
      }));
      await changed;

      const observed = projected[projected.length - 1].find((s) => s.receiverId === 'lg-1');
      assert.deepEqual({
        mediaId: observed.mediaId,
        epoch: observed.epoch,
        currentTime: observed.currentTime,
        durationSec: observed.durationSec,
        paused: observed.paused,
        bufferedUntil: observed.bufferedUntil,
        flags: observed.flags
      }, {
        mediaId: null, epoch: null, currentTime: null, durationSec: null,
        paused: null, bufferedUntil: null, flags: []
      });
      const snapshot = svc.targets()[0].playback;
      assert.deepEqual(snapshot, {
        state: 'idle', mediaId: null, epoch: null, currentTime: null, durationSec: null,
        ageMs: snapshot.ageMs
      });

      c.send(proto.envelope('state', hello.sid, { state: 'idle', mediaId: null, flags: [] }));
      await c.quiet('nothing');
      const repeated = projected[projected.length - 1].find((s) => s.receiverId === 'lg-1');
      assert.deepEqual(repeated.flags, []);
      c.close();
    }, { seed: 'lg-1' });
  } finally {
    Object.defineProperty(targetProjection, 'targetsFrom', {
      value: targetsFrom, writable: true, configurable: true, enumerable: true
    });
  }
});

test('omitting mediaId from a partial state report is not an unload', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', currentTime: 41.5, state: 'playing'
    });
    await c.quiet('load');
    c.send(proto.loaded(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', durationSec: 100 }));
    c.send(proto.position(hello.sid, {
      mediaId: 'm1', epoch: 'epoch-1', currentTime: 42, durationSec: 100,
      paused: false, bufferedUntil: 60
    }));
    await c.quiet('nothing');

    const changed = new Promise((resolve) => svc.once('targets', resolve));
    c.send(proto.envelope('state', hello.sid, { state: 'idle', flags: [] }));
    const published = await changed;
    assert.equal(published[0].playback.mediaId, 'm1');
    assert.equal(published[0].playback.currentTime, 42);
    assert.equal(published[0].playback.durationSec, 100);
    c.close();
  }, { seed: 'lg-1' });
});

test('Stop waits for the receiver report before clearing its public playback state', async () => {
  const cancelled = [];
  await withService(async ({ svc, port, token }) => {
    svc._lanForTest().cancelActive = () => cancelled.push(Date.now());
    const { c, hello } = await authed(port, token, 'lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', currentTime: 10, state: 'playing'
    });
    await c.quiet('load');
    assert.equal(svc.play('lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/a.m3u8'
    }).loaded, false);

    assert.equal(svc.command('lg-1', 'stop').ok, true);
    await c.next('stop');
    assert.equal(cancelled.length, 1, 'Stop releases the controller-owned media session');
    assert.equal(svc.targets()[0].playback.mediaId, 'm1',
      'sending Stop invented an acknowledgement that the receiver had unloaded');
    assert.equal(svc.targets()[0].playback.state, 'playing');

    const changed = new Promise((resolve) => svc.once('targets', resolve));
    c.send(proto.envelope('state', hello.sid, { state: 'idle', mediaId: null }));
    await changed;
    assert.equal(svc.targets()[0].playback.mediaId, null);

    // The receiver can repeat its final observation. It must not release resources a second time or
    // reconstruct any part of the old presentation.
    c.send(proto.envelope('state', hello.sid, { state: 'idle', mediaId: null }));
    await c.quiet('nothing');
    assert.equal(cancelled.length, 1);
    const idlePlayback = svc.targets()[0].playback;
    assert.deepEqual(idlePlayback, {
      state: 'idle', mediaId: null, epoch: null, currentTime: null, durationSec: null,
      ageMs: idlePlayback.ageMs
    });
    c.close();
  }, { seed: 'lg-1' });
});

test('after confirmed Stop an idle reconnect stays empty and the same file can be cast again', async () => {
  await withService(async ({ svc, port, token }) => {
    const first = await authed(port, token, 'lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', currentTime: 10, state: 'playing'
    });
    await first.c.quiet('load');
    assert.equal(svc.play('lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/a.m3u8'
    }).loaded, false);
    svc.command('lg-1', 'stop');
    await first.c.next('stop');
    const cleared = new Promise((resolve) => svc.once('targets', resolve));
    first.c.send(proto.envelope('state', first.hello.sid, { state: 'idle', mediaId: null }));
    await cleared;
    first.c.close();

    const again = await authed(port, token, 'lg-1', null);
    assert.equal(await again.c.quiet('load'), true,
      'stopped controller intent caused the idle reconnect to reload old media');
    assert.deepEqual(svc.targets()[0].playback, {
      state: 'idle', mediaId: null, epoch: null, currentTime: null, durationSec: null,
      ageMs: svc.targets()[0].playback.ageMs
    }, 'the idle greeting revived facts from the stopped presentation');

    const recast = svc.play('lg-1', {
      mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/a.m3u8'
    });
    assert.equal(recast.loaded, true, 'the stale identity suppressed a genuine same-file recast');
    assert.equal((await again.c.next('load')).mediaId, 'm1');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('stop releases the lanserver media session', async () => {
  const cancelled = [];
  await withService(async ({ svc, port, token }) => {
    svc._lanForTest().cancelActive = () => cancelled.push(Date.now());
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 10, state: 'playing' });
    await c.quiet('load');
    svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8' });
    assert.equal(cancelled.length, 0, 'playing does not cancel anything');
    svc.command('lg-1', 'pause');
    assert.equal(cancelled.length, 0, 'nor does a pause: the film is still on screen');
    svc.command('lg-1', 'stop');
    assert.equal(cancelled.length, 1, 'stop releases the media session');
    c.close();
  }, { seed: 'lg-1' });
});


test('service forwards first control frame coalesced with HTTP upgrade', async () => {
  await withService(async ({ port, server }) => {
    let headBytes = 0;
    server.prependOnceListener('upgrade', (_, socket, head) => { headBytes = head.length; });
    const c = await client(port, proto.envelope('ping', 'early', { nonce: 'upgrade-head' }));
    try {
      await c.next('hello');
      const pong = await c.next('pong');
      assert.equal(pong.nonce, 'upgrade-head');
      assert.ok(headBytes > 0, 'the test must exercise HTTP upgrade head bytes');
    } finally { c.close(); }
  });
});

test('service Stop preserves a corrupt store when quarantine fails', (t) => {
  const dir = tmpdir(), file = path.join(dir, 'receivers.json');
  fs.writeFileSync(file, '{broken');
  t.mock.method(fs, 'renameSync', () => { throw new Error('cannot quarantine'); });
  const svc = createReceiverService({ storePath: file, beaconPort: 0 });
  try {
    svc.start(); svc.stop();
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(dir), ['receivers.json']);
  } finally { svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('retired LAN subscription cannot attach the restarted receiver service', () => {
  const { EventEmitter } = require('events');
  const callbacks = [], oldServer = new EventEmitter(), currentServer = new EventEmitter();
  const dir = tmpdir();
  const svc = createReceiverService({ storePath: path.join(dir, 'r.json'), beaconPort: 0,
    lan: { onServer: cb => { callbacks.push(cb); return () => {}; } } });
  try {
    svc.start(); svc.stop(); svc.start();
    callbacks[1](currentServer);
    assert.equal(currentServer.listenerCount('upgrade'), 1);
    callbacks[0](oldServer);
    assert.equal(oldServer.listenerCount('upgrade'), 0);
    assert.equal(currentServer.listenerCount('upgrade'), 1);
    svc.stop();
    callbacks[1](oldServer);
    assert.equal(oldServer.listenerCount('upgrade'), 0);
    assert.equal(currentServer.listenerCount('upgrade'), 0);
  } finally { svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated malformed timing reports cannot mutate current playback', async () => {
  await withService(async ({ svc, port, token, logs }) => {
    const { c, hello } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 20, state: 'playing' });
    try {
      c.send(proto.position(hello.sid, { mediaId: 'm1', currentTime: 20, durationSec: 100, paused: false }));
      c.send(proto.ping(hello.sid, { nonce: 'baseline' })); await c.next('pong');
      const before = svc.targets()[0].playback;
      c.send(proto.envelope('position', hello.sid, { mediaId: 'm1', currentTime: -20, durationSec: '100', paused: true }));
      c.send(proto.envelope('position', hello.sid, { mediaId: 'm1', currentTime: 50, paused: 'false' }));
      c.send(proto.ping(hello.sid, { nonce: 'after-invalid' }));
      assert.equal((await c.next('pong')).nonce, 'after-invalid');
      const after = svc.targets()[0].playback;
      assert.equal(after.currentTime, before.currentTime);
      assert.equal(after.durationSec, before.durationSec);
      assert.equal(after.paused, before.paused);
      assert.equal(after.mediaId, before.mediaId);
      assert.ok(logs.some(line => line.includes('invalid currentTime')));
      assert.ok(logs.some(line => line.includes('invalid paused')));
      c.send(proto.position(hello.sid, { mediaId: 'm1', currentTime: 21, durationSec: 100, paused: false }));
      c.send(proto.ping(hello.sid, { nonce: 'valid-again' })); await c.next('pong');
      assert.equal(svc.targets()[0].playback.currentTime, 21);
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('malformed reconnect greeting cannot replace authenticated playback', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 20, state: 'playing' });
    try {
      c.send(Object.assign(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }), { playing: { mediaId: 'wrong', currentTime: -50, state: 'playing' } }));
      c.send(proto.ping(hello.sid, { nonce: 'after-bad-hello' })); await c.next('pong');
      assert.equal(svc.targets()[0].playback.mediaId, 'm1');
      assert.equal(svc.targets()[0].playback.currentTime, 20);
      c.send(Object.assign(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }), { playing: { mediaId: 'm1', currentTime: 25, state: 'playing' } }));
      c.send(proto.ping(hello.sid, { nonce: 'after-good-hello' })); await c.next('pong');
      assert.equal(svc.targets()[0].playback.currentTime, 25);
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('partial position preserves omitted fields and records supplied epoch', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', { mediaId: 'm1', currentTime: 20, state: 'playing' });
    try {
      c.send(proto.position(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', currentTime: 20, durationSec: 100, paused: false }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-2', url: 'http://localhost/epoch-2' });
      await c.next('load');
      let report; svc.once('position', value => { report = value; });
      c.send(proto.envelope('position', hello.sid, { currentTime: 21, epoch: 'epoch-2' }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      const playback = svc.targets()[0].playback;
      assert.equal(playback.mediaId, 'm1'); assert.equal(playback.durationSec, null, 'old epoch duration cannot survive timeline replacement');
      assert.equal(playback.state, 'playing'); assert.equal(playback.currentTime, 21);
      assert.equal(report.epoch, 'epoch-2');
      svc.once('position', value => { report = value; });
      c.send(proto.envelope('position', hello.sid, { currentTime: 22 }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      assert.equal(report.epoch, 'epoch-2', 'partial clock update retains its known timeline');
      assert.equal(report.currentTime, 22);
      assert.equal(report.durationSec, undefined, 'omitted observations remain omitted');
      svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-3', url: 'http://localhost/epoch-3' });
      await c.next('load');
      c.send(proto.loaded(hello.sid, { mediaId: 'm1', epoch: 'epoch-3', durationSec: 50 }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      assert.equal(svc.targets()[0].playback.currentTime, null, 'loaded epoch cannot inherit previous local clock');
      assert.equal(svc.targets()[0].playback.durationSec, 50);
      c.send(proto.envelope('position', hello.sid, { mediaId: 'm1', epoch: 'epoch-3', currentTime: 4 }));
      c.send(proto.envelope('loaded', hello.sid, { mediaId: 'm1' }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      assert.equal(svc.targets()[0].playback.epoch, 'epoch-3', 'omitted loaded epoch preserves known timeline');
      assert.equal(svc.targets()[0].playback.currentTime, 4);
      assert.equal(svc.targets()[0].playback.durationSec, 50, 'omitted metadata preserves same-timeline duration');
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('retired media and epoch reports cannot clear or repopulate current playback', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1');
    try {
      svc.play('lg-1', { mediaId: 'B', epoch: 'epoch-2', url: 'http://localhost/B' }); await c.next('load');
      c.send(proto.loaded(hello.sid, { mediaId: 'B', epoch: 'epoch-2', durationSec: 100 }));
      c.send(proto.state(hello.sid, { mediaId: 'B', epoch: 'epoch-2', state: 'playing' }));
      c.send(proto.position(hello.sid, { mediaId: 'B', epoch: 'epoch-2', currentTime: 20, durationSec: 100 }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      c.send(proto.loaded(hello.sid, { mediaId: 'A', epoch: 'epoch-1', durationSec: 999 }));
      c.send(proto.position(hello.sid, { mediaId: 'A', currentTime: 999 }));
      c.send(proto.state(hello.sid, { mediaId: 'B', epoch: 'epoch-1', state: 'ended' }));
      c.send(proto.error(hello.sid, { mediaId: 'A', fatal: true }));
      c.send(proto.error(hello.sid, { mediaId: 'B', epoch: 'epoch-1', fatal: true }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      const playback = svc.targets()[0].playback;
      assert.equal(playback.mediaId, 'B'); assert.equal(playback.currentTime, 20);
      assert.equal(playback.durationSec, 100); assert.equal(playback.state, 'playing');
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('failed LOAD write reports failure and preserves intent for reconnect reconciliation', async () => {
  await withService(async ({ svc, port, token, server }) => {
    let transport; server.once('upgrade', (_, socket) => { transport = socket; });
    const { c } = await authed(port, token, 'lg-1');
    let again;
    try {
      transport.write = () => { throw new Error('controlled write failure'); };
      const result = svc.play('lg-1', { mediaId: 'B', url: 'http://localhost/B', startSec: 20, autoplay: false });
      assert.equal(result.ok, false); assert.equal(result.loaded, false);
      assert.match(result.why, /could not be sent/);
      again = await authed(port, token, 'lg-1');
      const load = await again.c.next('load');
      assert.equal(load.mediaId, 'B'); assert.equal(load.startSec, 20); assert.equal(load.autoplay, false);
    } finally { c.close(); if (again) again.c.close(); }
  }, { seed: 'lg-1' });
});


test('older greeting reconciles desired load without overwriting current presentation', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1');
    try {
      svc.play('lg-1', { mediaId: 'B', epoch: 'epoch-2', url: 'http://localhost/B' }); await c.next('load');
      c.send(proto.loaded(hello.sid, { mediaId: 'B', epoch: 'epoch-2', durationSec: 100 }));
      c.send(proto.state(hello.sid, { mediaId: 'B', epoch: 'epoch-2', state: 'playing' }));
      c.send(proto.position(hello.sid, { mediaId: 'B', epoch: 'epoch-2', currentTime: 20, durationSec: 100 }));
      c.send(proto.ping(hello.sid)); await c.next('pong');
      c.send(Object.assign(proto.helloFrom(hello.sid, { receiverId: 'lg-1' }), { playing: { mediaId: 'A', epoch: 'epoch-1', currentTime: 999, state: 'paused' } }));
      const load = await c.next('load'); assert.equal(load.mediaId, 'B');
      c.send(proto.ping(hello.sid)); await c.next('pong');
      const playback = svc.targets()[0].playback;
      assert.equal(playback.mediaId, 'B'); assert.equal(playback.currentTime, 20);
      assert.equal(playback.state, 'playing');
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('invalid controller timing sends no seek or load while explicit zero remains valid', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1');
    try {
      for (const value of [NaN, Infinity, -1, '20', undefined]) {
        assert.equal(svc.command('lg-1', 'seek', value).ok, false);
      }
      for (const value of [NaN, Infinity, -1, '20']) {
        assert.equal(svc.play('lg-1', { mediaId: 'A', url: 'http://localhost/A', startSec: value }).ok, false);
      }
      c.send(proto.ping(hello.sid)); await c.next('pong');
      assert.equal(c.msgs.some(message => message.type === 'seek' || message.type === 'load'), false);
      assert.equal(svc.command('lg-1', 'seek', 0).ok, true);
      assert.equal((await c.next('seek')).toSec, 0);
      assert.equal(svc.play('lg-1', { mediaId: 'A', url: 'http://localhost/A', startSec: 0 }).ok, true);
      assert.equal((await c.next('load')).startSec, 0);
    } finally { c.close(); }
  }, { seed: 'lg-1' });
});


test('reconnect LOAD preserves the latest controller pause/play and explicit seek', async () => {
  for (const autoplay of [true, false]) {
    await withService(async ({ svc, port, token }) => {
      const { c } = await authed(port, token, 'lg-1');
      let again;
      try {
        svc.play('lg-1', { mediaId: 'A', url: 'http://localhost/A', startSec: 50, autoplay }); await c.next('load');
        const command = autoplay ? 'pause' : 'play';
        assert.equal(svc.command('lg-1', command).ok, true); await c.next(command);
        assert.equal(svc.command('lg-1', 'seek', 7).ok, true); await c.next('seek');
        svc.dropControl('lg-1');
        again = await authed(port, token, 'lg-1');
        const load = await again.c.next('load');
        assert.equal(load.autoplay, !autoplay); assert.equal(load.startSec, 7);
      } finally { c.close(); if (again) again.c.close(); }
    }, { seed: 'lg-1' });
  }
});

test('receiver page restart resumes at confirmed position in the retained transport', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/a.m3u8', startSec: 39.5 });
    await c.next('load');
    c.send(proto.state(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', state: 'playing' }));
    const observed = new Promise(resolve => svc.once('position', resolve));
    c.send(proto.position(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', currentTime: 52.5, durationSec: 120, paused: false }));
    await observed;
    c.send(proto.position(hello.sid, { mediaId: 'm1', epoch: 'old-epoch', currentTime: 7, durationSec: 120, paused: false }));
    c.close();
    const again = await authed(port, token, 'lg-1', null);
    const load = await again.c.next('load');
    assert.equal(load.startSec, 52.5);
    assert.equal(load.epoch, 'epoch-1');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('receiver-observed pause survives a page restart without a controller pause command', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'm1', epoch: 'epoch-1', url: 'http://mac/a.m3u8', autoplay: true });
    await c.next('load');
    c.send(proto.state(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', state: 'paused' }));
    const observed = new Promise(resolve => svc.once('position', resolve));
    c.send(proto.position(hello.sid, { mediaId: 'm1', epoch: 'epoch-1', currentTime: 4.1, paused: true }));
    await observed;
    c.send(proto.state(hello.sid, { mediaId: 'm1', epoch: 'old-epoch', state: 'playing' }));
    c.close();
    const again = await authed(port, token, 'lg-1', null);
    const load = await again.c.next('load');
    assert.equal(load.autoplay, false);
    assert.equal(load.startSec, 4.1);
    again.c.close();
  }, { seed: 'lg-1' });
});

test('fresh cast and reconnect carry the same HLS start-position hint', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1');
    svc.play('lg-1', { mediaId: 'film', url: 'http://mac/hls/token/master.m3u8', startSec: 217, autoplay: false });
    const first = await c.next('load');
    assert.equal(new URL(first.url).searchParams.get('spritzStart'), '217');
    assert.equal(first.startSec, 217); assert.equal(first.autoplay, false);
    const gone = new Promise(resolve => svc.once('targets', resolve)); c.close(); await gone;
    const { c: next } = await authed(port, token, 'lg-1');
    const restored = await next.next('load');
    assert.equal(restored.url, first.url); assert.equal(restored.startSec, 217);
    assert.equal(restored.autoplay, false); next.close();
  }, { seed: 'lg-1' });
});

test('track selections use reported choices and reject stale media ownership', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1');
    svc.play('lg-1', { mediaId: 'film', epoch: 'one', url: 'http://mac/a.mp4' }); await c.next('load');
    c.send(proto.loaded(hello.sid, { mediaId: 'film', epoch: 'one' }));
    const updated = new Promise(resolve => {
      const listener = () => { if (svc.targets()[0].playback.tracks) { svc.off('targets', listener); resolve(); } };
      svc.on('targets', listener);
    });
    c.send(proto.envelope('tracks', hello.sid, { mediaId: 'film', epoch: 'one', tracks: { audio: [{ id: '0', title: 'English', lang: 'en', selected: true }], subtitles: [] } }));
    await updated;
    assert.equal(svc.command('lg-1', 'select-track', { mediaId: 'old', epoch: 'one', kind: 'audio', trackId: '0' }).ok, false);
    assert.equal(svc.command('lg-1', 'select-track', { mediaId: 'film', epoch: 'one', kind: 'audio', trackId: '99' }).ok, false);
    assert.equal(svc.command('lg-1', 'select-track', { mediaId: 'film', epoch: 'one', kind: 'audio', trackId: '0' }).ok, true);
    const selected = await c.next('select-track'); assert.equal(selected.trackId, '0'); assert.equal(selected.mediaId, 'film'); c.close();
  }, { seed: 'lg-1' });
});


test('source audio catalog survives native one-track report and TV requests reach source selector', async () => {
  const selections = [];
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    const catalog = [{ id: 'source-audio-0', title: 'English', lang: 'eng', selected: true }, { id: 'source-audio-1', title: 'French', lang: 'fra', selected: false }];
    svc.play('lg-1', { mediaId: 'film', url: 'http://mac/a.m3u8', audioCatalog: catalog });
    assert.deepEqual((await c.next('load')).audioCatalog, catalog);
    let changed = new Promise(resolve => svc.once('targets', resolve));
    c.send(proto.envelope('tracks', hello.sid, { mediaId: 'film', epoch: null, tracks: { audio: [{ id: '0', title: 'Native', lang: 'eng', selected: true }], subtitles: [] } })); await changed;
    changed = new Promise(resolve => svc.once('targets', resolve));
    c.send(proto.envelope('loaded', hello.sid, { mediaId: 'film', epoch: null, durationSec: 12 })); await changed;
    assert.deepEqual(svc.targets()[0].playback.tracks.audio, catalog);
    const selected = new Promise(resolve => { selections.resolve = resolve; });
    c.send(proto.envelope('select-track', hello.sid, { mediaId: 'film', epoch: null, kind: 'audio', trackId: 'source-audio-1' }));
    await selected;
    assert.equal(selections[0].id, 'lg-1'); assert.equal(selections[0].arg.trackId, 'source-audio-1');
    assert.equal(svc.command('lg-1', 'select-track', { mediaId: 'stale', kind: 'audio', trackId: 'source-audio-1' }).ok, false);
    c.close();
  }, { seed: 'lg-1', onSelectTrack: (id, arg) => { selections.push({ id, arg }); selections.resolve(); return { ok: true }; } });
});

test('receiver retains 36 subtitle variants and latest explicit Off through stale inventory and reconnect', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1');
    const subtitles = Array.from({ length: 36 }, (_, idx) => ({ id: 'source-subtitle-' + idx, name: 'Subtitle ' + idx, lang: 'eng', url: 'http://mac/sub/' + idx, prepare: true }));
    assert.equal(svc.play('lg-1', { mediaId: 'film', url: 'http://mac/a.m3u8', subtitles }).ok, true);
    assert.equal((await c.next('load')).subtitles.length, 36);
    let changed = new Promise(resolve => svc.once('targets', resolve));
    c.send(proto.loaded(hello.sid, { mediaId: 'film', epoch: null })); await changed;
    const inventory = selected => ({ audio: [], subtitles: subtitles.map(t => ({ id: t.id, title: t.name, lang: t.lang, selected: t.id === selected })) });
    async function report(selected) {
      const update = new Promise(resolve => svc.once('targets', resolve));
      c.send(proto.envelope('tracks', hello.sid, { mediaId: 'film', epoch: null, tracks: inventory(selected) })); await update;
    }
    await report('source-subtitle-2');
    assert.equal(svc.targets()[0].playback.tracks.subtitles.length, 36);
    assert.equal(svc.subtitleSelection('lg-1', 'film', null), 'source-subtitle-2');
    assert.equal(svc.command('lg-1', 'select-track', { mediaId: 'film', epoch: null, kind: 'subtitle', trackId: 'off' }).ok, true);
    await c.next('select-track');
    await report('source-subtitle-2'); // old inventory cannot undo explicit Off
    assert.equal(svc.subtitleSelection('lg-1', 'film', null), 'off');
    // A newer TV intent can replace pending Off before its acknowledgement.
    c.send(proto.envelope('select-track', hello.sid, { mediaId: 'film', epoch: null, kind: 'subtitle', trackId: 'source-subtitle-35' }));
    await c.next('select-track');
    assert.equal(svc.subtitleSelection('lg-1', 'film', null), 'source-subtitle-35');
    await report('source-subtitle-35');
    await report(null); // subsequently observed TV-local Off
    assert.equal(svc.subtitleSelection('lg-1', 'film', null), 'off');
    c.close(); await new Promise(resolve => setTimeout(resolve, 15));
    const again = await authed(port, token, 'lg-1', null);
    const restored = await again.c.next('load');
    assert.equal(restored.subtitles.length, 36); assert.equal(restored.subtitleTrackId, 'off');
    again.c.close();
  }, { seed: 'lg-1' });
});

test('receiver rejects over-limit subtitle plans without changing desired playback', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1');
    const subtitles = Array.from({ length: 129 }, (_, i) => ({ id: 'source-subtitle-' + i, url: 'http://mac/sub/' + i }));
    assert.equal(svc.play('lg-1', { mediaId: 'invalid', url: 'http://mac/video', subtitles }).ok, false);
    assert.equal(await c.quiet('load', 30), true); c.close();
  }, { seed: 'lg-1' });
});

test('an in-flight native seek cannot overwrite the confirmed restart position', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c, hello } = await authed(port, token, 'lg-1', null);
    let again;
    try {
      svc.play('lg-1', { mediaId: 'm1', url: 'http://mac/a.m3u8', startSec: 23.3 });
      await c.next('load');
      c.send(proto.state(hello.sid, { mediaId: 'm1', state: 'playing' }));
      let observed = new Promise(resolve => svc.once('position', resolve));
      c.send(proto.position(hello.sid, { mediaId: 'm1', currentTime: 23.3, paused: false }));
      await observed;
      observed = new Promise(resolve => svc.once('position', resolve));
      c.send(proto.envelope('position', hello.sid, { mediaId: 'm1', currentTime: 0, seeking: true, paused: false }));
      await observed;
      c.close();
      again = await authed(port, token, 'lg-1', null);
      const load = await again.c.next('load');
      assert.equal(load.startSec, 23.3);
    } finally { c.close(); if (again) again.c.close(); }
  }, { seed: 'lg-1' });
});

test('logical timeline survives service load and idle reconnect with native HLS hints', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', null);
    svc.play('lg-1', { mediaId: 'mapped', url: 'http://mac/hls/token/index.m3u8', startSec: 120, timelineOrigin: 98.098, sourceDuration: 3122, autoplay: false });
    const load = await c.next('load');
    assert.equal(load.startSec, 120);
    assert.equal(load.timelineOrigin, 98.098);
    assert.equal(load.sourceDuration, 3122);
    assert.ok(Math.abs(Number(new URL(load.url).searchParams.get('spritzStart')) - 21.902) < 0.001);
    c.close();
    const again = await authed(port, token, 'lg-1', null);
    const resumed = await again.c.next('load');
    assert.equal(resumed.timelineOrigin, load.timelineOrigin);
    assert.equal(resumed.startSec, 120);
    assert.equal(resumed.autoplay, false);
    again.c.close();
  }, { seed: 'lg-1' });
});

test('rollback reloads the old transport even before replacement loaded updates session identity', async () => {
  await withService(async ({ svc, port, token }) => {
    const { c } = await authed(port, token, 'lg-1', { mediaId: 'old', currentTime: 120, state: 'paused' });
    svc.play('lg-1', { mediaId: 'candidate', url: 'http://mac/candidate.m3u8', startSec: 120 });
    assert.equal((await c.next('load')).mediaId, 'candidate');
    const result = svc.play('lg-1', { mediaId: 'old', url: 'http://mac/old.m3u8', startSec: 120, autoplay: false, forceReload: true });
    assert.equal(result.loaded, true);
    const restored = await c.next('load');
    assert.equal(restored.mediaId, 'old'); assert.equal(restored.autoplay, false);
    c.close();
  }, { seed: 'lg-1' });
});
