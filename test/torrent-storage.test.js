'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const root = process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..');
const storage = () => require(path.join(root, 'src/main/torrent-storage'));
test('owned-cache sweep preserves legacy, live owners, uncertain owners and symlinks', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-owned-test-')); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const make = (name, owner) => { const dir = path.join(parent, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'keep'), 'fixture'); if (owner) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner)); return dir; };
  const dead = make('123456-ABC123', { version: 1, pid: 123456 });
  const live = make('123457-ABC123', { version: 1, pid: 123457 });
  const legacy = make('instance-ABC123'); const invalid = make('123456-ABC124', { version: 1, pid: 123457 });
  const uncertain = make('123458-ABC123', { version: 1, pid: 123458 });
  fs.symlinkSync(live, path.join(parent, '123456-ABC125'));
  storage().sweepOwned(parent, { alive: pid => pid !== 123456 });
  assert.equal(fs.existsSync(dead), false); for (const dir of [live, legacy, invalid, uncertain]) assert.ok(fs.existsSync(path.join(dir, 'keep')));
  assert.ok(fs.lstatSync(path.join(parent, '123456-ABC125')).isSymbolicLink());
});
test('only ESRCH proves an owner dead; PID reuse and permission errors preserve data', () => {
  const { ownerAlive } = storage();
  assert.equal(ownerAlive(process.pid), true);
  for (const code of ['ESRCH', 'EPERM', 'UNKNOWN']) assert.equal(ownerAlive(123, () => { throw Object.assign(Error(code), { code }); }), code !== 'ESRCH');
});
