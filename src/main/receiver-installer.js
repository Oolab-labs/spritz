'use strict';

// Where the Spritz Receiver installer (.ipk) lives, so the Mac app can show it to someone setting up
// a TV. Packaged: Contents/Resources/receiver (build.extraResources). Development: dist-receiver/,
// written by build/package-receiver.js. Null when there is none — callers must say so, not guess.
const nodeFs = require('fs');
const path = require('path');

const IPK = /^com\.spritz\.receiver_(\d+)\.(\d+)\.(\d+)_all\.ipk$/;

function newest(dir, fs) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const found = names.map((n) => ({ n, m: IPK.exec(n) })).filter((x) => x.m)
    .sort((a, b) => { for (let i = 1; i <= 3; i++) { const d = Number(b.m[i]) - Number(a.m[i]); if (d) return d; } return 0; });
  return found.length ? path.join(dir, found[0].n) : null;
}

function findInstaller({ resourcesPath, root, fs = nodeFs } = {}) {
  return (resourcesPath && newest(path.join(resourcesPath, 'receiver'), fs)) ||
         (root && newest(path.join(root, 'dist-receiver'), fs)) || null;
}

module.exports = { findInstaller };
