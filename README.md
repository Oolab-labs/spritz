# Spritz

**Spritz** is a modern, arm64-native macOS media player. It plays virtually any
file via [libmpv](https://github.com/mpv-player/mpv), streams torrents, and casts
to AirPlay, Chromecast/Google Cast, and DLNA devices on your local network. Spritz
is a personal, general-purpose media player — it ships **no** content, no catalog,
and no index of any kind.

> Status: `2.0.0-alpha` — macOS 11+ on Apple Silicon (arm64).

## Features

- **Plays anything** via libmpv (HEVC/AV1/VP9, HDR, multi-track audio & subtitles).
- **Torrent streaming** — open a magnet or `.torrent` and play while it downloads (webtorrent).
- **Casting** — AirPlay 2, Chromecast/Google Cast, and DLNA/UPnP renderers, with
  audio-track and subtitle selection, and native 4K/HDR passthrough over DLNA.
- **Subtitles** — embedded tracks, external files, OpenSubtitles lookup, and (optional) Whisper generation.
- **Continue Watching**, playlists/queues, keyboard shortcuts, playback speed, Anime4K upscaling.

## Compatibility

### Runs on
- **macOS 11 (Big Sur) or later**
- **Apple Silicon (arm64)** — M1 and newer

### Casts to
Any device on the **same local network** (your Mac and the receiver must share the Wi-Fi/LAN):

| Protocol | Devices | What Spritz sends |
|---|---|---|
| **AirPlay 2** | Apple TV, AirPlay-2 TVs & receivers | H.264 / SDR up to **1080p** (4K/HDR is transcoded down; AC3/E-AC3 surround passes through) |
| **Chromecast / Google Cast** | Chromecast dongles, Chromecast-built-in TVs (LG webOS, Android TV / Google TV, …) | Negotiated per device — modern 4K TVs get **native 4K HEVC + HDR10**; older 1080p dongles get H.264. Audio-only Cast devices are excluded |
| **DLNA / UPnP** | Many LG (webOS), Samsung, Sony, Vizio, TCL, Philips smart TVs & standalone DLNA renderers | The **original file, untouched** — best path for native **4K HEVC / HDR10 / HDR10+** with no Mac-side transcode |

### Notes
- For **4K HDR**, prefer the DLNA route (shown as *"native 4K/HDR (best)"* in the cast menu). AirPlay is limited to 1080p H.264/SDR.
- **Dolby Vision** is not passed through; **HDR10 / HDR10+** is. (DV titles play as their HDR10 base layer on TVs that support it.)
- Developed and tested primarily against an **LG NANO80T6A (webOS)**, which exposes Chromecast-built-in, AirPlay 2, and DLNA simultaneously.

## Status & known limitations

**Spritz is alpha — in active development.** It works day to day, but expect rough edges; the areas below are known and being improved.

**4K / HDR casting**
- **DLNA is the reliable 4K path** — the original file is streamed untouched and the TV decodes it natively (4K HEVC / HDR10 / HDR10+).
- **Chromecast** does native 4K HEVC + HDR10 on capable TVs.
- **AirPlay is 1080p H.264 / SDR only** — 4K/HDR is transcoded down and HDR looks washed out (the bundled ffmpeg has no HDR→SDR tone-mapping). Use DLNA for 4K HDR.
- **Dolby Vision is not passed through**, and some 4K DV files are still rejected by strict DLNA TVs ("file cannot be recognized") — being worked on.

**Audio-track switching** — reliable for local playback, but **not yet reliable while casting**: switching language/track mid-cast can fail or need a re-cast, and not every container switches cleanly.

**Subtitles** — embedded text subtitles and external SRT generally work, but **bitmap subtitles (PGS/VOBSUB) and styled ASS don't reliably render over casting** (the bundled ffmpeg has no libass), and the subtitle toggle can drop on some cast sessions. OpenSubtitles lookup is best-effort.

**Torrent streaming** — usually starts fine but can occasionally need a retry; 4K-over-torrent at marginal bandwidth will rebuffer.

Bug reports and PRs welcome.

## Requirements

- macOS 11+ on Apple Silicon (arm64)
- [Node.js](https://nodejs.org) 18+ and npm
- [Homebrew](https://brew.sh) — to provide `libmpv` and `ffmpeg`

## Build & run from source

This repository is **source-only**. The prebuilt GPL media binaries (the `libmpv`
dylib, `ffmpeg`/`ffprobe`) and the compiled native `*.node` addons are **not**
committed (see [License](#license) below); you provide/build them locally.

```sh
# 1. Media libraries (libmpv + ffmpeg) via Homebrew
brew install mpv ffmpeg

# 2. JS dependencies
npm install

# 3. Build the native addons (libmpv / AirPlay / Now Playing) against your toolchain
npm run rebuild

# 4. Run
npm start
```

To produce a distributable `.app`/`.dmg`: `npm run dist` (electron-builder). If you
redistribute a build that bundles the GPL `ffmpeg`/`libmpv` binaries, you must also
carry the corresponding-source offer described under [License](#license).

## License

Spritz is free software, licensed under the **GNU General Public License, version 3
or later (GPL-3.0-or-later)**. See [`LICENSE`](./LICENSE) for the full text and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the licenses of all bundled
and linked third-party components.

### GPL binaries and corresponding source

Spritz combines and (in packaged builds) distributes GPL-licensed media components —
**FFmpeg** built with the GPL encoders x264/x265, and **libmpv** linked against
`libass` and the GPL `librubberband`. In accordance with the GNU GPL, the complete
corresponding source for these components is available from the upstream projects:

- FFmpeg 8.1.1 — https://git.ffmpeg.org/ffmpeg.git (tag `n8.1.1`)
  - x264 — https://code.videolan.org/videolan/x264
  - x265 — https://bitbucket.org/multicoreware/x265_git
- mpv / libmpv 0.41.0 — https://github.com/mpv-player/mpv (Homebrew `mpv` formula)

This repository is source-only: those binaries and the compiled `*.node` addons are
not committed. Build them from the upstream sources above. If you redistribute a
compiled build of Spritz (e.g. a `.dmg`) that contains these binaries, you must
accompany it with the same offer of corresponding source.

## Disclaimer

Spritz is a **personal media player**. It does **not** host, provide, distribute,
recommend, index, or endorse any copyrighted content. Spritz does not include or
ship any media, torrents, magnet links, streams, or content catalogs.

Any media you open, stream, download, or cast with Spritz comes from sources **you
supply**. **You are solely responsible** for ensuring you have the right to access,
play, and distribute that content, and for complying with all applicable laws and
the terms of any service you use. The authors and contributors of Spritz accept no
responsibility or liability for how the software is used.

Spritz is provided "as is", without warranty of any kind, as set out in the GPL-3.0
license.

### DMCA / copyright contact

Spritz hosts no content, so there is nothing to take down from this software. If you
believe this **repository** itself contains material that infringes your copyright,
please open an issue and we will respond promptly.

## A note on Soda Player

Spritz is an independent project, written in the spirit of the classic **Soda
Player**. Spritz is **not affiliated with, endorsed by, sponsored by, or derived
from Soda Player or Rocketeer Studios Limited**, and contains **no Soda Player source
code or assets** — all Spritz code and artwork is original. Any similarity is limited
to commonly-understood protocols and techniques (e.g. mDNS/eureka Cast discovery,
DLNA/UPnP control), which are not protectable expression.

"Soda Player" and all other product names, logos, and brands referenced here are the
property of their respective owners and are used for identification purposes only.
Their use does not imply any affiliation with or endorsement by them.

## Acknowledgements

Built on the shoulders of [mpv](https://github.com/mpv-player/mpv),
[FFmpeg](https://ffmpeg.org), [WebTorrent](https://webtorrent.io),
[Electron](https://electronjs.org), and [Anime4K](https://github.com/bloc97/Anime4K).
See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the full list.
