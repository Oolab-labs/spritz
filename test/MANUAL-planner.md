# Manual test: playback-planner rewire (real LG webOS TV)

## What is being tested

`src/main/lanserver.js` no longer contains the copy-vs-transcode decision. Both decision
sites (`serveHls`, `mkvArgs`) now call `planPlayback()` from `src/main/playback-planner.js`.
The intent is **no user-visible change** for everything except 8K sources (see §Known
deliberate change).

**Revert this commit if any of these happen:**

1. A 4K HDR HEVC file that used to cast as 4K HDR now looks washed-out, too dark, 1080p,
   or shows a spinner/black screen on the LG.
2. An AC3 / E-AC3 surround track that used to arrive as surround now arrives as stereo
   (or the receiver's audio-format readout says "PCM 2.0" / "Stereo" where it said
   "Dolby Digital").
3. A 1080p H.264 file makes the Mac's fans spin / `ffmpeg` appears in Activity Monitor
   during casting — it should be a pure copy, near-zero CPU.
4. Anything that played before now fails to start, **and** §0 says the TV is healthy.

Anything else (slower start, one-off stall, no discovery) — run §0 first. Do not diagnose
a regression until §0 passes.

---

## 0. Is the TV actually there? (do this FIRST, and again after any failure)

The LG sleeps, changes its DLNA port, and moves IP on DHCP lease renewal. Each of those
looks exactly like "the rewire broke casting". ICMP `ping` is unreliable here — webOS
answers ping while its media stack is asleep, and drops ping while awake on some firmware.
**Probe TCP instead.**

```sh
# Replace with the TV's current IP.
TV=192.168.1.x
for p in 8008 8009 7000; do
  nc -z -G 2 -w 2 "$TV" $p && echo "$p OPEN" || echo "$p closed"
done
# The one that actually matters — the eureka probe Spritz itself uses:
curl -s -m 8 "http://$TV:8008/setup/eureka_info?options=detail" | head -c 200; echo
```

- **Expected (TV awake and castable):** at least one of 8008/8009 OPEN, and the `curl`
  returns a JSON blob containing a `name` / `ssdp_udn` field.
- **TV asleep:** all three closed, or `curl` hangs the full 8 s and returns nothing.
  → Wake it with the remote, wait ~20 s, re-probe. **Not a regression.**
- **TV moved IP:** all closed at the old address. Find it again:
  `arp -a | grep -i lg` , or `dns-sd -B _airplay._tcp` / `dns-sd -B _googlecast._tcp`.
  **Not a regression.**
- **DLNA port moved:** eureka on 8008 answers but the DLNA device vanished from the list.
  webOS reassigns its UPnP port on reboot; Spritz rediscovers by SSDP. Restart the app and
  re-scan. **Not a regression.**
- **No devices at all, and the probe above succeeds:** this is the macOS Local Network
  permission, not the code. See §0b.

### 0b. Local Network grant (after every `./deploy.sh`)

Re-signing the bundle can make macOS silently drop the Local Network entitlement grant.
Symptom: discovery is completely quiet — zero devices, no SSDP, no mDNS — while §0's
`curl` from Terminal works fine.

Fix: System Settings → Privacy & Security → Local Network → toggle **Spritz off, then on
again**, then quit and relaunch Spritz.

**Also: the app must be fully quit and relaunched after `./deploy.sh`.** A running instance
keeps the old `lanserver.js` in memory and will happily give you a false PASS.

---

## Setup

1. Deploy, then **Quit Spritz (⌘Q) and launch the new build.** Confirm §0 passes.
2. Keep Activity Monitor open, filtered to `ffmpeg`. CPU there is the single best signal
   for "copy vs transcode".
3. Optional but very useful: on the LG, the info/settings overlay that reports resolution,
   HDR mode and audio format. Use it to read actual results rather than guessing.

---

## 1. Local playback (no cast) — the control

Play one 4K HDR HEVC file and one 1080p H.264 file locally in Spritz.

- **Expected:** both play normally, HDR file looks HDR, seek works. No `ffmpeg` process.
- **FAILURE:** anything broken here means the problem is *not* the rewire — local playback
  goes through mpv and never touches `lanserver.js`. Fix that first, then restart this doc.

## 2. Cast a 1080p H.264 file — must be untouched

Cast a 1080p H.264 MP4/MKV to the LG. Let it run 60 s. Seek once.

- **Expected:** starts within a few seconds; `ffmpeg` CPU stays low (audio-only remux at
  most, single-digit to low-double-digit %); TV reports 1080p.
- **FAILURE:** `ffmpeg` at 100%+ CPU, or the TV reports anything other than 1080p, or the
  Mac gets hot. That means a copy became an encode → **revert**.

## 3. Cast a 4K HDR HEVC file — must stay 4K and HDR

Cast a local 4K HDR (HDR10) HEVC file. Watch a bright and a dark scene.

- **Expected:** TV reports 3840x2160 and shows its HDR badge; `ffmpeg` CPU near-zero
  (video copy); picture matches local playback in §1.
- **FAILURE (any of):** TV reports 1080p; no HDR badge; picture is washed-out/grey (HDR
  metadata lost) or crushed-dark (tonemap applied when it shouldn't be); high `ffmpeg` CPU.
  → **revert**.

## 4. MKV with AC3 / E-AC3 surround — must NOT downmix

Cast an MKV whose default track is AC3 or E-AC3 5.1. Then switch to a second audio track
(different language / codec) mid-playback.

- **Expected:** LG audio readout says Dolby Digital / Dolby Digital Plus, multichannel.
  Track switching selects the right track (matching dialogue/language), and the second
  track's format is whatever that track actually is.
- **FAILURE:** readout says PCM/Stereo 2.0, or centre-channel dialogue collapses, or
  switching tracks plays the wrong language / silent audio. → **revert**.
  (Audio track selection is now indexed off `plan.audioTracks[audioTrack]`; a positional
  off-by-one would show up exactly as "wrong language".)

## 5. A file that genuinely needs transcode

Use something the LG cannot take directly — a VP9 or AV1 file, or an Xvid/VC-1 AVI.

- **Expected:** playback starts (a few seconds slower is normal); `ffmpeg` CPU is high;
  picture and audio are correct; seeking works.
- **FAILURE:** black screen, immediate stop, or an error toast. Note that the MKV/DLNA
  path has **no software-encoder retry** — if this fails only on DLNA and works on
  Chromecast/AirPlay, say so in the report rather than reverting blind.

## 6. Torrent stream

Start a torrent, wait for enough buffer, cast it to the LG. Let it run 2–3 minutes,
seek forward into un-downloaded territory, then back.

- **Expected:** same copy/transcode behaviour as the equivalent local file; buffering
  stalls recover; no crash.
- **FAILURE:** the stream is transcoded when the same content plays as a copy locally
  (torrent sources are often unprobed, and unprobed sources are deliberately started
  optimistically in copy mode on the HLS path). A *transcode* here where you expected a
  copy is worth reporting; a stall is probably the torrent.

## 7. Repeat §3 after the TV has slept

Let the TV sleep, wake it, re-run §0, then re-run §3. This catches the "works once,
breaks after reconnect" class of bug that the unit tests cannot see.

---

## Known deliberate change (not a regression)

**8K (4320p) sources.** An 8K H.264/HEVC file cast to a receiver advertising 2160p max
is now **downscaled and re-encoded**, where it previously attempted a direct copy (which
generally black-screened). If you have an 8K file: expect high `ffmpeg` CPU and a 4K
picture. That is intended, and it is the one item in this commit that is *not*
behaviour-preserving.

---

## Flagged by adversarial review — watch these specifically

These came out of an automated review of the diff. They are listed because they are the
most likely places for a surprise, **not** because they are known to be broken. Confidence
that each is a real user-visible problem is low-to-moderate except the first.

1. **8K copy-refusal is a real behaviour change** (high confidence, intended). Described
   above. It also fires on the DLNA/MKV path, which has no encoder-failure retry — if an
   8K file used to play by copy and now hard-fails, that is a genuine trade-off regression
   worth reporting.
2. **A profile whose `maxHeight` disagrees with its 4K flags** would now transcode where it
   used to copy — e.g. a device advertising HEVC-4K but `maxHeight: 1080` would downscale
   a 2160p source. No current code path produces such a profile, so this should be
   unreachable; but if a 4K file unexpectedly arrives at 1080p on *some specific device*,
   this is the first thing to suspect. §3 is the test.
3. **Audio codec name casing.** Codec matching is now case-insensitive (`ac3` vs `AC3`).
   ffprobe emits lowercase so this should change nothing, but §4 is the check: a track
   arriving as *copy* where it used to be *converted* would be the tell (more likely to be
   an improvement than a bug, but note it).
4. **`maxHeight` given as a string** (`"2160"` rather than `2160`) would now fall back to
   1080. No caller does this today. Same symptom as (2): unexpected 1080p.
5. **`test/_planner-equivalence.js` is not run by `npm test`** (the glob only picks up
   `*.test.js`). It must be run by hand: `node test/_planner-equivalence.js`. Its
   equivalence claim therefore is not protected by CI, which is part of why this manual
   protocol exists.
6. **Nothing consumes `plan.reasons` yet.** If the UI shows a stale or generic "Starting
   playback…" message instead of an explanation, that is expected at this stage, not a
   regression.

## Reporting

For any FAILURE, capture: (a) the §0 probe output at the moment of failure, (b) whether
`ffmpeg` was running and at what CPU, (c) the TV's own resolution/HDR/audio readout,
(d) the file's codecs (`ffprobe -hide_banner <file>`). Without (a) the report cannot be
distinguished from the TV being asleep.
