'use strict';

// The bytes of RFC 6455, and nothing else.
//
// Why hand-written rather than `ws`: that package is present in node_modules but only TRANSITIVELY,
// pulled in by webtorrent — it is not one of this project's four declared dependencies. Depending on
// a transitive package is the kind of thing that breaks silently on an unrelated upgrade, and adding
// a dependency for a spike is worse. The receiver protocol is small, text-only JSON, so the part of
// 6455 actually needed is small too.
//
// That is a real tradeoff: a hand-written frame codec is a classic source of subtle bugs — masking,
// fragmentation, the three length encodings. It is chosen because this shape (pure, no I/O) is
// exactly what this codebase tests hard, and every one of those cases is covered in ws-frame.test.js.
// If binary or fragmented frames are ever needed, swap in `ws` as a DECLARED dependency; receiver-hub
// is drawn so that costs one file.

const crypto = require('crypto');

// The magic string is from the RFC. It exists so a server cannot be tricked into completing a
// handshake by a client that merely echoes bytes back.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGE_FRAGMENTS = 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(String(clientKey || '') + GUID).digest('base64');
}

// Encode one frame from the SERVER. Server-to-client frames are never masked (RFC 6455 §5.1), which
// is the one asymmetry worth remembering when reading this next to decode().
function encode(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const n = body.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    // 64-bit length. Node cannot writeUInt64BE, and a payload over 2^53 is not reachable here
    // anyway, so the high word is written as zero rather than pretending to support it.
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(n, 6);
  }
  head[0] = 0x80 | (opcode & 0x0f);   // FIN set: this codec never fragments what it sends
  return Buffer.concat([head, body]);
}

const encodeText = (s) => encode(OP.TEXT, s);
const encodePong = (payload) => encode(OP.PONG, payload || Buffer.alloc(0));
const encodePing = (payload) => encode(OP.PING, payload || Buffer.alloc(0));

// Close carries a 2-byte big-endian status code before any reason text.
function encodeClose(code, reason) {
  const r = Buffer.from(String(reason || ''), 'utf8');
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(Number(code) || 1000, 0);
  r.copy(b, 2);
  return encode(OP.CLOSE, b);
}

// Decode as many whole frames as `buf` contains.
//
// Returns { frames, rest }. `rest` is the trailing bytes of an INCOMPLETE frame, which the caller
// must keep and prepend next time — TCP delivers a stream, not messages, and a frame arriving in two
// chunks is the normal case rather than an edge one.
//
// Fragmentation is handled by reassembly here rather than being pushed onto the caller: a text
// message split across CONT frames arrives as one `text` frame with the pieces joined. Anything the
// caller cannot act on (a binary frame, an unknown opcode) is returned with its opcode so the caller
// can decide, instead of being silently dropped.
function decode(buf, state) {
  const st = state || { frag: null, fragOp: 0 };
  let off = 0;
  const frames = [];
  const fatal = (why) => {
    st.frag = null; st.fragOp = 0; st.fragCount = 0;
    return { frames: [], rest: Buffer.alloc(0), state: st, fatal: why };
  };
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      // The high word must be zero for any payload this can address; a peer claiming more than 4 GB
      // in one frame is not something to try to serve.
      const hi = buf.readUInt32BE(p);
      len = buf.readUInt32BE(p + 4); p += 8;
      if (hi !== 0) return fatal('frame too large');
    }
    if (len > MAX_FRAME_BYTES) return fatal('frame too large');
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.slice(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;
    let body = buf.slice(p, p + len);
    if (mask) {
      // Copy before unmasking: slice() shares memory with the caller's buffer, and unmasking in
      // place would corrupt bytes the caller still holds.
      body = Buffer.from(body);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    }
    p += len;
    off = p;

    // Control frames (>= 0x8) are never fragmented and may arrive BETWEEN the fragments of a data
    // message, so they are passed straight through without touching reassembly state.
    if (opcode >= 0x8) {
      frames.push({ type: opcode === OP.CLOSE ? 'close' : opcode === OP.PING ? 'ping' : opcode === OP.PONG ? 'pong' : 'control', opcode, body });
      continue;
    }
    if (opcode === OP.CONT) {
      if (!st.frag) continue;               // a continuation with nothing to continue: ignore it
      if (st.frag.length + body.length > MAX_MESSAGE_BYTES) return fatal('message too large');
      st.fragCount = (st.fragCount || 1) + 1;
      if (st.fragCount > MAX_MESSAGE_FRAGMENTS) return fatal('too many fragments');
      st.frag = Buffer.concat([st.frag, body]);
    } else {
      st.frag = body; st.fragCount = 1;
      st.fragOp = opcode;
    }
    if (!fin) continue;
    const whole = st.frag;
    const wholeOp = st.fragOp;
    st.frag = null; st.fragOp = 0; st.fragCount = 0;
    if (wholeOp === OP.TEXT) frames.push({ type: 'text', opcode: OP.TEXT, text: whole.toString('utf8') });
    else frames.push({ type: 'binary', opcode: wholeOp, body: whole });
  }
  return { frames, rest: buf.slice(off), state: st };
}

module.exports = { MAX_FRAME_BYTES, MAX_MESSAGE_BYTES, MAX_MESSAGE_FRAGMENTS, OP, GUID, acceptKey, encode, encodeText, encodeClose, encodePing, encodePong, decode };
