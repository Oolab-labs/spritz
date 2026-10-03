# Third-Party Notices

Spritz is licensed under **GPL-3.0-or-later** (see [`LICENSE`](./LICENSE)). It incorporates, links against, or
bundles the third-party components listed below. Each is distributed under its own licence, which is compatible
with GPL-3.0-or-later.

**Where the licence texts are.** A built Spritz carries them inside the app, in
`Spritz.app/Contents/Resources/licenses/` (Help → *Show Licenses in Finder*): the GPL, this file, Electron's
licence, Chromium's third-party licences (`LICENSES.chromium.html`) and the licence of every bundled npm package
(`npm-licenses.txt`). In the source repository npm packages are not committed; their licence texts are in
`node_modules/<pkg>/` after `npm install`, and `node build/collect-licenses.js` assembles the same files.

This repository is **source-only**: the prebuilt binaries (the libmpv library, `ffmpeg` and `ffprobe` with their
`*.dylib` files, and the compiled `*.node` addons) are not committed. Some of those binaries are GPL-licensed, so
anyone who *distributes a built application* must also offer the **corresponding source**. See "GPL source
offer" at the end of this file.

The versions below are those in the **2.0.0-rc.14** build, read from the bundled binaries where they state a
version and otherwise from the Homebrew packages the libraries were copied from. When a library is updated the
notices must be updated with it: the package check (`build/verify-package.js`) refuses a build that bundles a
shared library this file does not name.

---

## 1. Native binaries and shared libraries (GPL — source offer required)

### Our own `ffmpeg` and `ffprobe` (FFmpeg 8.1.1)
- **Role:** transcoding and probing for casting. Built from the upstream FFmpeg 8.1.1 release with
  `--enable-gpl --enable-version3` and the libraries below; the exact `./configure` line is in the README
  (*The bundled ffmpeg is not Homebrew's*) and is printed by `ffmpeg -version`.
- **Effective licence:** **GPL-3.0-or-later.** FFmpeg's own code is LGPL-2.1+/GPL-2.0+; enabling the GPL
  encoders (x264, x265) makes the combined binaries GPL-3.0-or-later.
- **Copyright:** © 2000–2026 the FFmpeg developers. · https://ffmpeg.org/legal.html
- **Linked into the binaries** (from the table below): x264, x265, SVT-AV1, dav1d, libvpx, Opus, LAME, libass,
  FreeType, FriBidi, zimg, HarfBuzz and their dependencies.

### libmpv (mpv 0.41.0)
- **Role:** the playback engine (`native/mpv` links libmpv; the app bundles `libmpv.2.dylib` and its libraries).
- **Effective licence:** **GPL-2.0-or-later** in this configuration (it links `libass` and the GPL Rubber Band
  library); the mpv core is LGPL-2.1-or-later.
- **Copyright:** © mpv contributors. · https://github.com/mpv-player/mpv/blob/master/LICENSE.md
- libmpv also uses FFmpeg's libraries, which are the GPL-3.0-or-later build listed first in the table.

### Every shared library the app bundles
The app contains these as separate `.dylib` files (`Contents/Resources/bin/lib/` and
`Contents/Resources/app.asar.unpacked/native/mpv/build/Release/lib/`). LGPL libraries (LAME, FriBidi, GLib,
gettext's libintl, libplacebo, libbluray, libudfread, and the LGPL option of Graphite2 and uchardet) are shared
libraries that stay replaceable: anyone may substitute a modified build of them in the app bundle. Replacing a
file in a signed bundle invalidates the ad hoc signature, so re-sign afterwards with
`codesign --force --deep --sign - /Applications/Spritz.app`.

| Library | Version | Licence | Source |
|---|---|---|---|
| FFmpeg libraries (libavcodec, libavformat, libavfilter, libavutil, libavdevice, libswscale, libswresample) used by libmpv | 8.1.1 | GPL-3.0-or-later (GPL build) | https://ffmpeg.org · tag n8.1.1 |
| libmpv (mpv) | 0.41.0 | GPL-2.0-or-later AND LGPL-2.1-or-later | https://github.com/mpv-player/mpv · release 0.41.0 |
| x264 | r3222 (core 165) | GPL-2.0-or-later | https://code.videolan.org/videolan/x264 |
| x265 | 4.2 | GPL-2.0-or-later | https://bitbucket.org/multicoreware/x265_git |
| Rubber Band Library | 4.0.0 | GPL-2.0-or-later | https://breakfastquay.com/rubberband |
| dav1d | 1.5.3 | BSD-2-Clause | https://code.videolan.org/videolan/dav1d |
| SVT-AV1 | 4.1.0 | BSD-3-Clause (with the AOM patent licence) | https://gitlab.com/AOMediaCodec/SVT-AV1 |
| libvpx | 1.16.0 | BSD-3-Clause | https://chromium.googlesource.com/webm/libvpx |
| Opus | 1.6.1 | BSD-3-Clause | https://opus-codec.org |
| LAME (libmp3lame) | 3.100 | LGPL-2.0-or-later | https://lame.sourceforge.io |
| zimg | 3.0.6 | WTFPL | https://github.com/sekrit-twc/zimg |
| libvmaf | 3.1.0 | BSD-2-Clause-Patent | https://github.com/Netflix/vmaf |
| libass | 0.17.4 | ISC | https://github.com/libass/libass |
| FreeType | 2.14.3 | FreeType License (FTL) | https://freetype.org |
| FriBidi | 1.0.16 | LGPL-2.1-or-later (library); GPL-2.0-or-later for the tools | https://github.com/fribidi/fribidi |
| HarfBuzz | 14.3.0 | MIT | https://github.com/harfbuzz/harfbuzz |
| Graphite2 | 1.3.15 | MIT OR MPL-2.0 OR LGPL-2.1-or-later OR GPL-2.0-or-later (used under MIT) | https://github.com/silnrsi/graphite |
| Fontconfig | 2.18.3 | MIT and other permissive licences | https://www.freedesktop.org/wiki/Software/fontconfig/ |
| libunibreak | 7.0 | Zlib | https://github.com/adah1972/libunibreak |
| libplacebo | 7.360.1 | LGPL-2.1-or-later | https://code.videolan.org/videolan/libplacebo |
| shaderc | 2026.2 | Apache-2.0 | https://github.com/google/shaderc |
| Vulkan Loader (libvulkan) | 1.4.350.0 | Apache-2.0 | https://github.com/KhronosGroup/Vulkan-Loader |
| LuaJIT | 2.1 | MIT | https://luajit.org |
| MuJS | 1.3.9 | ISC | https://mujs.com |
| Little CMS (lcms2) | 2.19 | MIT | https://www.littlecms.com |
| uchardet | 0.0.8 | MPL-1.1 OR GPL-2.0-or-later OR LGPL-2.1-or-later (used under MPL-1.1) | https://www.freedesktop.org/wiki/Software/uchardet/ |
| libbluray | 1.4.1 | LGPL-2.1-or-later | https://www.videolan.org/developers/libbluray.html |
| libudfread | 1.2.0 | LGPL-2.1-or-later | https://code.videolan.org/videolan/libudfread |
| libsamplerate | 0.2.2 | BSD-2-Clause | https://github.com/libsndfile/libsamplerate |
| libarchive | 3.8.9 | BSD-2-Clause | https://www.libarchive.org |
| OpenSSL (libssl, libcrypto) | 3.6.2 | Apache-2.0 | https://www.openssl.org |
| GLib | 2.88.3 | LGPL-2.1-or-later | https://gitlab.gnome.org/GNOME/glib |
| gettext (libintl) | 1.0 | LGPL-2.1-or-later (the library; the gettext tools are GPL-3.0-or-later) | https://www.gnu.org/software/gettext/ |
| PCRE2 | 10.47 | BSD-3-Clause | https://github.com/PCRE2Project/pcre2 |
| libpng | 1.6.58 | libpng-2.0 | http://www.libpng.org/pub/png/libpng.html |
| libjpeg-turbo | 3.2.0 | IJG AND Zlib AND BSD-3-Clause | https://libjpeg-turbo.org |
| xz (liblzma) | 5.8.3 | 0BSD (the library) | https://tukaani.org/xz/ |
| LZ4 | 1.10.0 | BSD-2-Clause (the library) | https://github.com/lz4/lz4 |
| Zstandard | 1.5.7 | BSD-3-Clause (used under BSD) | https://facebook.github.io/zstd/ |
| libb2 (BLAKE2) | 0.98.1 | CC0-1.0 | https://github.com/BLAKE2/libb2 |

### `yt-dlp` 2026.08.19
- **Role:** resolves stream-site pages to media URLs. The unmodified standalone macOS release is bundled in
  `Contents/Resources/bin/`.
- **Licence:** The Unlicense (public domain dedication). · https://github.com/yt-dlp/yt-dlp
- The standalone build is a packaged Python application. It carries Python itself (PSF licence) and the
  libraries yt-dlp lists for that release; their licence texts are in yt-dlp's own release assets
  (https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19). Spritz does not modify it.

---

## 2. Application framework and runtime

| Component | Licence | Copyright | Source / licence text |
|---|---|---|---|
| **Electron** 42.9.0 | MIT | © Electron contributors; © 2014 GitHub Inc. | `Contents/Resources/licenses/ELECTRON-LICENSE` · https://github.com/electron/electron/blob/main/LICENSE |
| **Chromium** (inside Electron) | BSD-3-Clause and the licences of its dependencies | © The Chromium Authors | `Contents/Resources/licenses/LICENSES.chromium.html` |
| **Node.js** (inside Electron) | MIT (and bundled dependencies under their own licences) | © Node.js contributors | https://github.com/nodejs/node/blob/main/LICENSE |
| **V8** (inside Electron) | BSD-3-Clause | © the V8 project authors | within `LICENSES.chromium.html` |
| **node-addon-api** | MIT | © Node.js API collaborators | https://github.com/nodejs/node-addon-api |
| **node-gyp** (build time) | MIT | © node-gyp contributors | https://github.com/nodejs/node-gyp |

---

## 3. Bundled shader assets

### Anime4K (`vendor/shaders/anime4k/*.glsl`)
- **Source:** https://github.com/bloc97/Anime4K
- **Licences (mixed; both GPL-3.0-compatible; the in-file header of each `.glsl` is preserved):**
  - **MIT** — © 2019–2021 bloc97 — the CNN/Restore/Clamp shaders (for example `Anime4K_Upscale_CNN_x2_*`,
    `Anime4K_Restore_CNN_*`, `Anime4K_Clamp_Highlights.glsl`).
  - **The Unlicense** (public-domain dedication, https://unlicense.org) — `Anime4K_AutoDownscalePre_x2.glsl` and
    `Anime4K_AutoDownscalePre_x4.glsl`.

---

## 4. npm packages bundled in the app

198 packages (the production dependency tree of the 2.0.0-rc.14 build), all under permissive,
GPL-3.0-compatible licences. Their full texts are in `Contents/Resources/licenses/npm-licenses.txt`.

| Licence | Packages |
|---|---|
| MIT | 149 (webtorrent and most of its tree, `ws`, `xml2js`, `castv2`, `castv2-client`, `multicast-dns`, `dns-txt`, …) |
| Apache-2.0 | 18 (for example `b4a`, the `bare-*` family, `detect-libc`, `long`, `tunnel-agent`) |
| BSD-3-Clause | 11 (for example `protobufjs` and `@protobufjs/*`, `ieee754`) |
| ISC | 7 |
| BlueOak-1.0.0 | 3 (`isexe`, `sax`, `chownr`) |
| BSD-2-Clause | 1 (`default-gateway`); **BSD** 1 (`compact2string`) |
| MIT OR WTFPL | 1 (`expand-template`); BSD-2-Clause OR MIT OR Apache-2.0: 1 (`rc`) |
| **MPL-2.0** | 1 — **node-datachannel** (wraps libdatachannel; file-level copyleft, GPL-3.0-compatible; its `LICENSE` is in `npm-licenses.txt`) |

Seventeen of these packages declare their licence (MIT or BSD) in `package.json` but ship no licence file, so
`npm-licenses.txt` records the declared licence and says no text was supplied. No proprietary, non-commercial
or SSPL-licensed package is present in the dependency tree.

---

## 5. macOS system frameworks (linked by native addons, not redistributed)

`native/airplay` and `native/nowplaying` link only Apple system frameworks (AppKit, AVFoundation, AVKit,
CoreMedia, Foundation, MediaPlayer); `native/mpv` additionally links Cocoa, QuartzCore, OpenGL, CoreVideo and
IOSurface. These come with macOS under Apple's SDK licence and are not redistributed by Spritz.

---

## GPL source offer

Spritz combines and distributes GPL-licensed components: FFmpeg built with the GPL encoders x264 and x265,
libmpv linked with GPL libraries, and Rubber Band. The corresponding source of each, at the versions in the
table in Section 1, is the upstream release linked there (FFmpeg tag `n8.1.1`, mpv `0.41.0`, and so on). The
shared libraries were built by Homebrew from those upstream releases; the Homebrew formula for each, with any
patches it applies, is part of that source. The FFmpeg configure line is in the README.

If you received a built copy of Spritz and want the exact corresponding source for it, open an issue at
https://github.com/Oolab-labs/spritz/issues and it will be provided at no charge, for at least three years from
the release date. If you redistribute a built copy of Spritz you must pass on this same offer.
