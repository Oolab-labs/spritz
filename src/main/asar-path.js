'use strict';

// Native code (libmpv) reads the real filesystem, not Electron's patched fs, so a file that lives
// inside app.asar is invisible to it ("Not a directory"). Files libmpv must open are listed in
// build.asarUnpack and live under app.asar.unpacked; this maps a path built from __dirname there.
// A no-op in development, where nothing is in an archive.
function unpackedPath(p) {
  return String(p).replace(/([/\\])app\.asar(?=[/\\])/, '$1app.asar.unpacked');
}

module.exports = { unpackedPath };
