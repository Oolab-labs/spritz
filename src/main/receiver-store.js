'use strict';

// The receiver trust store, on disk.
//
// receiver-registry.js is pure and says so: "the caller owns persistence", the same division
// device-memory.js draws. This is that caller. It exists as its own module rather than as a few
// lines inside main.js because the file it writes holds receiver CREDENTIALS, and the rules about
// how it is written — permissions, atomicity, what happens when it is corrupt — deserve to be
// somewhere they can be read and tested rather than buried in application startup.
//
// Nothing here understands pairing. It moves a registry object between memory and a file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./receiver-registry');

// 0600. The file holds the shared secrets that authenticate televisions, in the clear, because
// challenge-response needs the key rather than a hash of it (see receiver-registry.proofFor). A
// world-readable file would hand every local account the ability to drive the user's TV.
const MODE = 0o600;

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Absent is the ordinary first run, not an error worth surfacing.
    return { registry: R.emptyRegistry(), fresh: true, writeBlocked: e.code !== 'ENOENT', error: e.code === 'ENOENT' ? undefined : e.message };
  }
  const quarantine = () => {
    const aside = file + '.corrupt-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    try { fs.renameSync(file, aside); }
    catch (e) { return { registry: R.emptyRegistry(), fresh: true, writeBlocked: true, error: e.message }; }
    return { registry: R.emptyRegistry(), fresh: true, corrupt: aside };
  };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return quarantine(); }
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(parsed) || (parsed.version != null && parsed.version !== 1) || !object(parsed.receivers)) return quarantine();
  for (const [id, receiver] of Object.entries(parsed.receivers)) {
    if (!object(receiver) || receiver.receiverId !== id) return quarantine();
    const credential = typeof receiver.token === 'string' && receiver.token.length > 0;
    const revoked = receiver.token === null && Number.isFinite(receiver.revokedAt) && receiver.revokedAt > 0;
    if (!credential && !revoked) return quarantine();
  }
  // `pending` is deliberately NOT restored. A pairing challenge belongs to a live socket that did
  // not survive the restart, and reviving one would leave a code redeemable for a connection that
  // no longer exists.
  return { registry: { version: parsed.version || 1, receivers: parsed.receivers, pending: {} }, fresh: false };
}

// Written via a temporary file and renamed, so an interrupted write cannot leave a half-JSON store —
// which `load` would then quarantine, costing the user every pairing they had.
//
// The temp file is created with the restrictive mode too: writing it 0644 and fixing it afterwards
// leaves a window in which the credentials are world-readable.
function save(file, registry) {
  const body = JSON.stringify({ version: registry.version || 1, receivers: registry.receivers || {} }, null, 2);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd, owned = false;
  try {
    fd = fs.openSync(tmp, 'wx', MODE);
    owned = true;
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, MODE);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
    if (owned) { try { fs.unlinkSync(tmp); } catch (e) {} }
  }
  return true;
}

module.exports = { load, save, MODE };
