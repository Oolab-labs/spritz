## Spritz 2.0.0-rc.15 (pre-release)

A Mac media player (libmpv) that casts to your TV, plus an optional **Spritz Receiver** app for LG webOS TVs.
**This is a release candidate, tested by one person on one Mac and one TV.** Please read the caveats.

### Download
- **Mac app** — `Spritz-2.0.0-rc.15-arm64.dmg` (Apple Silicon, macOS 11+). Open it and drag Spritz to Applications.
  Builds are **ad hoc signed and not notarized**, so macOS blocks the first launch. Either run
  `xattr -dr com.apple.quarantine /Applications/Spritz.app` in Terminal, or on **macOS 15 and later** try to
  open it and then use **System Settings → Privacy & Security → Open Anyway** (on macOS 11 to 14, right-click →
  Open works too). Full steps: [README → Install](https://github.com/Oolab-labs/spritz#install).
- **TV app** — `com.spritz.receiver_0.3.2_all.ipk`, also inside the Mac app (Devices → *Show the TV installer
  in Finder*). Installing it needs LG **Developer Mode** on the TV and the webOS CLI; developer sessions
  expire. Details in the README under *Spritz Receiver for LG webOS*.
- `Spritz-2.0.0-rc.15-corresponding-source.tar` — the source of the GPL and LGPL components (see *Source and licences*).
- `SHA256SUMS` — verify your downloads.

### What was tested
On an LG NANO80T6A (webOS), every route below played a local 1080p file, a 4K file and a streaming torrent,
and switched audio and subtitles where the route allows it. DLNA, AirPlay and Google Cast were checked with
all three; Spritz Receiver with local files and a streaming torrent.

| Route | Audio and subtitles from the Mac | From the TV remote |
|---|---|---|
| Spritz Receiver | yes | yes |
| AirPlay | yes | not applicable |
| Google Cast | yes (restarts the stream, may jump back a few seconds) | not applicable |
| DLNA | no — the TV plays the original file | yes (the TV's own menus) |

The app says this itself: each row in the cast menu names the route and where tracks are changed, and the
audio and subtitle menus carry a note while you are casting. On a torrent that is still downloading, seeking
and subtitles only reach what has arrived.

### New since the last pre-release
- **Licences now ship inside the app** (`Contents/Resources/licenses`, and Help → *Show Licenses in Finder*): the GPL, the third-party notices (now naming all 47 libraries the app bundles, with versions and licences), Electron's and Chromium's licences, and every bundled npm package's. Earlier builds carried none of these. The package check now refuses a build without them.
- **Casting fixes found on the LG.** AirPlay now plays (its playlists were being refused, and read half-written);
  Google Cast now connects and plays 4 Mbps and 4K HEVC streams, resumes in the right place, and keeps subtitles
  in step (it crashed on any film with subtitles before).
- **A much smaller cast menu**, one short line per device, with Spritz Receiver first when it is online.
- **Pairing a TV** is one line: the TV's name and a four-digit field that submits itself.
- **Help → Check for Updates…** (opt-in; the only time Spritz contacts GitHub is when you click it) and a
  sandboxed renderer.
- Spritz Receiver 0.3.2: new icon and home screen, a pairing code that refreshes itself, *Pair again* and
  *Change Mac* from the TV, and a box to type the Mac's address if the TV cannot find it.
- Earlier in this series: a self-contained signed build with Electron fuses, accessibility and layout fixes,
  the window remembers its size, Anime4K shaders work when packaged, and a workaround for a libmpv crash when an
  audio device changes.

### Known problems (full list in the README)
- Not notarized. YouTube formats may be missing (no JavaScript runtime bundled for `yt-dlp`).
- AirPlay can report "Cannot Decode" the first time it is started partway through a film; starting it again
  has worked. Seen once, not understood.
- **Not yet verified:** the first-launch steps on a Mac that has never run Spritz, a very large remux from a cold start, an HDMI freeze seen once during development, picture
  and sound staying aligned by eye over a whole film, and the resume position after you stop casting.
- Receiver and casting were tested on one TV only; other Chromecasts and AirPlay receivers were not.

### Source and licences
GPL-3.0-or-later. The bundled ffmpeg is a GPL build, so the app conveys GPL and LGPL code. The source of those
components, at the exact versions inside this release, is attached here as
`Spritz-2.0.0-rc.15-corresponding-source.tar` (about 65 MB): thirteen upstream archives, the Homebrew build recipe
for each library, an index and checksums. Spritz's own source is this repository. The licence texts are inside
the app (Help → *Show Licenses in Finder*). See the README section *GPL binaries and corresponding source*.
