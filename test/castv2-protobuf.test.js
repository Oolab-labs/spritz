'use strict';
const test = require('node:test');
const assert = require('node:assert');

// castv2 (the Chromecast channel library) encodes and decodes CastMessage with protobufjs and a schema it
// ships itself. protobufjs carries a critical advisory chain below 7.6.3 and castv2 pins ^6, so the
// version is overridden in package.json. These tests pin the behaviour the cast path depends on, so an
// override (or a later bump) that breaks the wire format fails here and not on someone's TV.
const proto = require('castv2/lib/proto');

// castv2 loads its schema asynchronously; wait for it rather than guessing.
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { proto.CastMessage.serialize({}); return; } catch (e) { if (!/not loaded yet/.test(e.message)) return; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('castv2 schema never loaded');
}

test('a CastMessage survives an encode/decode round trip', async () => {
  await ready();
  const msg = { protocolVersion: 0, sourceId: 'sender-0', destinationId: 'receiver-0',
    namespace: 'urn:x-cast:com.google.cast.tp.connection', payloadType: 0, payloadUtf8: '{"type":"CONNECT"}' };
  const wire = proto.CastMessage.serialize(msg);
  assert.ok(Buffer.isBuffer(wire) || wire instanceof Uint8Array);
  assert.ok(wire.length > 20);
  const back = proto.CastMessage.parse(wire);
  assert.strictEqual(back.sourceId, 'sender-0');
  assert.strictEqual(back.destinationId, 'receiver-0');
  assert.strictEqual(back.namespace, msg.namespace);
  assert.strictEqual(back.payloadUtf8, '{"type":"CONNECT"}');
});

test('non-ASCII payloads round-trip (titles with accents and emoji)', async () => {
  await ready();
  const text = JSON.stringify({ title: 'Café — 日本語 🫧' });
  const back = proto.CastMessage.parse(proto.CastMessage.serialize({ protocolVersion: 0, sourceId: 'a', destinationId: 'b', namespace: 'n', payloadType: 0, payloadUtf8: text }));
  assert.strictEqual(back.payloadUtf8, text);
});

// A device on the LAN sends us these bytes. Garbage must be an error the caller can catch, never a hang or a
// process crash. (A message whose trailing field is merely cut short is NOT asserted: protobufjs 6 accepts it
// and castv2's length-prefixed framing never delivers partial messages.)
test('garbage and empty input from a device throw a catchable error', async () => {
  await ready();
  assert.throws(() => proto.CastMessage.parse(Buffer.from(Array(11).fill(0xff))));
  assert.throws(() => proto.CastMessage.parse(Buffer.alloc(0)), /required/);
});

test('deeply nested garbage cannot stall the decoder (bounded time)', async () => {
  await ready();
  const evil = Buffer.alloc(200000, 0x0a); // tag 1, length-delimited, repeated
  const t0 = Date.now();
  try { proto.CastMessage.parse(evil); } catch (e) { /* an error is fine */ }
  assert.ok(Date.now() - t0 < 2000, 'decoding hostile input took ' + (Date.now() - t0) + ' ms');
});
