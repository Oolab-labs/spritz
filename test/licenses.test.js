'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../build/licenses');

// The app bundles ~47 shared-library families. THIRD_PARTY_NOTICES.md named about a dozen, and the shipped app
// carried no licence text at all (not even the GPL). These helpers keep the notices honest: every library the
// build bundles must be named in them, and the licence files must travel inside the app.

test('a dylib file name reduces to its library family', () => {
  assert.strictEqual(L.libraryFamily('libx264.165.dylib'), 'libx264');
  assert.strictEqual(L.libraryFamily('libglib-2.0.0.dylib'), 'libglib-2.0');
  assert.strictEqual(L.libraryFamily('libluajit-5.1.2.dylib'), 'libluajit-5.1');
  assert.strictEqual(L.libraryFamily('libmujs.dylib'), 'libmujs');
  assert.strictEqual(L.libraryFamily('libSvtAv1Enc.4.dylib'), 'libSvtAv1Enc');
  assert.strictEqual(L.libraryFamily('libpcre2-8.0.dylib'), 'libpcre2-8');
  assert.strictEqual(L.libraryFamily('libavcodec.62.dylib'), 'libavcodec');
  assert.strictEqual(L.libraryFamily('notadylib.txt'), null);
});

test('a library is covered when the notices name it by any of its known names', () => {
  const notices = 'FFmpeg 8.1.1, x264, GLib, LuaJIT, OpenSSL, gettext (libintl), SVT-AV1, little-cms (lcms2)';
  assert.deepStrictEqual(L.uncoveredLibraries(['libavcodec', 'libx264', 'libglib-2.0', 'libluajit-5.1', 'libssl', 'libcrypto', 'libintl', 'libSvtAv1Enc', 'liblcms2'], notices), []);
});

test('a library the notices never mention is reported', () => {
  const notices = 'FFmpeg and x264 only';
  const missing = L.uncoveredLibraries(['libavcodec', 'libx264', 'libharfbuzz', 'libfribidi'], notices);
  assert.deepStrictEqual(missing.sort(), ['libfribidi', 'libharfbuzz']);
});

test('matching ignores case and does not accept a substring of another word', () => {
  assert.deepStrictEqual(L.uncoveredLibraries(['libass'], 'The CLASSIC libraries'), ['libass'], 'ass inside classic is not libass');
  assert.deepStrictEqual(L.uncoveredLibraries(['libass'], 'libass (ISC)'), []);
  assert.deepStrictEqual(L.uncoveredLibraries(['libvpx'], 'LIBVPX'), []);
});

test('the npm licence file lists every package with its licence, and says when a package carries no text', () => {
  const text = L.renderNpmLicenses([
    { name: 'a', version: '1.0.0', license: 'MIT', text: 'MIT License\n\nCopyright (c) A' },
    { name: 'b', version: '2.0.0', license: 'ISC', text: null }
  ]);
  assert.ok(/a@1\.0\.0/.test(text) && /MIT License/.test(text));
  assert.ok(/b@2\.0\.0/.test(text) && /ISC/.test(text) && /no licence file/i.test(text));
  assert.ok(text.indexOf('a@1.0.0') < text.indexOf('b@2.0.0'), 'in order');
});

// The shared-library families the 2.0.0-rc.14 build bundles (Contents/Resources/bin/lib and the mpv addon's lib/).
// The package verifier checks the real bundle on every release build; this keeps the committed notices honest on
// every test run, so a notices edit that drops a library fails here rather than at packaging time.
const BUNDLED_FAMILIES = ["libSvtAv1Enc", "libarchive", "libass", "libavcodec", "libavdevice", "libavfilter", "libavformat", "libavutil", "libb2", "libbluray", "libcrypto", "libdav1d", "libfontconfig", "libfreetype", "libfribidi", "libglib-2.0", "libgraphite2", "libharfbuzz", "libintl", "libjpeg", "liblcms2", "libluajit-5.1", "liblz4", "liblzma", "libmp3lame", "libmpv", "libmujs", "libopus", "libpcre2-8", "libplacebo", "libpng16", "librubberband", "libsamplerate", "libshaderc_shared", "libssl", "libswresample", "libswscale", "libuchardet", "libudfread", "libunibreak", "libvmaf", "libvpx", "libvulkan", "libx264", "libx265", "libzimg", "libzstd"];
const fs = require('fs');
const path = require('path');
const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');

test('THIRD_PARTY_NOTICES.md names every library the build bundles', () => {
  assert.deepStrictEqual(L.uncoveredLibraries(BUNDLED_FAMILIES, notices), []);
});

test('the notices say where the licence texts are and how to get the GPL source', () => {
  assert.ok(/Contents\/Resources\/licenses/.test(notices), 'where the texts ship');
  assert.ok(/GPL source offer/i.test(notices), 'the offer');
  assert.ok(/issues/.test(notices) && /three years/.test(notices), 'how to ask, and for how long');
  assert.ok(/Unlicense/.test(notices) && /yt-dlp/.test(notices), 'yt-dlp');
});

test('the notices give a version and a licence for the components that carry a GPL obligation', () => {
  for (const name of ['FFmpeg 8.1.1', 'mpv 0.41.0', 'x264', 'x265', 'Rubber Band']) assert.ok(notices.includes(name), name);
  assert.ok(/GPL-3\.0-or-later/.test(notices));
});
