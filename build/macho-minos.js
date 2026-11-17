'use strict';

// Which macOS a Mach-O binary was built for, and whether the app promises less than that.
//
// Every binary carries the macOS version it was built for (LC_BUILD_VERSION `minos`, or the older
// LC_VERSION_MIN_MACOSX), and dyld refuses to load one built for a newer macOS than the one running. The
// Homebrew libraries the app bundles inherit the build Mac's version: measured on rc.17, 64 said 26.0 and
// libssl/libcrypto 27.0, while the app declared, and every release promised, macOS 11. Nothing failed: the
// only Mac it ever ran on was the one that built it.

const { execFileSync } = require('child_process');

// Apple renamed macOS 16 to 26, and toolchains still write 16.x into some binaries (the bundled ffmpeg says
// 16.0). Read 16–19 as the 26–29 they are, so "16.0" is never taken for older than "26.0".
const normalise = (v) => {
  const p = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  if (p[0] >= 16 && p[0] <= 19) p[0] += 10;
  return p;
};

function atLeast(a, b) {
  const x = normalise(a), y = normalise(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return true;
}

// The minimum macOS a Mach-O file declares, or null when it is not a Mach-O or declares none.
function minosOf(file) {
  let out = '';
  try { out = execFileSync('otool', ['-l', file], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; }
  const build = /cmd LC_BUILD_VERSION[\s\S]*?\n\s*minos ([\d.]+)/.exec(out);
  if (build) return build[1];
  const legacy = /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\n\s*version ([\d.]+)/.exec(out);
  return legacy ? legacy[1] : null;
}

// The entries ({ file, minos }) built for a newer macOS than `declared`.
const tooNew = (entries, declared) => entries.filter((e) => e.minos && !atLeast(declared, e.minos));

module.exports = { atLeast, minosOf, tooNew };
