'use strict';

// Which televisions Spritz trusts, and the pairing that establishes that trust.
//
// Deliberately SEPARATE from device-profile.js / device-memory.js. Those answer "what can this
// screen decode", which is evidence about media. This answers "may this socket drive playback at
// all", which is a trust decision. Merging them would mean a codec observation and a security
// credential shared a lifetime, a storage format and a revocation story, and they should not.
//
// Pure: no filesystem, no electron, no sockets. The caller owns persistence — the same division
// device-memory.js draws, and for the same reason: it makes every rule here testable without a disk.
//
// THREAT MODEL, stated so the code can be read against it. This protects a home LAN: another device
// or browser on the network must not be able to connect and drive the television, impersonate a
// paired one, replay an old pairing, or reuse an expired code. It does NOT protect against a
// compromised Mac (which holds the secrets by design), a compromised television, or someone
// standing in the room reading the code off the screen. Those are out of scope and pretending
// otherwise would be dishonest.

const crypto = require('crypto');

// Long enough that guessing is hopeless, short enough to store and compare cheaply. 256 bits from
// the CSPRNG; the pairing code contributes NO entropy to this and is not an input to it.
const TOKEN_BYTES = 32;

// Four digits, because a human reads it off a television across a room and types it on a laptop.
// Its only job is to bind "the connection asking to pair" to "the screen the human is looking at" —
// it is not a password and never authenticates a command. A longer code would buy nothing here: an
// attacker cannot submit codes (only the Mac's own UI can), so the code is not a guessing target;
// it is a confirmation channel that runs through the human's eyes.
const CODE_DIGITS = 4;

// Long enough to walk to the television, read the code, and walk back; short enough that a code
// left on screen after someone loses interest stops working. Five minutes. Anything under a minute
// fails the "walk to the other room" case, which is the normal case rather than the edge one.
const CODE_TTL_MS = 5 * 60 * 1000;

// Attempts against ONE pending pairing before it is burned. The realistic attacker here is a local
// process hammering the Mac's confirm path, not a human fat-fingering: five is generous for the
// human and useless for the machine, and a burned pairing simply means starting again on the TV.
const MAX_CODE_ATTEMPTS = 5;

const now = () => Date.now();

function emptyRegistry() {
  return { version: 1, receivers: {}, pending: {} };
}

// Identifiers appear in logs; secrets never do. One helper so the truncation is consistent and
// nobody invents their own.
const short = (id) => (id ? String(id).slice(0, 8) : 'none');

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// Uniform over the whole range. `randomInt` rather than Math.random or a modulo of random bytes:
// both of those skew, and a skewed pairing code is a small but free weakness.
function newCode() {
  const max = Math.pow(10, CODE_DIGITS);
  return String(crypto.randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

// A receiver proves possession of its token WITHOUT sending it: the Mac offers a per-connection
// nonce and the receiver returns HMAC(token, nonce).
//
// The alternative — sending the bearer token on every connection — is simpler, and was rejected
// because this socket is plain ws:// on a home network. A passive listener on the same Wi-Fi would
// capture the long-term credential once and hold it forever. With challenge-response the token
// never crosses the wire after pairing, so a capture yields one useless proof for one dead nonce.
//
// The cost is that the Mac must hold the token itself rather than a one-way hash of it, since HMAC
// needs the key. That is an accepted trade: a compromised Mac is explicitly out of scope, and the
// Mac is already the machine holding the media, the library and the network position that matter.
function proofFor(token, nonce) {
  return crypto.createHmac('sha256', String(token)).update(String(nonce)).digest('hex');
}

// Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch —
// which would turn a malformed proof into an exception instead of a clean rejection.
function proofMatches(expected, given) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(given || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- pairing ---------------------------------------------------------------------------------

// Begin pairing for one CONNECTION. Keyed by session, not by receiver: two televisions may be
// pairing at once, and a code must belong to the socket that asked for it. Binding the code to the
// session is what stops a second connection from redeeming a code it merely learned about.
function beginPairing(reg, { sessionId, receiverId, name, platform, at } = {}) {
  if (!sessionId) return { ok: false, why: 'no session' };
  if (!receiverId) return { ok: false, why: 'no receiver id' };
  const t = at || now();
  const used = new Set();
  for (const sid of Object.keys(reg.pending)) {
    if (reg.pending[sid].expiresAt <= t) delete reg.pending[sid];
    else used.add(reg.pending[sid].code);
  }
  // A displayed code must identify one live challenge, including across televisions.
  // Bound retries so an exhausted space or broken random source cannot hang control.
  let code;
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = newCode();
    if (!used.has(candidate)) { code = candidate; break; }
  }
  if (code === undefined) return { ok: false, why: 'pairing code unavailable' };
  reg.pending[sessionId] = {
    code, receiverId: String(receiverId), name: name || null, platform: platform || null,
    createdAt: t, expiresAt: t + CODE_TTL_MS, attempts: 0
  };
  return { ok: true, code, expiresAt: t + CODE_TTL_MS, ttlMs: CODE_TTL_MS };
}

function pendingList(reg, at) {
  const t = at || now();
  return Object.keys(reg.pending)
    .filter((s) => reg.pending[s].expiresAt > t)
    .map((s) => ({ sessionId: s, receiverId: reg.pending[s].receiverId, name: reg.pending[s].name,
      platform: reg.pending[s].platform, expiresAt: reg.pending[s].expiresAt }));
}

// The human has typed a code on the Mac. Find the pending pairing it belongs to and, if it matches,
// mint the receiver's long-term credential.
//
// Single-use: the pending entry is deleted whether the code was right, wrong-too-often, or expired.
// Leaving a used code alive is what makes a replay possible.
function confirmPairing(reg, { code, at } = {}) {
  const t = at || now();
  const typed = String(code == null ? '' : code).trim();

  // Expired entries are swept here rather than on a timer: this module is pure, and a caller should
  // not have to run a clock to keep it correct.
  for (const s of Object.keys(reg.pending)) {
    if (reg.pending[s].expiresAt <= t) delete reg.pending[s];
  }

  const sessionId = Object.keys(reg.pending).find((s) => {
    const p = reg.pending[s];
    // Constant-time compare, so the confirm path does not leak the code one digit at a time.
    return proofMatches(p.code, typed);
  });

  if (!sessionId) {
    // Count the miss against every live pairing, and burn any that has been guessed at too often.
    // Without this a local process could grind the whole code space against a pairing that stays
    // open for five minutes.
    for (const s of Object.keys(reg.pending)) {
      reg.pending[s].attempts += 1;
      if (reg.pending[s].attempts >= MAX_CODE_ATTEMPTS) delete reg.pending[s];
    }
    return { ok: false, why: 'no pending pairing matches that code' };
  }

  const p = reg.pending[sessionId];
  delete reg.pending[sessionId];

  const token = newToken();
  const existing = reg.receivers[p.receiverId] || {};
  reg.receivers[p.receiverId] = {
    receiverId: p.receiverId,
    displayName: p.name || existing.displayName || null,
    model: p.platform || existing.model || null,
    token,                       // see proofFor for why the secret is held rather than hashed
    pairedAt: t,
    lastSeen: t,
    revokedAt: null,
    protocolVersion: existing.protocolVersion || null,
    observed: existing.observed || null   // reserved; capability evidence is device-memory's job
  };
  return { ok: true, sessionId, receiverId: p.receiverId, token };
}

// Drop a pending pairing when its connection goes away, so a dead socket's code cannot be redeemed.
function cancelPairing(reg, sessionId) {
  if (reg.pending[sessionId]) { delete reg.pending[sessionId]; return true; }
  return false;
}

// ---- authentication --------------------------------------------------------------------------

function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Verify a receiver's proof against the nonce THIS connection was given.
//
// The revocation check comes before the cryptography deliberately: a revoked credential must fail
// even if it is otherwise perfectly valid, and ordering it first means no future edit can
// accidentally let a correct proof through for a forgotten television.
function authenticate(reg, { receiverId, nonce, proof, at } = {}) {
  const t = at || now();
  const r = reg.receivers[String(receiverId || '')];
  if (!r) return { ok: false, why: 'unknown receiver' };
  if (r.revokedAt) return { ok: false, why: 'revoked' };
  if (!nonce) return { ok: false, why: 'no nonce' };
  if (!proofMatches(proofFor(r.token, nonce), proof)) return { ok: false, why: 'bad proof' };
  r.lastSeen = t;
  return { ok: true, receiverId: r.receiverId, displayName: r.displayName };
}

// Forget a television. The caller is responsible for dropping any live session it holds — this
// module cannot reach a socket, and saying so here stops the next reader assuming it does.
function revoke(reg, receiverId, at) {
  const r = reg.receivers[String(receiverId || '')];
  if (!r) return { ok: false, why: 'unknown receiver' };
  r.revokedAt = at || now();
  r.token = null;              // the credential is gone, not merely flagged
  return { ok: true, receiverId: r.receiverId };
}

// Everything safe to show a human or write to a log. Note what is absent: the token.
function listReceivers(reg) {
  return Object.keys(reg.receivers).map((id) => {
    const r = reg.receivers[id];
    return { receiverId: r.receiverId, displayName: r.displayName, model: r.model,
      pairedAt: r.pairedAt, lastSeen: r.lastSeen, revokedAt: r.revokedAt,
      paired: !r.revokedAt && !!r.token };
  });
}

module.exports = {
  emptyRegistry, beginPairing, confirmPairing, cancelPairing, pendingList,
  authenticate, revoke, listReceivers,
  newToken, newCode, newNonce, proofFor, proofMatches, short,
  TOKEN_BYTES, CODE_DIGITS, CODE_TTL_MS, MAX_CODE_ATTEMPTS
};
