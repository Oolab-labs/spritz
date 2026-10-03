'use strict';

// The frame codec, exercised on the cases that actually break hand-written WebSocket code.
//
// These are not decorative. Every assertion here stands in for a bug that a codec of this shape
// classically ships with: forgetting that client frames are masked, reading the wrong length
// encoding at the 126/65536 boundaries, corrupting the caller's buffer by unmasking a slice in
// place, and losing a message that TCP split across two reads.

const { test } = require('node:test');
const assert = require('assert');
const ws = require('../src/main/ws-frame');

// The example from RFC 6455 §1.3, so this is checked against the spec rather than against itself.
test('acceptKey matches the RFC 6455 worked example', () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

// Build a CLIENT frame: masked, as the RFC requires of every client-to-server frame.
function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([0x01, 0x02, 0x03, 0x04]) } = {}) {
  const body = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(String(payload), 'utf8');
  const n = body.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = 0x80 | n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

test('decodes a masked client text frame', () => {
  const { frames, rest } = ws.decode(clientFrame(ws.OP.TEXT, 'hello'));
  assert.equal(rest.length, 0);
  assert.deepEqual(frames.map((f) => [f.type, f.text]), [['text', 'hello']]);
});

test('unmasking does not corrupt the caller buffer', () => {
  const buf = clientFrame(ws.OP.TEXT, 'hello');
  const before = Buffer.from(buf);
  ws.decode(buf);
  assert.deepEqual(buf, before, 'decode mutated the buffer it was given');
});

// The three length encodings, at their exact boundaries — 125/126 and 65535/65536 are where an
// off-by-one in the header length puts the payload offset in the wrong place.
for (const n of [0, 1, 125, 126, 127, 65535, 65536]) {
  test('round-trips a ' + n + '-byte payload', () => {
    const s = 'x'.repeat(n);
    const { frames, rest } = ws.decode(clientFrame(ws.OP.TEXT, s));
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].text.length, n);
    assert.equal(frames[0].text, s);
  });
}

test('a frame split across two reads is not lost', () => {
  const whole = clientFrame(ws.OP.TEXT, 'split me');
  for (let cut = 1; cut < whole.length; cut++) {
    const a = ws.decode(whole.slice(0, cut));
    assert.equal(a.frames.length, 0, 'a partial frame produced a message at cut ' + cut);
    const b = ws.decode(Buffer.concat([a.rest, whole.slice(cut)]), a.state);
    assert.equal(b.frames.length, 1, 'the message was lost at cut ' + cut);
    assert.equal(b.frames[0].text, 'split me');
  }
});

test('two frames in one read both arrive', () => {
  const buf = Buffer.concat([clientFrame(ws.OP.TEXT, 'one'), clientFrame(ws.OP.TEXT, 'two')]);
  const { frames } = ws.decode(buf);
  assert.deepEqual(frames.map((f) => f.text), ['one', 'two']);
});

test('a fragmented text message is reassembled', () => {
  const st = { frag: null, fragOp: 0 };
  const a = ws.decode(clientFrame(ws.OP.TEXT, 'frag', { fin: false }), st);
  assert.equal(a.frames.length, 0, 'a non-final fragment must not surface as a message');
  const b = ws.decode(clientFrame(ws.OP.CONT, 'mented'), a.state);
  assert.deepEqual(b.frames.map((f) => f.text), ['fragmented']);
});

// Control frames are legal BETWEEN the fragments of a data message, and dropping one there is how a
// connection silently dies: a ping goes unanswered and the peer times the socket out.
test('a ping between fragments is delivered without breaking reassembly', () => {
  const st = { frag: null, fragOp: 0 };
  const a = ws.decode(clientFrame(ws.OP.TEXT, 'be', { fin: false }), st);
  const b = ws.decode(clientFrame(ws.OP.PING, ''), a.state);
  assert.deepEqual(b.frames.map((f) => f.type), ['ping']);
  const c = ws.decode(clientFrame(ws.OP.CONT, 'fore'), b.state);
  assert.deepEqual(c.frames.map((f) => f.text), ['before']);
});

test('close carries its status code', () => {
  const body = Buffer.alloc(2); body.writeUInt16BE(1001, 0);
  const { frames } = ws.decode(clientFrame(ws.OP.CLOSE, body));
  assert.equal(frames[0].type, 'close');
  assert.equal(frames[0].body.readUInt16BE(0), 1001);
});

// Server-to-client frames must NOT be masked. A masked server frame is a protocol violation that
// browsers close the connection over, so this is checked on the wire bytes rather than by round-trip.
test('server frames are not masked', () => {
  const f = ws.encodeText('hi');
  assert.equal((f[1] & 0x80), 0, 'server frame set the mask bit');
  assert.equal(f.slice(2).toString('utf8'), 'hi');
});

test('encodeClose writes the code big-endian', () => {
  const f = ws.encodeClose(1002, 'nope');
  assert.equal(f.slice(2).readUInt16BE(0), 1002);
  assert.equal(f.slice(4).toString('utf8'), 'nope');
});

test('oversized announced frame is rejected before its body arrives', () => {
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
  header.writeUInt32BE(ws.MAX_FRAME_BYTES + 1, 6);
  const result = ws.decode(header);
  assert.equal(result.fatal, 'frame too large'); assert.equal(result.rest.length, 0);
});
test('fragment reassembly has a bounded aggregate and clears retained fragments on failure', () => {
  const state = { frag: null, fragOp: 0 };
  const first = ws.encode(ws.OP.TEXT, Buffer.alloc(ws.MAX_FRAME_BYTES)); first[0] &= 0x7f;
  ws.decode(first, state);
  const more = ws.encode(ws.OP.CONT, Buffer.alloc(ws.MAX_FRAME_BYTES)); more[0] &= 0x7f;
  for (let i = 0; i < 3; i++) assert.ok(!ws.decode(more, state).fatal);
  assert.equal(ws.decode(more, state).fatal, 'message too large');
  assert.equal(state.frag, null);
});

test('zero-length fragmentation cannot bypass the fragment-count bound', () => {
  const state = { frag: null, fragOp: 0 };
  const first = ws.encode(ws.OP.TEXT, ''); first[0] &= 0x7f;
  ws.decode(first, state);
  const more = ws.encode(ws.OP.CONT, ''); more[0] &= 0x7f;
  for (let i = 1; i < ws.MAX_MESSAGE_FRAGMENTS; i++) assert.ok(!ws.decode(more, state).fatal);
  assert.equal(ws.decode(more, state).fatal, 'too many fragments');
  assert.equal(state.frag, null);
});
