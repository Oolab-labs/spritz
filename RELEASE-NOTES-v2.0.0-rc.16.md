## Spritz 2.0.0-rc.16 (pre-release) — DRAFT, not yet released

A Mac media player (libmpv) that casts to your TV, plus an optional **Spritz Receiver** app for LG webOS TVs.
**This is a release candidate, tested by one person on one Mac and one TV.** Please read the caveats.

### Download
- **Mac app** — `Spritz-2.0.0-rc.16-arm64.dmg` (Apple Silicon, macOS 11+). Open it and drag Spritz to Applications.
  Builds are **ad hoc signed and not notarized**, so macOS blocks the first launch. Either run
  `xattr -dr com.apple.quarantine /Applications/Spritz.app` in Terminal, or on **macOS 15 and later** try to
  open it and then use **System Settings → Privacy & Security → Open Anyway** (on macOS 11 to 14, right-click →
  Open works too). Full steps: [README → Install](https://github.com/Oolab-labs/spritz#install).
- **TV app** — `com.spritz.receiver_0.4.0_all.ipk`, also inside the Mac app (Devices → *Show the TV installer
  in Finder*). Installing it needs LG **Developer Mode** on the TV and the webOS CLI; developer sessions
  expire. Details in the README under *Spritz Receiver for LG webOS*. Devices now flags a TV still on 0.3.x.
- `Spritz-2.0.0-rc.16-corresponding-source.tar` — the source of the GPL and LGPL components (see *Source and licences*).
- `SHA256SUMS` — verify your downloads.

### What was tested
On an LG 55NANO80T6A (webOS 24, firmware 33.31.75), with packaged candidate builds:
- **AirPlay, local file:** connecting from the cast menu, playback on the TV, seeking, subtitle text shown on the
  TV, the TV dropping the connection (Spritz resumes on the Mac at the TV's position), Stop (resumes on the Mac
  at the right position), and reconnecting after a drop, after Stop and after a new file.
- **AirPlay, torrent still downloading:** playback on the TV, then Stop — the Mac resumed at the right position
  and the download carried on.
- **AirPlay start-up stalls:** 19 hand-offs measured to find the cause, then 3 hand-offs at positions that had
  always stalled, which all played with this release.
- **Spritz Receiver:** the new time display, launcher icon and launch screen, seen on the TV.
- Google Cast and DLNA were not re-tested in this round; their results from rc.15 stand.

### New since rc.15
- **AirPlay to the LG is reliable.** It used to connect only the first time per launch; after a dropped
  connection, Stop or a new file, the TV connected but nothing played. Fixed.
- **No more AirPlay start-up stalls.** The TV got stuck loading when playback was handed over late inside a
  stream segment; Spritz now starts it at a point the TV can play, and checks the TV ended up where the Mac was.
- **AirPlay subtitles show text.** A selected subtitle track no longer comes up empty, and a subtitle chosen
  while on AirPlay is kept when playback returns to the Mac.
- **AirPlay recovery.** If the TV drops the connection, Spritz returns to playing on the Mac by itself.
- **The whole AirPlay row** in the cast menu opens the device picker (click, Enter or Space), not just its icon.
- **Retry discovery** on the welcome screen and in the cast menu, with separate Google Cast and DLNA status.
- **Torrents:** the stream server only answers this Mac (TVs get a per-session link), downloads stop before the
  disk is full (1 GB reserve, with a warning when a file will not fit), and errors stay on screen until dismissed.
- **New app and TV icons**, sharper at small sizes and on the TV launcher.
- **Spritz Receiver 0.4.0:** the start and end times are readable from across the room (they were clipped to a
  sliver), and the launch screen now appears on current webOS.
- **Build check:** a package missing any of its npm dependencies can no longer pass verification.

### Known problems (full list in the README)
- Not notarized. YouTube formats may be missing (no JavaScript runtime bundled for `yt-dlp`).
- **After Stop, the TV stays on its AirPlay screen** until you quit Spritz or leave AirPlay with the TV remote.
  This is how macOS keeps AirPlay connections; playback itself has stopped.
- When AirPlay hands over, the TV can start a few seconds early and then jump to the right place.
- **Not yet verified:** the first-launch steps on a Mac that has never run Spritz, a very large remux from a cold
  start, an HDMI freeze seen once during development, and picture and sound staying aligned by eye over a whole film.
- Receiver and casting were tested on one TV only; other Chromecasts and AirPlay receivers were not.

### Source and licences
GPL-3.0-or-later. The bundled ffmpeg is a GPL build, so the app conveys GPL and LGPL code. The source of those
components, at the exact versions inside this release, is attached here as
`Spritz-2.0.0-rc.16-corresponding-source.tar`: the upstream archives, the Homebrew build recipe for each
library, an index and checksums. Spritz's own source is this repository. The licence texts are inside the app
(Help → *Show Licenses in Finder*). See the README section *GPL binaries and corresponding source*.
