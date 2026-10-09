'use strict';
const fs = require('fs'), path = require('path');
const RESERVE_BYTES = 1024 ** 3; // Leave a GiB for the player, packaging and other applications.
function ownerAlive(pid, signal = process.kill) {
  try { signal(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
// Only the new managed namespace participates. Legacy instance-* directories are never inferred dead.
function sweepOwned(parent, { alive = ownerAlive } = {}) {
  let entries;
  try { const stat = fs.lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) return; entries = fs.readdirSync(parent); } catch (e) { return; }
  for (const name of entries) {
    const m = /^([1-9]\d*)-[A-Za-z0-9]{6}$/.exec(name); if (!m) continue;
    const dir = path.join(parent, name), marker = path.join(dir, 'owner.json');
    try {
      const ds = fs.lstatSync(dir), ms = fs.lstatSync(marker);
      if (!ds.isDirectory() || ds.isSymbolicLink() || !ms.isFile() || ms.isSymbolicLink() || ms.size > 1024) continue;
      const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid !== Number(m[1]) || alive(owner.pid)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* uncertain ownership or failed cleanup: preserve it */ }
  }
}
function createInstance(root) {
  const parent = path.join(root, 'owned-v1'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink()) throw Error('Torrent cache directory must not be a symbolic link');
  sweepOwned(parent);
  const dir = fs.mkdtempSync(path.join(parent, process.pid + '-'));
  try { fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  return dir;
}
function diskFreeBytes(dir) {
  const stat = fs.statfsSync(dir, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}
module.exports = { RESERVE_BYTES, ownerAlive, sweepOwned, createInstance, diskFreeBytes };
