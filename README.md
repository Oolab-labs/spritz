# Spritz

**A private, native macOS media player that gets your media onto almost any screen,
at the best quality that screen can actually take.**

Give Spritz a video and pick a screen. It works out the difficult part — what the file
is, what your TV can decode, and the shortest route between the two — then plays it
locally via [libmpv](https://github.com/mpv-player/mpv) or casts it over AirPlay,
Chromecast/Google Cast, or DLNA.

```text
your video  →  Spritz reads the file  →  Spritz reads your TV  →  the best route it can use
                (codec, HDR, audio,        (what it decodes,        send as-is · convert only
                 subtitles)                 how big, what audio)     what has to change
```

Everything runs on your own machine and your own network. No account, nothing uploaded,
no telemetry. The only time Spritz contacts GitHub (api.github.com) is when you choose **Help → Check for Updates…**; nothing is checked or downloaded automatically. Spritz ships **no** content, catalog, or index of any kind — every file,
link and stream comes from you.

> Status: `2.0.0-rc.16` (release candidate) — macOS 11+ on Apple Silicon (arm64). Read [Status & known limitations](#status--known-limitations) before relying on it.

## What it does

- **Plays practically any file** via libmpv — HEVC, AV1, VP9, HDR, multi-track audio
  and subtitles, without hunting for codecs.
- **Sends it to your TV** over AirPlay 2, Chromecast/Google Cast or DLNA/UPnP, and
  negotiates per device: a capable TV gets the original 4K HEVC/HDR10 untouched; a
  1080p receiver gets a proper conversion instead of a failure.
- **Converts only what has to change.** If your TV can decode the video but not the
  audio, only the audio is converted — surround stays surround rather than being
  flattened to stereo.
- **Handles subtitles** — embedded, external files, styled ASS, burn-in for image-based
  subtitles that receivers can't render, OpenSubtitles lookup, optional Whisper
  generation.
- **Remembers where you were** — Continue Watching, playlists and queues, per-title
  audio/subtitle language preferences, keyboard shortcuts, Anime4K upscaling.

### Where your media can come from

Spritz never supplies media; it opens what you point it at.

- **Local files and folders** — drag in, or open with Spritz from Finder
- **Your own network shares and external drives**
- **Direct media URLs** you have the right to access
- **Stream-site pages** resolved via `yt-dlp`
- **Playlists** — `.m3u`, `.m3u8`, `.pls`, IPTV lists you subscribe to
- **Torrents and magnet links you supply** — for lawfully distributed material such as
  Linux and BSD images, Creative Commons and public-domain films, Internet Archive
  releases, game and software distributions, and independent work released this way

There is no search, no index, no directory and no built-in source of any of these.
See [Acceptable use](#acceptable-use).

## Compatibility

### Runs on
- **macOS 11 (Big Sur) or later**
- **Apple Silicon (arm64)** — M1 and newer
- **Intel Macs are not supported** — Spritz is a native arm64 build and won't run under Rosetta

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

## Install

> **Apple Silicon (M1 or newer) · macOS 11+.** Intel Macs are **not** supported — Spritz is a native arm64 app and won't run under Rosetta.

**Download:** each [release](https://github.com/Oolab-labs/spritz/releases) carries the **Mac app** (an Apple-Silicon `.dmg` and `.zip` — open the `.dmg` and drag **Spritz** to Applications) and the **Spritz Receiver** package for LG TVs (an `.ipk`; see [Spritz Receiver for LG webOS](#spritz-receiver-for-lg-webos)). Install the Mac app first: the TV is paired from it.

**Opening it the first time.** Builds are **ad hoc signed, not notarized** (there is no paid Apple Developer ID behind them), so macOS blocks the first launch of a downloaded copy. Pick whichever suits you:

- **Terminal, any macOS version.** Clear the quarantine flag, then open Spritz as usual:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Spritz.app
  ```

- **System Settings, macOS 15 (Sequoia) and later.** Try to open Spritz once and dismiss the warning. Then open **System Settings → Privacy & Security**, scroll to the Security section, click **Open Anyway** next to Spritz, and confirm with your password or Touch ID. (Right-clicking and choosing Open no longer works there.)
- **macOS 11 to 14.** Right-click Spritz → **Open** → **Open**.

These steps follow Apple's documented behaviour. They have not yet been tried on a Mac that has never run Spritz, so if yours differs, please open an issue.

**Build it yourself:** see [Build & run from source](#build--run-from-source) below.

## Using Spritz

### Play something locally

Drag a file onto the window, or right-click it in Finder → **Open With → Spritz**.
Spritz registers for common video extensions, so you can also make it the default
handler. Playback starts immediately; there is no library to import and nothing is
catalogued or uploaded.

Useful keys: `Space` play/pause · `←`/`→` seek · `↑`/`↓` volume · `F` fullscreen ·
`PgUp`/`PgDn` chapters · `,`/`.` frame step · `Ctrl+D` diagnostics overlay.

### Send it to a TV

1. Put your Mac and the TV on the **same network**. Spritz casts over your LAN — it
   never routes media through the internet.
2. Press the **cast button** and wait a moment for discovery.
3. Pick a device. Spritz decides the route itself and shows what it chose.

If nothing appears: macOS may not have granted Local Network access. Check **System
Settings → Privacy & Security → Local Network** and make sure Spritz is enabled — if
it already looks enabled, toggle it off and on. TVs that never advertise themselves can
be added by IP under **Settings → Manual TV addresses**.

Three routes, picked per device (plus a fourth for TVs running [Spritz Receiver](#spritz-receiver-for-lg-webos)):

- **DLNA** — the original file, untouched. Best for 4K HEVC/HDR10 on a TV that can
  decode it: nothing is re-encoded, so nothing is lost.
- **Chromecast / Google Cast** — negotiated per device. A capable TV gets native 4K
  HEVC + HDR10; a 1080p dongle gets a conversion.
- **AirPlay 2** — 1080p H.264/SDR. HDR sources are tone-mapped down.

### Open a URL, playlist, or torrent you have the rights to

**Open URL** accepts a direct media link, a stream-site page (resolved with `yt-dlp`),
a playlist file, or a magnet/`.torrent` you supply. Torrent playback streams while
downloading, prioritising the part you are watching.

The torrent HTTP server listens on loopback and serves only the selected file.
TVs fetch that file through the LAN server's token-scoped proxy; the torrent server
does not expose file listings or accept browser-origin requests.

Spritz provides no way to find any of these. It opens what you give it, which for
torrents means things distributed that way on purpose — Linux and BSD images, Internet
Archive material, Creative Commons and public-domain films, independent releases.

### Subtitles

Embedded and external subtitles are picked up automatically, including sidecar files
next to the video (`Movie.en.srt`, a `Subs/` folder). Image-based subtitles that a
receiver can't render are burned into the picture instead. OpenSubtitles lookup and
Whisper generation are available for files that have none.

## Spritz Receiver for LG webOS

Spritz Receiver is a small web app that runs on an LG webOS TV and plays what your Mac sends it. It is separate from the Mac app and is **optional**: DLNA, Chromecast and AirPlay need nothing installed on the TV. It exists for what those routes can't do well, such as switching audio language and picking subtitles from the TV remote.

**Before you start, know what installing it involves.** The receiver is not in the LG Content Store. It is installed as a developer app:

1. Turn on **Developer Mode** on the TV (install LG's *Developer Mode* app from the store and sign in with a free LG developer account).
2. Install the `.ipk` from a release with LG's webOS CLI (`ares-install`) or a tool such as [dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop).
3. **Developer Mode sessions expire.** Sessions were originally 50 hours; LG now documents a 1000-hour maximum ([LG docs](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)). When a session lapses the TV removes developer apps, and you must extend the session in the Developer Mode app (or reinstall). Plan for this.

**Pairing** ties one TV to your Mac. Open Spritz Receiver on the TV; it looks for Spritz on your network and shows a **4-digit code**. Enter that code in Spritz on your Mac (**Devices**, on the home screen or in the cast menu). You type on the Mac, never on the TV. The code counts down and refreshes itself every five minutes; five wrong tries cancel a pairing. From the TV's idle screen, **Pair again** gets a fresh credential and **Change Mac** points the TV at a different Mac. Revoking a TV is done from the Mac (**Forget**).

**Reinstalling or updating the receiver can change the TV's identity**, so you may have to pair again, and the Mac then lists the old entry as an offline duplicate (it shows when it was last seen). **Forget** the stale one. Developer Mode apps are removed when a session lapses, so expect this.

**If the TV can't find your Mac:** it searches its own network first, then a short list of common home ranges (`192.168.1.x`, `192.168.0.x`, `10.0.0.x`, `10.0.1.x`). A TV on a guest network, a separate VLAN, or an unusual range won't find the Mac. Put both on the same network. If the search finds nothing (it can take about a minute), the TV shows **Can't find Spritz** with a box for the Mac's address, which Spritz shows under **Devices**.

**Where it has been tested:** one TV (LG 55NANO80T6A, webOS firmware 33.31.61). Receiver 0.3.2 was exercised on it for the search, typed-address, pairing, code-refresh and pair-again flows, and for playing a local file and a streaming torrent with audio and subtitles switched from both the Mac and the TV's own menu. This was driven over the TV's web inspector with simulated clicks, not by a person holding the remote. Other models and webOS versions are untested. Receiver and Mac app versions are meant to be used together: **Devices** shows the receiver's version and flags a TV running an older one, but the Mac app does not update it for you.

## Acceptable use

Spritz is a player and a compatibility layer. It has no catalog, no index, no search,
no recommendations and no built-in sources, and it will not acquire that. Everything it
opens is something you pointed it at.

**Spritz is for** your own files and recordings, media you have bought or licensed,
material that is public domain or Creative Commons, content distributed freely by its
rights holder, and anything else you have the right to play — on whichever screen in
your home you prefer.

**Spritz is not for** obtaining or distributing copyrighted material you have no right
to, and it includes nothing to help you do that. It also does not circumvent DRM or
copy protection, and no such capability will be added.

You are responsible for what you open with it and for complying with the law where you
live. That responsibility is not transferred by this notice — see
[Disclaimer](#disclaimer).

## Status & known limitations

**Spritz is a release candidate, built and tested by one person on one Mac and one TV.** It works day to day, but expect rough edges. These are the known problems, stated plainly:

**Mac app**
- **Audio-device crash (worked around since rc.4).** libmpv 0.41.0's CoreAudio output has a bug: when it fails to start (it does on some outputs, e.g. Bluetooth headphones such as the Sony WH-1000XM5, where it logs `unable to set the input channel layout… -50`; standalone mpv fails the same way there), it leaves a device-change listener pointing at freed memory, and the next time macOS adds or removes an audio device (headphones connecting, a display's audio coming or going) the app crashes. Earlier builds, including the original alpha, have this. rc.4 and later start mpv's **AVFoundation** output first and keeps CoreAudio only as a fallback, which avoids the broken start-up. It was verified by creating and removing a CoreAudio device while the app played (the old build crashed every time; rc.4 survived repeated device changes), not just by reading code. The libmpv build itself is still 0.41.0, so if AVFoundation could not start and CoreAudio had to be used, the old exposure would return. mpv's error lines are kept in `~/Library/Application Support/Spritz/mpv.log`; attach it to any crash report.
- **Not notarized.** See [Install](#install) for opening it past Gatekeeper. Don't redistribute builds as if they were Apple-verified.
- **YouTube and other `yt-dlp` sites:** the bundled `yt-dlp` has no JavaScript runtime, so some YouTube formats may be missing.
- **Google Cast to the LG NANO80T6A works as of rc.11** (it did not connect before: a crash on films with subtitles, plus the TV stalling on the live stream). Spritz converts the film on the fly, so seeking and switching audio or subtitles re-casts from the nearest keyframe, which can rewind a few seconds. Other Chromecasts were not tested.
- **Bundled `ffmpeg` is a GPL build** (see [License](#license)).

**Not yet verified** (these have not passed a hardware test, so treat them as unproven):
- Playback from a **cold, very large remux** (a long delay before the first frame is expected).
- **A video freeze that needed a TV reboot** (HDMI) was seen once during development and is not understood.
- That picture, sound and subtitles stay **aligned by eye** over a full film. Automated checks read the TV's own player state; they cannot see or hear.
- The Mac's **resume position after you stop casting** and return to local playback.
- The **first-launch steps** above, on a Mac that has never run Spritz.
- **AirPlay** reported "Cannot Decode" once, the first time it was started partway through a film; starting it again worked. Not understood.

**4K / HDR casting**
- **DLNA is the reliable 4K path** — the original file is streamed untouched and the TV decodes it natively (4K HEVC / HDR10 / HDR10+).
- **Chromecast** does native 4K HEVC + HDR10 on capable TVs.
- **AirPlay is 1080p H.264 / SDR only** — 4K/HDR is converted down. HDR is now properly tone-mapped rather than simply flattened (the bundled ffmpeg is built with `zscale`/`tonemap`), but DLNA remains the better route for 4K HDR because it re-encodes nothing at all.
- **Dolby Vision is not passed through**, and some 4K DV files are still rejected by strict DLNA TVs ("file cannot be recognized") — being worked on.

**Audio and subtitle switching** — tested on an LG NANO80T6A with local 1080p and 4K files and a streaming torrent, from the Mac and, where the route allows it, from the TV:

| Route | From the Mac | From the TV remote |
|---|---|---|
| Spritz Receiver | yes | yes |
| AirPlay 2 | yes | not applicable |
| Google Cast | yes (re-casts) | not applicable |
| DLNA | no: the TV plays the original file, so use its remote | yes (the TV's own menus) |

On a torrent that is still downloading, subtitles, seeks and track changes only reach what has downloaded so far, and AirPlay takes about 40 seconds to become ready on a slow torrent.

**Subtitles** — embedded text subtitles and external SRT work well. Image-based subtitles (PGS/VOBSUB) and styled ASS can now be burned into the picture when a receiver can't render them (the bundled ffmpeg is built with `libass`), though this path is newer and less exercised than the rest. The subtitle toggle can still drop on some cast sessions, and OpenSubtitles lookup is best-effort.

**Torrent streaming** — usually starts fine but can occasionally need a retry; 4K-over-torrent at marginal bandwidth will rebuffer.

Bug reports and PRs welcome.

## Requirements

- macOS 11+ on Apple Silicon (arm64)
- [Node.js](https://nodejs.org) 18+ and npm
- [Homebrew](https://brew.sh) — to provide `libmpv` and `ffmpeg`

## Build & run from source

This repository is **source-only**. The GPL media binaries (`libmpv`, `ffmpeg`,
`ffprobe`) and the compiled native `*.node` addons are **not** committed (see
[License](#license)); you build or install them locally.

Prerequisites: macOS 11+ on Apple Silicon, [Homebrew](https://brew.sh),
[Node.js](https://nodejs.org) 18+, and the Xcode command-line tools
(`xcode-select --install`) for the Objective-C++ addons.

```sh
# 1. Get the source
git clone https://github.com/Oolab-labs/spritz.git
cd spritz

# 2. Media libraries and build tools
brew install mpv ffmpeg nasm pkg-config

# 3. JS dependencies
npm install

# 4. Build the three native addons (libmpv render, AirPlay, Now Playing).
#    Compiles against the Electron version in package.json — not your system Node —
#    because the addons load inside Electron and the ABIs differ.
npm run rebuild

# 5. Run it
npm start
```

Check your work with `npm test` (unit tests, no TV or media files required) and
`npx eslint .`.

### The bundled ffmpeg is not Homebrew's

Two features depend on filters the Homebrew `ffmpeg` formula does not ship:

| Feature | Needs | In Homebrew's build? |
|---|---|---|
| HDR→SDR tone mapping | `zscale` (libzimg) + `tonemap` | No |
| Subtitle burn-in | `subtitles` (libass) | No |

Spritz probes `ffmpeg -filters` at startup and switches these on only if present, so a
Homebrew ffmpeg gives you a **working player with those two features silently absent** —
HDR casts look flat, and image-based subtitles are skipped rather than burned in. That
is a degraded build, not a broken one, and it is easy to mistake for a bug.

To get them, build ffmpeg with both libraries and make it self-contained:

```sh
brew install libass zimg x264 x265 dav1d libvpx opus lame svt-av1

curl -LO https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz && tar xf ffmpeg-8.1.1.tar.xz
cd ffmpeg-8.1.1
./configure --extra-cflags="-I/opt/homebrew/include" --extra-ldflags="-L/opt/homebrew/lib" \
  --enable-gpl --enable-version3 --enable-pthreads \
  --enable-libass --enable-libzimg --enable-libfreetype --enable-libfribidi \
  --enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libdav1d --enable-libvpx \
  --enable-libopus --enable-libmp3lame \
  --enable-videotoolbox --enable-audiotoolbox --enable-neon \
  --enable-openssl --disable-ffplay --disable-doc --disable-libxcb --disable-xlib
make -j$(sysctl -n hw.ncpu)
cd ..

# Copy the binaries plus every Homebrew dylib they need, rewriting the load paths so
# the result runs on a machine without Homebrew. Fails loudly if anything is missed.
./build/bundle-dylibs.sh /tmp/ffstage ffmpeg-8.1.1/ffmpeg ffmpeg-8.1.1/ffprobe
```

`--disable-libxcb` matters: configure otherwise detects X11 and drags in seven
libraries a macOS media player has no use for.

Put the result in `bin/` at the repository root. That directory is deliberately not in
git — it holds build outputs, not source — and `npm run dist` copies it to
`Contents/Resources/bin/`, which is where the app looks at runtime. When running from
source instead, put it ahead of Homebrew on `PATH`. `npm test` includes
`test/ffmpeg-capabilities.test.js`, which asserts the filters are present and that no
`/opt/homebrew` path survived relocation; run it to confirm the build is good.

### The mpv addon needs the same treatment

`native/mpv` links `libmpv`, and a freshly built `mpv_render.node` points straight at
`/opt/homebrew/opt/mpv/lib/libmpv.2.dylib`. That works on the machine that built it and
nowhere else, so a `.dmg` shipped without this step launches to an immediate failure on
any Mac without Homebrew mpv:

```bash
npm run rebuild
./build/bundle-dylibs.sh /tmp/mpvstage native/mpv/build/Release/mpv_render.node
cp -R /tmp/mpvstage/ native/mpv/build/Release/
```

The script picks the reference base from the file's extension — `@loader_path` for a
`.node`, because a loadable module is loaded by Electron rather than run, and
`@executable_path` would resolve against Electron's own directory instead of the addon's.
`otool -L` on the result should show no `/opt/homebrew` entries.

### Deploying into an installed .app

`./deploy.sh` rsyncs `src/`, `vendor/` and the native *sources* into
`/Applications/Spritz.app` and re-signs it, for fast iteration without a full repackage.
Compiled addons and `node_modules` stay in the bundle — they are ABI-bound to the
Electron inside it. **Never edit inside the `.app`**: an unsigned modification breaks the
signature, and macOS then silently revokes the Local Network grant, which looks exactly
like cast discovery being broken.

Re-signing can also drop that grant on its own. If casting goes quiet after a deploy,
toggle **System Settings → Privacy & Security → Local Network** off and on before
suspecting the code.

To produce a distributable `.app`/`.dmg`: `npm run dist` (electron-builder — install it
first with `npm i -D electron-builder`). That runs `build/preflight-dist.js` first, which
refuses to package a tree that would produce an app only this machine can run — no
`bin/ffmpeg`, an addon still linked to `/opt/homebrew`, missing entitlements. Each
refusal names the command that fixes it. It exists because none of those failures are
visible at build time: electron-builder will cheerfully produce a `.dmg` with no ffmpeg in
it, and the result works perfectly until someone else opens it. If you redistribute a build bundling the GPL
`ffmpeg`/`libmpv` binaries, you must also carry the corresponding-source offer described
under [License](#license).

### Releasing a signed build (maintainers)

`npm run dist` alone produces an **ad-hoc-signed** `.dmg` — it runs, but users hit the
Gatekeeper prompt (see [Install](#install)). A friction-free release needs an Apple
Developer account ($99/yr):

1. Install your **Developer ID Application** certificate in the login keychain.
2. Enable notarization in `package.json` → `build.mac`: `"notarize": { "teamId": "<TEAMID>" }`.
3. Export credentials and build:
   ```sh
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Passwords
   npm run dist
   ```
4. Publish the `.dmg` to a GitHub Release (don't commit it to the repo):
   ```sh
   gh release create v2.0.0-alpha.0 dist/Spritz-*-arm64.dmg --title "v2.0.0-alpha.0" --notes "First public alpha."
   ```

## License

Spritz is free software, licensed under the **GNU General Public License, version 3
or later (GPL-3.0-or-later)**. See [`LICENSE`](./LICENSE) for the full text and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the licenses of all bundled
and linked third-party components.

A built app carries all of these inside it, in `Spritz.app/Contents/Resources/licenses/` (Help → *Show Licenses in Finder*): the GPL, the notices, Electron's and Chromium's licences, and the licence of every bundled npm package. The package check refuses a build that leaves any of them out, or that bundles a shared library the notices do not name.

### GPL binaries and corresponding source

Each release attaches **`Spritz-<version>-corresponding-source.tar`**: the source archives of the GPL and LGPL components at the exact versions inside that release, the Homebrew build recipe for each library, an index (`README.md` inside it) and checksums. You do not need to ask for it. If something is missing, open an issue and it will be provided at no charge.

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

If TV discovery stays empty after changing Local Network permission, use **Retry discovery**
on the welcome screen or in the Cast / AirPlay menu. Cast and DLNA report their search
results separately. AirPlay devices appear in the macOS picker; Spritz Receiver must
be open on the TV.

Torrent errors remain visible until dismissed. The stream status reports the selected
file's download progress and an approximate buffer runway. Spritz warns when the
selected file will not fit and stops torrent downloads below a 1 GiB free-space
reserve. New cache directories carry process ownership for crash recovery; older
unmarked cache directories are preserved.
