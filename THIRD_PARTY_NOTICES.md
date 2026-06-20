# Third-Party Notices

Spritz is licensed under **GPL-3.0-or-later** (see [`LICENSE`](./LICENSE)). It
incorporates, links against, or bundles the third-party components listed below.
Each is distributed under its own license, which is compatible with
GPL-3.0-or-later. Full license texts live in each component's source/package
directory (for npm packages, in `node_modules/<pkg>/` after `npm install`; npm
packages are not committed to this repository).

This repository is **source-only**: prebuilt binaries (the libmpv dylib,
`ffmpeg`/`ffprobe` and their `*.dylib`, and the compiled `*.node` addons) are
intentionally **not** committed. Because some of those binaries are licensed under
the GPL, anyone who *distributes a built application* must also offer the
**corresponding source** of those GPL components. See "GPL Binary Source Offer" at
the end of this file, plus the build instructions in the README, for upstream
source links and versions.

---

## 1. Native / linked media libraries (GPL — source offer required when binaries are distributed)

### FFmpeg 8.1.1
- **Role:** transcoding/probing for casting (`ffmpeg`, `ffprobe`, and the linked `lib*.dylib`).
- **Effective license:** **GPL-3.0** (built with `--enable-gpl --enable-version3`, linking the GPL encoders x264/x265). FFmpeg's own code is LGPL-2.1+/GPL-2.0+; the GPL build makes the combined binaries GPLv3-effective.
- **Copyright:** Copyright © 2000–2026 the FFmpeg developers.
- **Source / license:** https://git.ffmpeg.org/ffmpeg.git (tag `n8.1.1`) · https://www.ffmpeg.org/legal.html
- **Linked sub-libraries:**
  - **x264** — GPL-2.0-or-later — © 2003–2025 x264 project — https://code.videolan.org/videolan/x264
  - **x265** — GPL-2.0-or-later — © 2013–2025 MulticoreWare, Inc. — https://bitbucket.org/multicoreware/x265_git
  - **dav1d** — BSD-2-Clause — © 2018–2025 VideoLAN and dav1d authors — https://code.videolan.org/videolan/dav1d
  - **libvpx** — BSD-3-Clause — © 2010 The WebM Project authors — https://chromium.googlesource.com/webm/libvpx
  - **libopus** — BSD-3-Clause — © Xiph.Org Foundation — https://opus-codec.org
  - **libmp3lame (LAME)** — LGPL-2.1-or-later — © the LAME project — https://lame.sourceforge.io
  - **SVT-AV1** — BSD-3-Clause-Clear — © Alliance for Open Media / Intel — https://gitlab.com/AOMediaCodec/SVT-AV1
  - **OpenSSL** — Apache-2.0 — © the OpenSSL Project Authors — https://www.openssl.org

### mpv / libmpv 0.41.0
- **Role:** core playback engine (`native/mpv` links libmpv; the packaged app vendors `libmpv.2.dylib`, not committed here).
- **Effective license:** **GPL** (this build links `libass` and the GPL `librubberband`; mpv core is LGPL-2.1+ but the linked configuration is GPL). GPL-3.0-compatible.
- **Copyright:** Copyright © mpv contributors.
- **Source / license:** https://github.com/mpv-player/mpv (release 0.41.0) · https://github.com/mpv-player/mpv/blob/master/LICENSE.md
- **Linked sub-libraries:**
  - **libass** — ISC — © 2006–2025 libass contributors — https://github.com/libass/libass
  - **Rubber Band Library** — GPL-2.0-or-later — © 2007–2025 Particular Programs Ltd — https://breakfastquay.com/rubberband
  - (also links the FFmpeg libraries above)

> Shipping the GPL `ffmpeg`/`libmpv` binaries obliges offering their corresponding
> source. Because this repository does not commit those binaries, the obligation is
> satisfied for the *source repo* by the upstream links above and the build
> instructions in the README. Any distributed *built app* (e.g. a `.dmg`) must
> carry the same source offer.

---

## 2. Application framework & runtime

| Component | License | Copyright | Source / License text |
|---|---|---|---|
| **Electron** (`^42`) | MIT | © Electron contributors; © 2014 GitHub Inc. | https://github.com/electron/electron/blob/main/LICENSE |
| **Node.js** (embedded in Electron) | MIT (+ bundled deps under their own licenses) | © Node.js contributors | https://github.com/nodejs/node/blob/main/LICENSE |
| **Chromium** (embedded in Electron) | BSD-3-Clause (+ others) | © The Chromium Authors | https://chromium.googlesource.com/chromium/src/+/main/LICENSE |
| **V8** (embedded in Electron) | BSD-3-Clause | © the V8 project authors | bundled with Electron |
| **node-addon-api** | MIT | © Node.js API collaborators | node_modules/node-addon-api/LICENSE.md |
| **node-gyp** | MIT | © node-gyp contributors | node_modules/node-gyp/LICENSE |

---

## 3. Bundled shader assets

### Anime4K (`vendor/shaders/anime4k/*.glsl`)
- **Source:** https://github.com/bloc97/Anime4K
- **Licenses (mixed — both GPL-3.0-compatible; the in-file header in each `.glsl` must be preserved):**
  - **MIT** — © 2019–2021 bloc97 — applies to the CNN/Restore/Clamp shaders (e.g. `Anime4K_Upscale_CNN_x2_*`, `Anime4K_Restore_CNN_*`, `Anime4K_Clamp_Highlights.glsl`).
  - **The Unlicense** (public-domain dedication, https://unlicense.org) — applies to `Anime4K_AutoDownscalePre_x2.glsl` and `Anime4K_AutoDownscalePre_x4.glsl`.

---

## 4. npm dependencies (bundled at runtime / build)

All runtime npm dependencies and their transitive packages are distributed under
permissive, GPL-3.0-compatible licenses. Full per-package license texts ship in
each `node_modules/<pkg>/` directory after `npm install`. Summary:

**Direct dependencies:** `castv2-client` (MIT), `dns-txt` (MIT), `multicast-dns` (MIT), `webtorrent` (MIT).

- **MIT** — webtorrent and essentially its entire tree (webtorrent, ws, xml2js, xmlbuilder, castv2, castv2-client, bittorrent-dht, bittorrent-tracker, bittorrent-protocol, bittorrent-lsd, bittorrent-peerid, parse-torrent, create-torrent, magnet-uri, torrent-discovery, k-bucket, k-rpc, simple-peer, simple-websocket, multicast-dns, dns-txt, dns-packet, buffer, readable-stream, streamx, bl, debug, ms, mime, node-fetch, randombytes, run-parallel, queue-microtask, pump, end-of-stream, cross-spawn, prebuild-install, node-abi, and more).
- **ISC** — abbrev, graceful-fs, inherits, ini, nopt, once, semver, signal-exit, which, wrappy.
- **BlueOak-1.0.0** — tar, minipass, chownr, yallist, isexe, sax.
- **BSD-3-Clause** — protobufjs and `@protobufjs/*`, ieee754.
- **BSD-2-Clause** — default-gateway, extract-zip.
- **Apache-2.0** — b4a, bare-* (bare-fs, bare-os, bare-path, bare-stream, …), detect-libc, long, tunnel-agent.
- **MPL-2.0** — **node-datachannel** (wraps libdatachannel; weak file-level copyleft, GPL-3.0-compatible; retain its bundled `LICENSE`).

> An exhaustive package-by-package listing can be regenerated from `package.json` /
> the lockfile (e.g. `npx license-checker --summary`). No proprietary, CC-NC, or
> SSPL-licensed package is present in the dependency tree.

---

## 5. macOS system frameworks (linked by native addons, not redistributed)

`native/airplay` and `native/nowplaying` link only Apple system frameworks
(AppKit, AVFoundation, AVKit, CoreMedia, Foundation, MediaPlayer); `native/mpv`
additionally links Cocoa, QuartzCore, OpenGL, CoreVideo, IOSurface. These are
provided by macOS under Apple's SDK license and are not redistributed by Spritz.

---

## GPL Binary Source Offer

Spritz combines and distributes GPL-licensed components (FFmpeg built with GPL
codecs, and libmpv linked with GPL libraries). In accordance with the GNU GPL, the
complete corresponding source for these components is available from the upstream
projects linked in Section 1. This source repository does not include the prebuilt
GPL binaries; see the README for the exact upstream versions and build/install
steps used to produce them. If you redistribute a compiled build of Spritz that
contains these binaries, you must accompany it with the same offer of corresponding
source.
