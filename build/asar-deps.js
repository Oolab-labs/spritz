'use strict';

// Does the packaged app.asar contain every npm package its code needs?
//
// Every local build from 2026-10-09 shipped 5 of ~200 packages: node_modules was a symlink,
// electron-builder logged "cannot find path for dependency" and silently dropped WebTorrent's whole
// dependency tree. Torrents failed at runtime ("Cannot find package 'bittorrent-protocol'") while the
// package check passed, because nothing looked at the JS dependencies. This walks them inside the
// archive, the way Node resolves them at runtime.
//
// Reads the asar format directly (no dependency): UInt32 4, UInt32 headerPickleSize, UInt32, UInt32
// jsonLength, the JSON header, then file bodies at 8 + headerPickleSize + entry.offset. Entries marked
// `unpacked` live beside the archive in app.asar.unpacked.

const fs = require('fs');
const path = require('path');

function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const pickleSize = head.readUInt32LE(4), jsonLength = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    fs.readSync(fd, json, 0, jsonLength, 16);
    const header = JSON.parse(json.toString('utf8'));
    const base = 8 + pickleSize;
    const entry = (p) => {
      let node = header;
      for (const part of p.split('/')) { node = node && node.files && node.files[part]; if (!node) return null; }
      return node;
    };
    return {
      read(p) {
        const e = entry(p);
        if (!e || e.files || typeof e.size !== 'number') return null;
        if (e.unpacked) { try { return fs.readFileSync(path.join(file + '.unpacked', p), 'utf8'); } catch (err) { return null; } }
        const buf = Buffer.alloc(e.size);
        const rfd = fs.openSync(file, 'r');
        try { fs.readSync(rfd, buf, 0, e.size, base + Number(e.offset)); } finally { fs.closeSync(rfd); }
        return buf.toString('utf8');
      }
    };
  } finally { fs.closeSync(fd); }
}

// Node's lookup: <dir>/node_modules/<name>, then each parent package's node_modules, then the root.
function resolve(asar, fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = (dir ? dir + '/' : '') + 'node_modules/' + name;
    if (asar.read(candidate + '/package.json') !== null) return candidate;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i >= 0 ? dir.slice(0, i) : '';
  }
}

// [{ name, neededBy }] for every required dependency that cannot be resolved inside the archive.
function missingDependencies(asar) {
  const root = JSON.parse(asar.read('package.json') || '{}');
  const missing = [], seen = new Set();
  const queue = [{ dir: '', pkg: root, label: root.name || 'the app' }];
  while (queue.length) {
    const { dir, pkg, label } = queue.shift();
    const optional = pkg.optionalDependencies || {};
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (name in optional) continue;
      const at = resolve(asar, dir, name);
      if (!at) { if (!missing.some((m) => m.name === name)) missing.push({ name, neededBy: label }); continue; }
      if (seen.has(at)) continue;
      seen.add(at);
      let child = {};
      try { child = JSON.parse(asar.read(at + '/package.json')); } catch (e) {}
      queue.push({ dir: at, pkg: child, label: name });
    }
  }
  return missing;
}

module.exports = { readAsar, missingDependencies };
