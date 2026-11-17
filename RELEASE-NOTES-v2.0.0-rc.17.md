## Spritz 2.0.0-rc.17 (pre-release)

A Mac media player (libmpv) that casts to your TV, plus an optional **Spritz Receiver** app for LG webOS TVs.
**This is a release candidate, tested by one person on one Mac and one TV.** Please read the caveats.

### Download
- **Mac app** — `Spritz-2.0.0-rc.17-arm64.dmg` (Apple Silicon, **macOS 27+**: see *Known problems*). Open it and drag Spritz to Applications.
  Builds are **ad hoc signed and not notarized**, so macOS blocks the first launch. Either run
  `xattr -dr com.apple.quarantine /Applications/Spritz.app` in Terminal, or try to open it and then use
  **System Settings → Privacy & Security → Open Anyway**. Full steps: [README → Install](https://github.com/Oolab-labs/spritz#install).
- **TV app** — `com.spritz.receiver_0.5.0_all.ipk`, also inside the Mac app (Devices → *Show the TV installer
  in Finder*). Installing it needs LG **Developer Mode** on the TV and the webOS CLI; developer sessions
  expire. Details in the README under *Spritz Receiver for LG webOS*. Devices flags a TV still on 0.4.x.
- `Spritz-2.0.0-rc.17-corresponding-source.tar` — the source of the GPL and LGPL components (see *Source and licences*).
- `SHA256SUMS` — verify your downloads.

### What was tested
On an LG 55NANO80T6A (webOS 24), with packaged candidate builds driven from the Mac and the TV's web inspector
(not by a person holding the remote):
- **Local playback:** play, seek, the Mac's subtitle menu, an external `.srt`.
- **Torrent:** first frame in about 7 s, then a minute of playback with no stalls.
- **Google Cast:** start, three seeks per run over many runs, the TV closing the Cast app (another app brought
  to the front) and a Stop sent from a second Cast sender, which is what the TV's remote sends. When the TV
  dropped Spritz's connection, Spritz reconnected and stayed on the TV; after four drops in ten seconds it
  returned to the Mac at the TV's position.
- **Spritz Receiver 0.5.0:** a torrent MP4 with two embedded subtitle tracks; both appeared in the TV's menu and
  showed the right lines after seeking.
- **DLNA:** plays and Stop returns to the Mac; it started from 0:00 rather than 10:00 (see *Known problems*).
- **AirPlay, local file:** picked from the macOS picker; the TV started within a second of the Mac's position,
  and after Stop the Mac resumed where the TV was.

### New since rc.16
- **Google Cast no longer hangs when the TV lets go.** If the TV closes the Cast app (Home on the remote, another
  input, another phone casting), Spritz returns to playing on the Mac at the TV's position. It used to sit on
  *Casting* with a clock that never moved, and sometimes cast again over whatever the TV was showing.
- **Stop on the TV's remote is respected.** Spritz used to treat it as a dropped connection and cast the film again.
- **Seeking while casting with Google Cast no longer freezes the TV.** When the TV had quietly closed Spritz's
  connection, the next seek failed and the TV sat on the old position for 30 seconds. Spritz now reconnects.
- **Subtitles for torrent MP4s on the Spritz Receiver.** The TV's subtitle menu used to be empty for an MP4
  streamed from a torrent; its tracks now appear a few seconds after it starts. Needs Spritz Receiver 0.5.0.
- **Stop or Back on the TV hands control back to the Mac** when casting to the Spritz Receiver. The Mac window
  used to stay on *Playing on TV*, and the Mac's own audio and subtitle menus did nothing after any cast ended.
- **AirPlay starts where you are.** Seeking ahead and then AirPlaying soon after used to start the TV minutes short
  of the Mac's position.
- **Torrents:** after playback moves to the TV, the download keeps focusing on what is being watched instead of
  treating the whole file as urgent.
- **Google speakers** (audio-only Cast devices) no longer appear as places to cast a film.
- **The mini player** is no longer remembered as the normal window size.
- **Subtitle files** you add are checked before they are passed to the TV and the converter.
- **Removed:** the hidden, shelved Whisper subtitle generator, and the text that still mentioned it. Online
  subtitles from OpenSubtitles are unchanged.
- **Under the hood:** a large removal of code nothing used (old receiver protocol, unreachable streaming paths,
  experimental flags, native leftovers), CI locked to the build tool versions in use, and corrected docs.

### Known problems (full list in the README)
- **Needs macOS 27.** Earlier notes named macOS 11 as the minimum, which was wrong: the bundled media libraries were built
  for the Mac that built the app (macOS 27), and macOS will not load them on an older version. The app may open
  there, but it cannot play. Supporting older macOS means rebuilding those libraries for an older target.
- Not notarized. YouTube formats may be missing (no JavaScript runtime bundled for `yt-dlp`).
- **After Stop, the TV stays on its AirPlay screen** until you quit Spritz or leave AirPlay with the TV remote.
  This is how macOS keeps AirPlay connections; playback itself has stopped.
- When casting starts or AirPlay hands over, the TV can start a few seconds before where you were (it repeats
  them rather than stalling) or start early and then jump to the right place.
- **Google Cast:** the LG sometimes closes Spritz's Cast connection mid-film, for a reason not yet known. Spritz now
  reconnects, which can restart the picture once or twice at the same spot.
  Once, right after starting, the TV reported an error on the stream twice and closed its Cast app; Spritz
  returned to the Mac.
- **DLNA** casts can start from the beginning rather than where you were.
- **Not yet verified:** the first-launch steps on a Mac that has never run Spritz, a very large remux from a cold
  start, an HDMI freeze seen once during development, and picture and sound staying aligned by eye over a whole film.
- Receiver and casting were tested on one TV only; other Chromecasts and AirPlay receivers were not.

### Source and licences
GPL-3.0-or-later. The bundled ffmpeg is a GPL build, so the app conveys GPL and LGPL code. The source of those
components, at the exact versions inside this release, is attached here as
`Spritz-2.0.0-rc.17-corresponding-source.tar`: the upstream archives, the Homebrew build recipe for each
library, an index and checksums. Spritz's own source is this repository. The licence texts are inside the app
(Help → *Show Licenses in Finder*). See the README section *GPL binaries and corresponding source*.
