'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The real castv2 Client talking to the real castv2 Server over TLS on loopback: every byte goes through
// the length-prefixed framing and protobufjs. This is what the Chromecast path depends on, with no TV
// needed (a physical LG on this network was timing out at the Cast handshake regardless of version, so
// hardware could not validate the protobufjs upgrade; this does).
let pem = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-cast-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  pem = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) { /* no openssl */ }

test('a Cast client and server exchange messages over TLS through protobufjs, including non-ASCII payloads',
  { skip: pem ? false : 'openssl not available', timeout: 20000 }, async () => {
    const { Client, Server } = require('castv2');
    await new Promise((r) => setTimeout(r, 300));           // castv2 loads its schema asynchronously
    const NS = 'urn:x-cast:com.google.cast.tp.heartbeat';
    const got = [];
    const server = new Server(pem);
    // castv2's Server has one server-level 'message' event carrying a client id, and replies via send(clientId, ...).
    server.on('message', (clientId, src, dst, ns, data) => {
      got.push({ src, dst, ns, data: String(data) });
      server.send(clientId, dst, src, ns, JSON.stringify({ type: 'PONG', echo: JSON.parse(String(data)).title }));
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.server.address().port;

    const client = new Client();
    const reply = new Promise((resolve, reject) => {
      client.on('error', reject);
      client.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        client.on('message', (src, dst, ns, data) => resolve({ src, dst, ns, data: String(data) }));
        client.send('sender-0', 'receiver-0', NS, JSON.stringify({ type: 'PING', title: 'Café — 日本語 🫧' }));
      });
    });
    const r = await Promise.race([reply, new Promise((_, rej) => setTimeout(() => rej(new Error('no reply over loopback Cast')), 8000))]);
    client.close(); server.close();

    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].ns, NS);
    assert.strictEqual(got[0].src, 'sender-0');
    assert.strictEqual(JSON.parse(got[0].data).title, 'Café — 日本語 🫧');
    assert.strictEqual(r.ns, NS);
    assert.deepStrictEqual(JSON.parse(r.data), { type: 'PONG', echo: 'Café — 日本語 🫧' });
  });
