'use strict';

// Pure helpers for the licence files that ship inside the app. See test/licenses.test.js.

// libx264.165.dylib -> libx264. The trailing numbers are the ABI version and are not part of the name.
// Two families carry a dotted number in the name itself, so they are matched first.
const DOTTED_FAMILIES = ['libglib-2.0', 'libluajit-5.1'];
function libraryFamily(file) {
  const f = String(file);
  for (const d of DOTTED_FAMILIES) if (f.startsWith(d + '.') && f.endsWith('.dylib')) return d;
  const m = /^(lib.+?)(?:\.\d+)*\.dylib$/.exec(f);
  return m ? m[1] : null;
}

// Names the notices may use for a library. A family with no entry is looked for by its own name.
const ALIASES = {
  libavcodec: ['ffmpeg'], libavformat: ['ffmpeg'], libavfilter: ['ffmpeg'], libavutil: ['ffmpeg'],
  libavdevice: ['ffmpeg'], libswscale: ['ffmpeg'], libswresample: ['ffmpeg'],
  libssl: ['openssl'], libcrypto: ['openssl'],
  libintl: ['gettext', 'libintl'], 'libglib-2.0': ['glib'], 'libluajit-5.1': ['luajit'],
  libSvtAv1Enc: ['svt-av1', 'svtav1'], liblcms2: ['lcms2', 'lcms', 'little-cms', 'little cms'], libmp3lame: ['lame', 'mp3lame'],
  libpng16: ['libpng'], libjpeg: ['libjpeg', 'jpeg-turbo'], 'libpcre2-8': ['pcre2'], libshaderc_shared: ['shaderc'],
  libvulkan: ['vulkan'], libb2: ['libb2', 'blake2'], libmpv: ['mpv'], libzstd: ['zstd'], liblz4: ['lz4'], liblzma: ['xz', 'liblzma']
};

function namesFor(family) {
  return ALIASES[family] || [family, family.replace(/^lib/, '')];
}

function mentions(text, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9])' + esc + '($|[^A-Za-z0-9])', 'i').test(text);
}

// Families the notices never name.
function uncoveredLibraries(families, noticesText) {
  const text = String(noticesText || '');
  return families.filter((f) => !namesFor(f).some((n) => mentions(text, n)));
}

// One text file with every package, its licence, and the licence text it ships.
function renderNpmLicenses(packages) {
  const out = ['Licences of the npm packages bundled in Spritz', '=============================================', ''];
  for (const p of packages) {
    out.push('--------------------------------------------------------------------------------');
    out.push(p.name + '@' + p.version + '  (' + (p.license || 'licence not declared') + ')');
    out.push('--------------------------------------------------------------------------------');
    out.push(p.text ? String(p.text).trim() : '(no licence file in this package; it declares the licence above)');
    out.push('');
  }
  return out.join('\n');
}

module.exports = { libraryFamily, uncoveredLibraries, renderNpmLicenses, namesFor };
