'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const createHub = require('../src/main/receiver-hub');
const proto = require('../src/main/receiver-protocol');
function socket() {
  const s = new EventEmitter(); s.writableLength = 0; s.writes = []; s.remoteAddress = '127.0.0.1';
  s.setNoDelay = () => {}; s.write = (data) => { s.writes.push(data); return true; };
  s.destroy = () => { s.destroyed = true; }; s.end = s.destroy;
  return s;
}
const request = () => ({ url: '/receiver', headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
test('connection limit refuses a new upgrade without displacing an existing session', () => {
  const hub = createHub({ maxConnections: 1 }); const first = socket(), second = socket();
  try {
    const req = request(); req.url = hub.PATH;
    hub.handleUpgrade(req, first); assert.equal(hub.sessions().length, 1);
    hub.handleUpgrade(req, second); assert.equal(hub.sessions().length, 1);
    assert.match(String(second.writes[0]), /503/); assert.ok(second.destroyed); assert.ok(!first.destroyed);
  } finally { hub.teardown(); }
});
test('queued-write limit drops the slow session before adding another frame', () => {
  const hub = createHub({ maxQueuedBytes: 4096 }); const s = socket();
  try {
    const req = request(); req.url = hub.PATH; hub.handleUpgrade(req, s);
    const id = hub.sessions()[0], before = s.writes.length;
    let reason; hub.once('disconnected', (event) => { reason = event.why; });
    s.writableLength = 4096;
    assert.equal(hub.send(id, proto.envelope('error', id, { message: 'test' })), false);
    assert.equal(s.writes.length, before); assert.equal(reason, 'write queue limit');
    assert.ok(s.destroyed); assert.equal(hub.sessions().length, 0);
  } finally { hub.teardown(); }
});

test('pong replies obey the same queued-write bound', () => {
  const hub = createHub({ maxQueuedBytes: 4096 }); const s = socket();
  try {
    const req = request(); req.url = hub.PATH; hub.handleUpgrade(req, s);
    s.writableLength = 4096;
    s.emit('data', require('../src/main/ws-frame').encodePing('ping'));
    assert.ok(s.destroyed); assert.equal(hub.sessions().length, 0);
  } finally { hub.teardown(); }
});

test('oversized frame header retires the hub session and ignores later data', () => {
  const hub = createHub(); const s = socket();
  try {
    const req = request(); req.url = hub.PATH; hub.handleUpgrade(req, s);
    const ws = require('../src/main/ws-frame');
    const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(ws.MAX_FRAME_BYTES + 1, 6);
    let reason; hub.once('disconnected', (event) => { reason = event.why; });
    s.emit('data', header);
    assert.equal(reason, 'frame too large'); assert.equal(hub.sessions().length, 0); assert.ok(s.destroyed);
    const count = s.writes.length;
    s.emit('data', ws.encodePing('late'));
    assert.equal(s.writes.length, count);
  } finally { hub.teardown(); }
});

test('attach is idempotent and teardown releases only its own server listener', () => {
  const hub = createHub(), server = new EventEmitter();
  const other = () => {};
  server.on('upgrade', other);
  try {
    hub.attach(server); hub.attach(server);
    assert.equal(server.listenerCount('upgrade'), 2);
    server.emit('upgrade', request(), socket(), Buffer.alloc(0));
    assert.equal(hub.sessions().length, 1);
    hub.teardown();
    assert.deepEqual(server.listeners('upgrade'), [other]);
    hub.attach(server);
    assert.equal(server.listenerCount('upgrade'), 2);
  } finally { hub.teardown(); }
});

test('upgrade head bytes enter the same frame decoder as later socket data', () => {
  const hub = createHub(), s = socket();
  const ws = require('../src/main/ws-frame');
  try {
    const ping = ws.encodePing('early');
    hub.handleUpgrade(request(), s, ping.subarray(0, 3));
    const before = s.writes.length;
    s.emit('data', ping.subarray(3));
    assert.equal(s.writes.length, before + 1);
    assert.deepEqual(s.writes.at(-1), ws.encodePong('early'));
  } finally { hub.teardown(); }
});


test('successful authentication retires a pending pairing on that connection', () => {
  const R = require('../src/main/receiver-registry');
  const ws = require('../src/main/ws-frame');
  const registry = R.emptyRegistry();
  const initial = R.beginPairing(registry, { sessionId: 'seed', receiverId: 'tv' });
  const token = R.confirmPairing(registry, { code: initial.code }).token;
  const hub = createHub({ registry }), s = socket();
  try {
    hub.handleUpgrade(request(), s);
    const id = hub.sessions()[0];
    const hello = JSON.parse(ws.decode(s.writes[1]).frames[0].text);
    s.emit('data', ws.encodeText(proto.serialize(proto.envelope('pair.request', id, { receiverId: 'tv' }))));
    assert.equal(hub.pending().length, 1);
    const oldCode = registry.pending[id].code;
    s.emit('data', ws.encodeText(proto.serialize(proto.envelope('auth', id, { receiverId: 'tv', proof: R.proofFor(token, hello.nonce) }))));
    assert.equal(hub.isAuthenticated(id), true);
    assert.equal(hub.pending().length, 0);
    assert.equal(hub.confirmPairing(oldCode).ok, false);
    assert.equal(registry.receivers.tv.token, token);
  } finally { hub.teardown(); }
});


test('authenticated greeting cannot change the identity used for revocation', () => {
  const R = require('../src/main/receiver-registry'), ws = require('../src/main/ws-frame');
  const registry = R.emptyRegistry();
  const seed = R.beginPairing(registry, { sessionId: 'seed', receiverId: 'tv-1' });
  const token = R.confirmPairing(registry, { code: seed.code }).token;
  const hub = createHub({ registry }), s = socket();
  try {
    hub.handleUpgrade(request(), s);
    const id = hub.sessions()[0], hello = JSON.parse(ws.decode(s.writes[1]).frames[0].text);
    const send = message => s.emit('data', ws.encodeText(proto.serialize(message)));
    send(proto.helloFrom(id, { receiverId: 'tv-1' }));
    send(proto.auth(id, { receiverId: 'tv-1', proof: R.proofFor(token, hello.nonce) }));
    assert.equal(hub.isAuthenticated(id), true);
    send(proto.envelope('pair.request', id, { receiverId: 'tv-2' }));
    assert.equal(hub.isAuthenticated(id), true); assert.equal(hub.pending().length, 0);
    let greetings = 0, authenticated = 0; hub.on('hello', () => greetings++);
    hub.on('authenticated', () => authenticated++);
    send(proto.auth(id, { receiverId: 'tv-1', proof: R.proofFor(token, hello.nonce) }));
    assert.equal(authenticated, 0); assert.equal(greetings, 0);
    send(proto.helloFrom(id, { receiverId: 'tv-2' }));
    assert.equal(greetings, 0); assert.equal(hub.receiverFor(id).receiverId, 'tv-1');
    send(proto.helloFrom(id, {}));
    assert.equal(hub.receiverFor(id).receiverId, 'tv-1');
    hub.revoke('tv-1'); assert.equal(hub.isAuthenticated(id), false);
    send(proto.envelope('pair.request', id, { receiverId: 'tv-1' }));
    assert.equal(hub.pending().length, 1);
    assert.equal(hub.confirmPairing(registry.pending[id].code).ok, true);
    send(proto.auth(id, { receiverId: 'tv-2', proof: 'different-identity' }));
    assert.equal(hub.sessions().length, 0); assert.ok(s.destroyed);
  } finally { hub.teardown(); }
});
