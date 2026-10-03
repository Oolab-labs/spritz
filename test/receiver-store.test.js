'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/main/receiver-store');
const R = require('../src/main/receiver-registry');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-store-'));
function paired(id) {
  const reg = R.emptyRegistry();
  const b = R.beginPairing(reg, { sessionId: 's', receiverId: id, name: 'Living Room LG' });
  const c = R.confirmPairing(reg, { code: b.code });
  return { reg, token: c.token };
}

test('a missing store is a fresh first run, not an error', () => {
  const d = tmp();
  try {
    const r = store.load(path.join(d, 'nope.json'));
    assert.equal(r.fresh, true);
    assert.deepEqual(r.registry.receivers, {});
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a paired receiver survives save and load', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    const { reg, token } = paired('lg-1');
    store.save(f, reg);
    const back = store.load(f).registry;
    // The credential must survive, or every television has to be re-paired on each app start.
    const nonce = R.newNonce();
    assert.equal(R.authenticate(back, { receiverId: 'lg-1', nonce, proof: R.proofFor(token, nonce) }).ok, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('revocation survives a restart', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    const { reg, token } = paired('lg-1');
    R.revoke(reg, 'lg-1');
    store.save(f, reg);
    const back = store.load(f).registry;
    assert.ok(back.receivers['lg-1'], 'revoked receiver record must survive loading');
    const nonce = R.newNonce();
    assert.equal(R.authenticate(back, { receiverId: 'lg-1', nonce, proof: R.proofFor(token, nonce) }).ok, false,
      'a forgotten television came back trusted after a restart');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the store is written 0600', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    store.save(f, paired('lg-1').reg);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'receiver credentials were left readable');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// A pairing challenge belongs to a socket that did not survive the restart.
test('pending pairings are not restored', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    const reg = R.emptyRegistry();
    R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
    store.save(f, reg);
    assert.deepEqual(store.load(f).registry.pending, {});
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a corrupt store is quarantined rather than destroyed, and the app still starts', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    fs.writeFileSync(f, '{ this is not json');
    const r = store.load(f);
    assert.equal(r.fresh, true, 'a corrupt store must not stop Spritz starting');
    assert.ok(r.corrupt, 'the unreadable store should be kept for a human to look at');
    assert.ok(fs.existsSync(r.corrupt), 'the quarantined copy is missing');
    assert.equal(fs.readFileSync(r.corrupt, 'utf8'), '{ this is not json');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// An interrupted write must not be able to produce the corrupt file the previous test quarantines.
test('saving is atomic and leaves no temporary file behind', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    store.save(f, paired('lg-1').reg);
    store.save(f, paired('lg-2').reg);
    const stray = fs.readdirSync(d).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(stray, [], 'a temporary store file was left on disk');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the saved file never contains a pending code', () => {
  const d = tmp(); const f = path.join(d, 'r.json');
  try {
    const reg = R.emptyRegistry();
    const b = R.beginPairing(reg, { sessionId: 's1', receiverId: 'lg-1' });
    store.save(f, reg);
    assert.ok(!fs.readFileSync(f, 'utf8').includes(b.code), 'a pairing code was written to disk');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});


test('failed store publication preserves existing credentials and removes owned temporary data', (t) => {
  const d = tmp(), f = path.join(d, 'r.json');
  try {
    store.save(f, paired('lg-1').reg);
    const original = fs.readFileSync(f, 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw new Error('publication failed'); });
    assert.throws(() => store.save(f, paired('lg-2').reg), /publication failed/);
    assert.equal(fs.readFileSync(f, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(d), ['r.json']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('failed permission enforcement never publishes credentials', (t) => {
  const d = tmp(), f = path.join(d, 'r.json');
  try {
    t.mock.method(fs, 'fchmodSync', () => { throw new Error('permission failed'); });
    assert.throws(() => store.save(f, paired('lg-1').reg), /permission failed/);
    assert.equal(fs.existsSync(f), false);
    assert.deepEqual(fs.readdirSync(d), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});


test('structurally invalid JSON stores are preserved in quarantine', () => {
  const d = tmp(), f = path.join(d, 'r.json');
  try {
    for (const value of [{ receivers: [] }, { receivers: { tv: null } }, { version: 2, receivers: {} }, { receivers: { tv: { receiverId: 'other', token: 'secret' } } }]) {
      const raw = JSON.stringify(value); fs.writeFileSync(f, raw);
      const loaded = store.load(f);
      assert.equal(loaded.fresh, true); assert.ok(loaded.corrupt);
      assert.equal(fs.readFileSync(loaded.corrupt, 'utf8'), raw);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('failed quarantine protects the original store from publication', (t) => {
  const d = tmp(), f = path.join(d, 'r.json');
  try {
    fs.writeFileSync(f, '{broken');
    t.mock.method(fs, 'renameSync', () => { throw new Error('cannot quarantine'); });
    const loaded = store.load(f);
    assert.equal(loaded.writeBlocked, true); assert.equal(loaded.corrupt, undefined);
    assert.equal(fs.readFileSync(f, 'utf8'), '{broken');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
