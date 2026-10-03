# Spritz Receiver for webOS — architecture note

> **HARDWARE-PROVEN RECEIVER BASELINE: transport + playback + pairing.**
>
> The tree committed under this marker is the exact artifact that ran on the LG NANO80T6A — not a
> tidied reconstruction of it. The two receiver milestones were developed before a commit-backed
> checkpoint existed, so they are preserved as one truthful commit rather than split into synthetic
> historical ones. Everything below this line is measured on that tree.

Written BEFORE implementation, from a read of the existing code. Branch `webos-receiver`, a
separate worktree from `772b22d`. The VOD worktree at `<the original VOD checkout>` is frozen and
untouched.

## What already exists, and what it means for this

### Reuse — these are production abstractions, not scaffolding

**`device-profile.js`** already ranks capability provenance exactly the way Phase 10 asks for:

```js
const SOURCES = ['default', 'inferred-from-name', 'reported', 'observed', 'user-override'];
```

So "REPORTED vs OBSERVED" is not a new concept to invent — it is an existing rung with a defined
precedence, and the receiver becomes a new *writer* of `observed`.

**`device-memory.js`** is the other half, and its asymmetry is the rule the receiver must obey:

> A SUCCESS is attributable. […] A FAILURE is not attributable. When a receiver refuses a 4K HDR
> HEVC file with Dolby Vision and E-AC-3 in Matroska, it has told you that one of six things was
> wrong and not which.

The receiver reports rich errors, and it will be tempting to narrow a profile from them. **Do not.**
Errors are recorded as context; only successful playback writes capability.

**`receiver-playhead.js`** is the exact seam the Phase-"torrent future" section describes. It already
gates a receiver's reported position into the torrent engine's critical window, and already handles
the two traps: a position of 0 during load, and a cast of a local file while an unrelated torrent
runs. A new receiver reporting POSITION should flow through `playheadUpdate` rather than around it —
that is the torrent-priority future, already wired, needing only a caller.

**`lanserver.js`** serves the media and the VOD/HLS routes. The receiver does not replace it.

### Scaffolding — do not promote

**`webos/index.html` + `tools/package-spike.sh`** (in the VOD worktree, untracked) are an A/B/C/D
media-comparison harness: a hardcoded test menu, an IP sweep of `192.168.1.1-254`, and a `post()`
that fires one-way XHRs at a bespoke log endpoint. It exists to answer "which of four media shapes
stutters", and it answered that. Its keymap and its `armBackTrap` history trick are worth *reading*;
its structure is not a receiver. The new app is written fresh.

`tools/vod-isolate.js` is likewise a measurement harness for a question already answered.

## Direction

```
Spritz Mac                                   LG webOS
├── media engine (unchanged)
├── lanserver: HTTP + HLS/VOD (unchanged)
└── receiver hub: WebSocket SERVER  <───────  receiver app: WebSocket CLIENT
                                              ├── <video> (native webOS pipeline)
                                              ├── 5-way remote input
                                              └── state/position telemetry
```

The TV connects **out**. No server on the television. The Mac stays authoritative for media
preparation, and the TV is a playback endpoint that reports what it observes.

### Two channels, deliberately independent

Media travels over plain HTTP from `lanserver`. Control travels over the WebSocket. They must not
share a failure mode: **a control-channel drop must not kill healthy playback** (Phase 8). The video
element keeps playing from its own HTTP connection while the socket reconnects; on reconnect the TV
re-announces session, media and position, and the Mac reconstructs state rather than restarting it.

This is the deliberate inversion of the existing cast-pipe fragility that produced `cast-recovery.js`
and `resume-point.js`.

### Transport independence

The protocol is JSON messages with a version, a session id and a type. Nothing in the message shape
is webOS-specific: a Tizen or Android TV receiver would implement the same conceptual interface. LG
specifics (`webOSTV.js`, `luna://`, remote keycodes) stay inside the TV app, and are not allowed into
Spritz's generic receiver model.

### WebSocket implementation choice

`ws@8.21.3` exists in `node_modules` but only **transitively**, via `webtorrent` — it is not a
declared dependency, and this repo declares only four. Rather than depend on a transitive package or
add a dependency for a spike, the server side is a small pure framing module (`ws-frame.js`:
handshake accept-key, text frame decode/encode, close, ping/pong) plus a hub that attaches to an
existing `http.Server` via its `upgrade` event.

That is a real tradeoff and worth stating plainly: a hand-written frame codec is a classic source of
subtle bugs (masking, fragmentation, 16/64-bit lengths). It is chosen because the protocol is small
and text-only, and because a pure codec is exactly the shape this codebase tests well. If
fragmentation or binary frames are ever needed, replacing it with `ws` as a declared dependency is
the right move, and the hub interface is drawn so that swap costs one file.

## CORS — per-endpoint, not blanket

The webOS app runs from `file://`-like app origin, so it is cross-origin to the Mac's LAN server. The
existing server already sets `Access-Control-Allow-Origin: *` in six places, each for a measured
reason (the Google Cast receiver silently drops a sideloaded WebVTT track without it).

Endpoints fall into three classes, and they do **not** get the same policy:

| class | endpoints | needs TV access | policy |
|---|---|---|---|
| media | `/vod/*`, `/file/*`, `/hls/*`, `.vtt` | yes — `<video>` and subtitle fetches | permissive read (`GET, HEAD, OPTIONS`), as today |
| control | the WebSocket upgrade | yes | **not CORS at all** — WebSocket is exempt from same-origin; guarded by pairing instead |
| metadata/artwork | future | probably | decide when added; not opened pre-emptively |

The important consequence: **CORS is not the access control for the control channel.** A browser on
the LAN cannot be stopped from opening a WebSocket by CORS, so the socket needs pairing (Phase 9) —
which is why an unauthenticated permanent control channel is not acceptable even in the spike.

For this first milestone the media endpoints keep the policy they already have; nothing is widened.

## Scope of the first milestone

Connect → `LOAD` one HLS URL → play → remote pause/play and ±30s → continuous accurate position →
visible errors/state → understandable disconnect/reconnect. Then stop.

Explicitly not now: library UI, pairing crypto beyond a code, subtitle/audio switching, motion
gestures, app launching, torrent integration, any second receiver platform.

## HLS invariants carried over

The VOD work established these and this workstream must not regress them:

- ffmpeg owns segment boundaries; do not reconstruct a timeline in Spritz.
- split audio uses the one-muxer `-var_stream_map` package.
- every file a playlist references must exist.
- the `ffmpeg -v warning -i <playlist> -t 400 -c copy -f null -` gate stays the pre-flight.
- a `stalled` DOM event is **not** evidence of failure — measured, on this exact hardware. The clock
  is authoritative. Report both, and never treat "no JavaScript exception" as success.

---

# Milestone 1 — measured on hardware (2026-09-02)

LG NANO80T6A at <tv-ip>, webOS 24, Mac at <mac-ip>. Film: the 5981s HEVC Main-10 WEBRip,
pre-segmented into 989 segments in 3.5s. HLS integrity gate run first: **silent**.

## It works end to end

```
118.4s RECEIVER  webOS TV  id=lg-ixu03wxh1b4u  platform=webos
118.4s LOAD -> http://<mac-ip>:8099/media/media.m3u8
121.8s LOADED duration=5980.977s (source says 5981s)
121.9s STATE playing
```

Load to first frame: **3.5s** from LOAD to `playing`.

## Position reporting meets the acceptance target

```
145.7s MAC VIEW  playing   t=23.1s  buffered=70.0s  age=0.4s
...
152.7s MAC VIEW  playing   t=30.1s  buffered=72.0s  age=0.4s
```

The Mac's view is **0.3-0.4s stale**, against a target of roughly one second. The film clock advances
1.0s per 1.0s of wall clock — exactly 1:1.

`age` is printed alongside the value deliberately. A position without its age is not knowledge, and
the failure this channel exists to prevent is the Mac confidently believing a stale number.

## `stalled` is noise here too — now proven on the receiver path

The DOM `stalled` event fired repeatedly (149.1s, 157.7s, 168.1s, 180.7s, 189.7s — roughly per
segment boundary at 6s segments). Across every one of them the clock kept perfect 1:1 time and the
buffer stayed 40-70s ahead of the play head.

This is the VOD investigation's finding reproduced in the new architecture, and it is why the
protocol carries `stalled` as a **flag on a state**, never as a state. A receiver that reported it as
a fault would have the Mac chasing a stutter that is not happening. `bufferedUntil` is what
distinguishes the real cases: starved means the buffer is AT the play head, wedged means the buffer
is far ahead and the clock is still.

## What webOS actually exposes — REPORTED, first observation

```
CAPABILITIES (reported, NOT observed)
{"hls":"maybe","hevc":"probably","h264":"probably","eac3":"probably",
 "ac3":"probably","aac":"probably","screen":"1920x1080"}
```

Two things worth keeping:

- `canPlayType` answers "probably" for HEVC/E-AC3/AC3 and only **"maybe" for HLS** — the one format
  the television demonstrably just played for ten minutes. The string is close to worthless as
  evidence, which is exactly why device-profile.js ranks `reported` below `observed`.
- `screen` is **1920x1080**, not 3840x2160. The NANO80 is a 4K panel; the web runtime reports its own
  surface. Do not read a receiver's screen metrics as a panel capability.

Nothing has been written as `observed` yet. Per device-memory.js's rule, only a stream that actually
played may write one, and doing that properly is the next milestone's work, not a spike shortcut.

## The bug hardware found that unit tests could not

The first round connected, identified itself and reported READY — and was never sent a film.

The TV's `hello` omitted `role`, which the controller filters on to tell a receiver's greeting from
its own. The unit tests missed it because they construct the message with
`receiver-protocol.helloFrom()`, which sets `role`, while the TV application hand-rolled its own
object. Two implementations of one message shape, and only one of them was tested.

Fixed in the app, with that reason recorded at the line. The general lesson for the next milestone:
the receiver should build messages from a shared definition rather than a parallel hand-rolled one,
or this class of drift will recur.

## A real bug found and fixed by a unit test: disconnect took 20 seconds

`disconnect is reported with the receiver identity` passed, but took **20,004ms**. A socket taken
from an HTTP upgrade is half-open capable: the peer's FIN raises `end`, and with the writable side
still open `close` never follows. Nothing listened for `end`, so a departed television was only
noticed when a keepalive ping failed to write — two ping intervals later.

For those 20 seconds the Mac believed a film was playing on a receiver that was not there, which is
precisely the stale-state problem this channel exists to remove. Failing assertion added first
(`took < 2000`), then the fix; **6.6ms** after. Deliberately broken again afterwards to confirm the
assertion catches it.

## Mac -> TV commands, and seeks across the film

All exercised over the control channel (harness control endpoint, loopback only):

```
pause / play          honoured, state reported back
fwd30 / back30        seek 40 / seek 12
start   -> seek 5     playing at t=9.4s     4s later
middle  -> seek 2990  playing at t=2994.2s  4s later
end     -> seek 5891  playing at t=5895.6s  4s later
```

A seek to 5891s in a 989-segment playlist resumes as fast as a seek to 5s. That is the
pre-segmented package doing its job — every segment already exists, so a seek is an index lookup
rather than an encode.

## The reconnect bug, found on hardware and fixed

The Phase 8 property — a control outage must not disturb healthy playback — FAILED on its first
test, in the controller rather than the receiver.

Dropping the socket at film 5905.4s, the television reconnected in 1.4s and re-announced itself
perfectly: capabilities, LOADED with the right duration, STATE playing. The controller then sent
LOAD on the greeting, because it loaded on every hello, and **the film restarted from zero —
5905.4s to 7.8s.** The receiver did its job and the Mac discarded the answer.

Two changes:

- The receiver's greeting now CARRIES what it is holding (`playing: {mediaId, currentTime, state}`).
  A follow-up message cannot win that race; a field can.
- The decision moved into `src/main/receiver-session.js` as a pure `shouldLoad()`, with the bias
  stated: when in doubt, do not reload. A needless reload destroys a viewer's place in a film and is
  unrecoverable; a needless skip is corrected by the next command.

Re-tested on hardware:

```
56.5s MAC VIEW  playing  t=26.9s
      -> control socket dropped
58.2s RECEIVER  webOS TV  id=lg-ixu03wxh1b4u
58.2s NO RELOAD — receiver already holds this film  adopting t=28.889s state=playing
68.5s MAC VIEW  playing  t=38.9s
```

Reconnect in 1.7s, playback uninterrupted across it. The film never stopped.

A unit test caught a second defect while writing that module: `Number(null)` is **0, not NaN**, so a
receiver that could not supply a clock arrived as a confident "position zero" — the exact trap
receiver-playhead.js documents. Guarded explicitly.

## Position reporting during pause — a known gap, not a bug

While paused, the position stream is silent (it only ticks while playing), so the Mac's `age` climbs
— measured 0.4s to 4.4s across a five-second pause. The VALUE is not stale, because it is not
changing. But the position stream alone cannot distinguish "paused and healthy" from "died while
paused". Liveness is the socket's job (10s ping, 30s idle timeout), and that is the right split;
recording it so nobody later reads a growing age during pause as a fault.

## Numbers

- 391 tests, 0 failures. Lint clean (0 errors; 3 pre-existing warnings from the committed baseline).
- 10 minutes continuous playback, **0 errors**, clock 1:1 with wall clock throughout.
- Position freshness 0.2-0.4s against a ~1s target.
- LOAD to first frame 3.5s; pre-segmentation of a 5981s film 3.5s.

---

# Milestone 2 — LOCAL RECEIVER PAIRING (2026-09-02)

The control socket was unauthenticated: any device or browser on the LAN could open
`ws://mac:8099/receiver` and drive the television. That is now closed.

## Pairing architecture

```
TV connects  ->  UNAUTHENTICATED
                 |                                   has stored credential?
                 |-- no  -> pair.request  -> Mac mints a 4-digit code
                 |          pair.challenge -> TV DISPLAYS it
                 |          human types it on the Mac
                 |          pair.accepted (credential, once) -> AUTHENTICATED
                 |
                 +- yes -> auth {receiverId, proof} -> auth.ok -> AUTHENTICATED
                                                    -> auth.failed -> stays untrusted
```

The visible code is NOT the long-term secret and authenticates nothing. Its only job is to bind the
connection that asked to pair to the screen the human is looking at — a confirmation channel that
runs through the human's eyes. An eavesdropper who learns it gains nothing, because only the Mac's
own UI can redeem it and the human types the code from THEIR television.

**Code expiry: 5 minutes.** Long enough to walk to another room, read it and walk back — which is the
normal case, not the edge one. Anything under a minute fails that. Single-use, and a pending pairing
is burned after 5 wrong attempts so a local process cannot grind the 10,000-code space during the
window.

## Credential and storage model

- 32 bytes (256 bits) from the CSPRNG, base64url, unique per receiver, revocable. **Not derived from
  the pairing code** in any way.
- **Challenge-response, not bearer.** The Mac offers a per-connection nonce; the TV returns
  HMAC-SHA256(token, nonce). The credential never crosses the wire after the pairing moment, so a
  passive listener on the same Wi-Fi — plausible on a home LAN carrying plain `ws://` — captures one
  useless proof for one dead nonce instead of a permanent key.
- The cost, stated plainly: the Mac holds the token itself rather than a one-way hash, because HMAC
  needs the key. Accepted, because a compromised Mac is explicitly out of scope and that machine
  already holds the media and the library.
- Mac store: JSON at `~/.spritz-receivers.json`, **mode 0600** (verified `-rw-------` on hardware).
- **TV storage, verified rather than assumed: webOS gives a web application ordinary
  `localStorage`.** There is no keystore, no secure element, and no OS-backed secret storage
  reachable from this context. `crypto.subtle` is not dependable either — WebCrypto requires a secure
  context, which an app origin is not guaranteed to be, which is why the receiver ships a plain-ES5
  HMAC checked against Node's crypto and the RFC 4231 vector. The credential therefore sits in
  localStorage in the clear. That is adequate against another DEVICE on the LAN and useless against
  code execution on the television — which is out of scope, and is why revocation exists.

## Protocol changes (envelope unchanged)

`{v, type, sid, t}` is untouched. Added: `pair.request`, `pair.challenge`, `pair.accepted`,
`pair.declined`, `auth`, `auth.ok`, `auth.failed`. The controller's `hello` gained `nonce` and
`auth: 'required'`.

**Where authentication happens, and why:** an authenticated FIRST MESSAGE, not the URL and not a
header. The URL is out because URLs are logged. A header is out because the browser WebSocket API
cannot set one — decisive, since the receiver is a web application — and smuggling it through
`Sec-WebSocket-Protocol` is exactly the non-standard cleverness worth avoiding.

`PRE_AUTH_ALLOWED = ['hello','ping','pong','pair.request','auth']` lives beside the message
definitions rather than inside a socket handler, so someone deciding whether a NEW message type is
safe before authentication finds the answer where the messages are.

## Security boundaries

- **Inbound:** anything outside `PRE_AUTH_ALLOWED` is refused before it reaches a listener, so a
  controller cannot act on an unauthenticated command merely by subscribing to it.
- **Outbound:** `POST_AUTH_ONLY` (`load/play/pause/seek/stop`) is refused to an unauthenticated
  socket. Gating only the inbound direction would still hand a media URL — the private thing this
  channel gives out — to a stranger.
- An unauthenticated greeting is NOT forwarded as a session event, so `shouldLoad` never runs for an
  untrusted socket.
- **Revocation is ordered before the cryptography**, so no future edit can let a correct proof
  through for a forgotten television.
- A failed or revoked socket is NOT dropped: the television is very likely playing, and losing
  authority must not blank the screen.

Identity stays three separate things: `receiverId` (stable, survives DHCP and reinstall),
`sessionId` (per connection, minted by the Mac), and the credential. A reconnect makes a new session,
never a new television.

## Measured on hardware — LG NANO80T6A

```
29.3s  receiver: webOS TV id=lg-ixu03 state=UNAUTHENTICATED
29.3s  receiver: refused capabilities from unauthenticated session   <- the gate, live
29.3s  pairing challenge created, expires in 300s
       [0 media URLs sent, no code in the log, no trust store yet]
74.3s  pairing succeeded -> LOAD -> playing
```

| step | result |
|---|---|
| unpaired TV cannot control playback | **confirmed** — `refused capabilities`, 0 LOADs sent |
| pair from Mac with the on-screen code | succeeded, film loaded and played |
| pause / resume / seek while paired | all honoured |
| seek middle / near end | t=2991.6s, t=5891.0s |
| **drop socket mid-film** | reconnect 1.4s, `AUTH OK`, `NO RELOAD ... adopting t=5901.167s`, playback 5899 -> 5913s **uninterrupted** |
| restart TV app | instant `AUTH OK`; **one** pairing challenge in the whole session |
| revoke on Mac | live session lost authority immediately; `refused to send pause`; store `token=None, revokedAt` set |
| old credential after revoke | fails; TV cleared its own token and asked to re-pair |
| re-pair | new 43-char credential, `revokedAt` cleared, film played |
| new credential on reconnect | `AUTH OK`, `NO RELOAD`, uninterrupted |

The credential appeared in the log **zero** times.

## Two bugs only hardware could find

1. **The pairing code was invisible.** Revoking mid-film put the new code on the home screen, which
   is `display:none` behind the video. The viewer was told nothing and had no way to re-pair without
   leaving playback. The pairing panel is now an OVERLAY when a film is up.
2. **Back opened webOS's "exit app?" dialog** instead of returning to the receiver. The milestone-1
   spike carried an `armBackTrap` (a pushed history entry giving the platform something to pop); the
   rewritten app dropped it. Restored. No unit test can catch this — it is platform behaviour.

## Tests

**424 pass, 0 fail** across three consecutive full runs; lint clean (0 errors, 3 pre-existing
warnings). New: `receiver-registry.test.js` (17), `receiver-auth-gate.test.js` (12, over a real
socket), `hmac.test.js` (4).

Deliberate breaks, each caught and each restored byte-identically (verified by size and by re-run):

| break | result |
|---|---|
| inbound gate disabled | 2 failures |
| outbound gate disabled | 1 failure |
| revocation check moved after the proof | 1 failure |
| TV hello `role` removed (milestone 1) | film never sent |

## KNOWN CROSS-WORKSTREAM DEPENDENCY — not copied

`test/lanserver.test.js` "the token is required, and unguessable" fails roughly **1 run in 16** here.
It is a COMMITTED baseline test, and the fix exists only as an UNCOMMITTED change in the frozen VOD
worktree. The cause: the test builds a near-miss token by forcing the last character to `'0'`, which
reconstructs the REAL token whenever it already ends in `'0'`, so the server correctly serves the
file and the test reports a leak that did not happen.

Per the brief this was NOT copied across. When the VOD branch lands, this flake disappears; until
then a red run of that one test here means the dice, not a regression.

## Limitations and remaining risks

- **Plain `ws://`.** Challenge-response keeps the credential off the wire, but everything else —
  media URLs, positions, the pairing code — is readable by a passive listener on the LAN.
- **The credential is in localStorage in the clear.** Anything with code execution on the TV can
  take it. Revocation is the answer, not prevention.
- **The Mac-side confirm path is the code's only guessing surface.** It is loopback-only in the
  harness; production must keep it behind the Electron UI, not an open endpoint.
- Nothing has been written into `observed` capability state. Still deliberate.
- The harness control endpoint returns 200 for a command the hub then refuses — cosmetic, but it
  would mislead someone reading only the HTTP response.

## Next milestone

**Production wiring**, not another receiver feature: move the hub and registry out of
`tools/receiver-dev.js` into `lanserver`/`main.js`, put the pairing prompt and the receiver list in
the Electron UI, and add the receiver as a real cast target alongside AirPlay/Chromecast/DLNA. That
is what makes any of this reachable by a user. Only after that: observed-capability learning, which
now has a trustworthy identity to hang evidence on.

---

# The product boundary this work exposed

**DLNA / Chromecast / AirPlay — Spritz adapts itself to someone else's receiver.** Every capability
is inferred, every failure is ambiguous, and recovery is guesswork. The scars in this codebase are
the record of that: `cast-recovery.js`, `resume-point.js`, `minimalStreamInf`, the `-12927`/`-12646`/
`-16839` workarounds, and a VOD livelock that took days to attribute because the receiver could only
be observed, never asked.

**Spritz Receiver — Spritz controls both sides of the playback relationship.** Exact position rather
than a reconstructed one. Recovery that is designed rather than salvaged. A trusted, revocable
identity. Room for torrent-aware seeking, richer track handling and explainable playback as
FIRST-CLASS behaviour instead of workarounds.

That distinction should drive where effort goes. On the foreign-receiver paths, the goal is to fail
less. On the native path, the goal is to know more.

# Next milestone — production wiring (scope, agreed)

> Integrate the proven receiver as another Spritz playback target WITHOUT rewriting the proven
> receiver internals.

```
Spritz UI -> Cast Target abstraction -> LG Spritz Receiver -> receiver hub/session -> TV
```

Four things, and only these four:

1. Start the hub and registry from the real Spritz lifecycle rather than `tools/receiver-dev.js`.
2. Surface paired and online receivers in the Electron UI beside the existing playback targets.
3. Move pairing confirmation into a real Spritz UI flow (out of the loopback control endpoint —
   note the harness endpoint is NOT a production surface and must not become one).
4. Selecting "Living Room LG" sends the EXISTING playback plan through the proven receiver protocol.

Explicitly OUT of that milestone: torrent-specific behaviour, auto-launch / Wake-on-LAN, richer TV
UI, observed-capability learning, Mac<->TV handoff, and TLS. Each is easier once the receiver is
reachable from the actual product, and none of them is a prerequisite for that.

The receiver internals — `ws-frame`, `receiver-protocol`, `receiver-hub`, `receiver-registry`,
`receiver-session` — are the proven part. Production wiring should CALL them, not edit them. A change
to any of those files during integration deserves a moment's suspicion and a test.

---

# Milestone 3 — production wiring (plan, before implementation)

Read of the existing application, and what it means for each of the four capabilities.

## What already exists, and what it decides

**`lanserver.js` creates its HTTP server lazily** in `ensure()`, and does NOT expose it. The control
channel is meant to share that port through `upgrade`, so lanserver needs one small addition: a way
to hand the live server to a subscriber, including after a teardown/relisten. That is the only
production file whose behaviour changes to make the receiver reachable.

**Cast targets already have a shape** — `cast.js` emits `{ id, type, host, name }` and `main.js`
forwards it to the renderer as a `cast-event`. A Spritz Receiver becomes another entry in that
vocabulary rather than a parallel "receiver devices" universe. Its `id` is the STABLE receiver id,
never the address.

**IPC convention** is `ipcMain.on` / `ipcMain.handle` in `main.js`, exposed through
`contextBridge.exposeInMainWorld('soda', …)` in `src/preload/preload.js`. The receiver follows it
exactly; the renderer deals in receiver ids and user actions, never credentials.

**`resume-point.js` is NOT a reload policy, and must not become one here.** Read closely, it answers
a question that does not exist on this path: where should ffmpeg restart when a receiver re-GETs a
LIVE cast pipe. The receiver plays a finite VOD playlist over its own HTTP connection; nothing
re-launches an encoder, so there is no restart to position. Its role in this milestone is exactly
one thing: supplying `startSec` as a FACT on the FIRST load. `shouldLoad()` remains the only thing
that decides load-versus-adopt.

**`history.js`** owns Continue Watching, and `main.js` already computes a hand-off position
(`mpvPos() || lastAvTime || 0`). That is the same kind of fact.

## Module boundary

```
main.js  (lifecycle, IPC)
  └── receiver-service.js     start/stop, wiring, target events, play()
        ├── receiver-store.js     registry file: load/save, 0600      [fs]
        ├── receiver-targets.js   registry + live sessions -> target list  [pure]
        └── receiver-hub.js       PROVEN — called, not edited
              └── receiver-registry.js / receiver-protocol.js / ws-frame.js   PROVEN
        and receiver-session.js   PROVEN — the only load/adopt authority
```

New code is deliberately thin and mostly pure. The proven modules are consumed through their
existing seams: `createReceiverHub({ registry, onLog, onRegistryChange })` already exists for exactly
this, so the application can own persistence the way `device-memory.js` expects without persistence
moving into the hub.

## Discovery — the honest boundary

The television cannot do mDNS. A webOS web application has no UDP multicast and no raw sockets, so
the `multicast-dns` reuse that would be obvious on the Mac side is not available to the consumer that
needs it. Advertising `_spritz._tcp` from the Mac would be tidy and unusable by this receiver.

What the TV *can* do:

1. **Remember.** The address of the Spritz that last authenticated it, in localStorage. This is the
   common case after first run and costs one connection attempt.
2. **Ask the platform where it is.** webOS exposes the television's own IP through
   `luna://com.webos.service.connectionmanager/getStatus`. That gives the /24, which turns "search
   the internet" into "probe 254 addresses on one port" with bounded concurrency. LG-specific, and
   therefore confined to the TV application where platform specifics are allowed to live.
3. **Ask the human**, as a last resort, on the pairing screen.

So: remembered host, then a bounded subnet probe, then manual entry. `host.json` stays a development
convenience that is tried FIRST when present and is absent in a real install — it is no longer the
only way to find Spritz, which is what made it product configuration by accident.

A probe endpoint is needed that an unauthenticated stranger may safely hit. It answers only "a Spritz
is here, and this is its name" — no media, no library, no receiver list.

## What is NOT in this milestone

Everything in the brief's exclusion list. Additionally, `registry.observed` stays `null`: pairing
establishes identity and trust, and says nothing about what the panel can decode.

## `lanserver.test.js` cannot be run one test at a time

Its teardown lives in `test('cleanup', ...)`. Filtering with `--test-name-pattern` excludes that
test, so the HTTP server is never closed, the process cannot exit, and the run hangs until whatever
timeout the caller imposed.

Measured while trying to characterise the flake below: 20 filtered runs produced **18 timeouts and
0 passes**, which says nothing about the flake and everything about the invocation. Run the file
whole, or the whole suite.


## What the receiver actually plays in production today — and why it is not the VOD path

Measured on hardware through the real application:

```
load requested -> loading -> loaded media, duration unknown -> playing at 3.3s
url:  http://<mac-ip>:51526/hls/c950569...           <- LIVE HLS, not /vod/
proc: ffmpeg ... -c:v h264_videotoolbox -b:v 16M ... -hls_playlist_type event -hls_flags omit_endlist
```

So the receiver works, but it is riding the LIVE HLS path and paying a full H.264 transcode of a
10-bit HEVC source that this television can decode natively. Two deliberate decisions cause it, and
neither is a defect in this milestone:

1. **`SPRITZ_VOD` is off by default.** The pre-segmented VOD path — finite playlist, stream copy,
   instant seeks — lives on the frozen `vod-seekable-playback` branch and is not in this worktree's
   HEAD. `resolveCastable` therefore falls through to `serveHls`.
2. **The receiver is handed the CONSERVATIVE capability profile**, because `registry.observed` stays
   null this milestone. Pairing proves identity, not codecs, so the plan assumes 1080p H.264 and
   re-encodes.

The costs are real and worth naming rather than discovering later:

- `duration unknown` — an EVENT playlist with `omit_endlist` has no length, so the application cannot
  show a progress bar or a remaining time for receiver playback.
- A live transcode where a stream copy would do, on hardware measured last milestone as decoding the
  original untouched.
- The live pipe is the arrangement that produced `resume-point.js`, `cast-recovery.js` and a stack of
  commits about paused receivers killing sockets. The receiver inherits that fragility until the VOD
  path lands.

This is the strongest argument yet for the two deferred milestones, in this order: land the VOD work
(which removes the live pipe), then observed-capability learning (which removes the needless
transcode). Neither belongs in production wiring, and the wiring is correct as it stands — it asks
Spritz's existing planner for a plan and plays what it is given.

## The decode failure is the MEDIA PATH, not the wiring — controlled comparison

Same television, same receiver build, same film, same sequence. The only variable is what the
receiver was handed.

| | live HLS (`/hls/`, transcoded, EVENT playlist) | preseg VOD (`/vod/`, stream copy, ENDLIST) |
|---|---|---|
| duration reported | `unknown` (omit_endlist) | **5980.977s** |
| played to | ~85s | **367s and counting** |
| pause at ~85s / ~358s then resume | **fatal MEDIA_ERR_DECODE (code 3)** | clean, position preserved |
| errors | 1 fatal | **0** |

The preseg playlist came from the FROZEN worktree's own `SPRITZ_VOD_PRESEG` implementation, run in
place from a scratchpad script — nothing was copied into this branch, and
`grep -R SPRITZ_VOD_PRESEG src/` still returns nothing here. Gate on that playlist: 989 entries,
ENDLIST, silent.

**Conclusion: production wiring is correct.** It asks Spritz's existing planner for a plan and plays
what it is given; handed good media it plays perfectly, and the receiver survives the pause/resume
that kills it on the live pipe. The decode failure belongs to the live-HLS path the VOD milestone
already exists to replace.

### A hazard this experiment exposed

Two Spritz instances share ONE temp directory. `os.tmpdir()/spritz/vod` is global, `createLanServer`
wipes it at construction, and `teardown()` wipes it on quit. Quitting the production application
therefore deleted the frozen server's segments out from under it — and the television reported
`MEDIA_ERR_SRC_NOT_SUPPORTED`, which reads like a codec problem and was actually a 404. The first
run of this comparison was invalidated by that, not by the media.

The same shape has now bitten three times: test isolation, this, and the earlier `add -N`/`checkout`
truncation. Anything keyed on a fixed global path is shared state between processes that do not know
about each other.

## The open handle (2026-09-03): a listen that outlived its stop

The suite printed every pass and never its summary. Diagnosed by writing the run to a file and
recording the exit rather than piping through anything that buffers: the parent stayed alive and
`lsof` showed the `receiver-service.test.js` child still holding `*:7737 LISTEN`.

The beacon was recorded (`beacon = s`) only inside the listen callback. Two service tests call
`stop()` in the same tick as `start()`, before that callback runs, so `stop()` found nothing to
close — and the callback then installed a live listener on a service that had already stopped.
Nothing ever closed it. `lanserver.ensure()` had the identical shape (`server = s` only on
listen), so a `teardown()` in the same tick leaked the media server the same way.

Both now record the in-flight server before `listen()` and close it in `stop()`/`teardown()`; the
listen callback closes itself if the owner has already gone. Failing test first
(`a stop in the same tick as start still closes the beacon`), then the fix, then each fix reverted
in turn: the beacon break fails the assertion and hangs; the lanserver break hangs with no red
test, because the assertion can only see the beacon port. That leg is guarded by the summary
going missing, which is how the fault was found in the first place.

The service tests also bound the PRODUCTION beacon port (7737) because the fixtures passed no
`beaconPort`; they now bind port 0. A test that leaked would otherwise have taken discovery away
from a running Spritz.

Also tidied: after a fatal error the dead video element fires a trailing DOM `pause`, which the
receiver reported as `paused` with no media. The TV ignores media events when nothing is loaded
(the error itself still passes), and the service ignores a state that names no media at a session
holding none — with a test.

475 pass, 0 fail, summary printed, natural exit, two consecutive runs. Lint 0 errors, the same 3
pre-existing warnings. Still NOT verified: revoke and re-pair through the real Electron UI — the
code must be read off the television by a person, which is the design.

## Where the VOD path came from (2026-09-03, landed from the frozen worktree)

The VOD work was developed on a separate worktree and landed here as an 8-file delta. Its
committed body was already an ancestor of this branch; what landed was the uncommitted remainder.
The findings below are the ones still load-bearing — they are why the code is shaped as it is, and
re-deriving any of them costs a hardware round. The rest of that worktree's handoff is superseded.

### The receiver livelock, and why boundaries are ffmpeg's to choose

Cutting each segment independently (`segmentArgs`, one ffmpeg per segment) gives every segment the
open-GOP lead-in: a CRA keyframe's leading pictures reference the previous IRAP, so a stream copy
must include it. Consecutive segments therefore OVERLAP in presentation time — measured 1.9-10.4s on
a real HEVC WEBRip — while the playlist, carrying no `EXT-X-DISCONTINUITY`, promises a continuous
timeline. ffmpeg's own HLS demuxer reports a discontinuity at EVERY boundary, accumulating 83.6s of
correction over nine of them. The LG tolerates the lie for 130 seconds and then **livelocks**:
15,107 aborted segment fetches, alternating between the two segments whose ranges conflict, each
connection closed by the receiver after ~20ms. The negative `buffered` reading that accompanies it
is a consequence of the receiver abandoning its own fetches, not starvation.

Nothing is special about the segment where it wedges. The error accumulates; that is merely where
tolerance runs out. Do not look for a property unique to it.

**Forcing our own boundaries is dead in every form tried** — all corrupt at the identical packet:
`-segment_times` at keyframe PTS, at keyframe DTS, with `-segment_time_delta`, with audio removed
(`-an`), and `-segment_frames` cutting on decode-order frame numbers. So it is not PTS-vs-DTS, not
rounding slack, not audio alignment, and not the time-threshold mechanism. The boundary overlaps in
DECODE order — the next segment's keyframe has DTS 14.431 while the previous segment's last packets
run to DTS 14.472 — and a split there is not expressible. `-copyts` is exonerated.

The decisive asymmetry: ffmpeg's own `-f hls` cuts at that SAME keyframe and is clean. **The cut
point was never the problem; dictating it was.** This is why `presegmentArgs` uses `-f hls` and not
`-f segment`, and why "simplifying" it back is a regression, not a cleanup. There is a test.

### Segmenting is not encoding

The on-demand design justified per-segment cutting as avoiding "the expensive path" of pre-encoding.
That conflated re-encoding, which is genuinely expensive, with segmenting, which is free. Measured
on the 5981s WEBRip: a stream copy segments 600s in 0.3s — 2169x realtime, ~3s for the whole film —
at a disk cost roughly equal to the source (2.9 GB against 2.8 GB). What the on-demand path bought
in exchange was the overlap above.

The keyframe pass is the real cost and the preseg path skips it: `-skip_frame nokey` decodes nothing
but is still a full pass over the file, measured at 33.9s on that source (32.5s on a two-track
split-audio source before the skip covered that case too). It buys only the spans the on-demand
producer cuts to, and preseg cuts to no spans at all.

### Verified through the route on the real film, so do not re-chase

Playlist 989 entries with `ENDLIST`, TARGETDURATION 16; the ffmpeg HLS-demuxer gate SILENT (no
`Packet corrupt`, no `timestamp discontinuity`); seeks straight to segments 900/950/988 served in
11.8/3.7/2.8ms with no earlier segment ever fetched. Also verified clean and not worth re-testing:
every segment opens on a keyframe, no segment produces decode errors under `-c copy -f null`, the
declared timeline tracks actual PTS with no drift, and response headers are correct — Content-Length
present, Range honoured with a correct 206.

The two-minute gate that catches a wrong fix before it costs a hardware round:

```bash
ffmpeg -v warning -i "http://<host>/vod/<token>/media.m3u8" -t 200 -c copy -f null -
```

Silence = fixed.

### Corrections carried over — do not re-chase these either

- **Read-ahead does NOT remove the LG's per-boundary `stalled`.** It fires on the segment transition
  whether or not the segment was already cached (verified: the cache held through segment 27 while
  playing segment 22; a cached segment answers in ~3ms). `stalled` counts are not a signal for this
  route. Read-ahead is kept for keeping production off the critical path, which is an argument from
  the mechanism, not a measurement.
- **A DTS-based seek was tried and reverted.** It lands one keyframe early too, and on frame-probe
  timestamps whose PTS/DTS columns are out of step it overshoots into gaps, which is worse.
- **webOS exposes zero HTML5 `textTracks`**, even for a raw MKV with 33 subrip tracks, and never
  fetches a `.vtt`. Subtitle switching cannot be tested on webOS. Not a manifest fault.
- **The subtitle cap is for AVPlayer, not the LG.** AVFoundation walks every rendition named in the
  master before showing a frame and refused a 40-rendition master outright (status=failed, empty
  error log) where the same source at 8 loads and plays. The finite playlist buys no exemption: the
  walk happens before any media is requested. Known-lossy — the cap of 8 comes from a "40 fails, 8
  works" measurement and the real limit was never bisected.
- **AirPlay has never been tested on this route at all.** Every hardware result is from a webOS
  television, which is not the receiver `main.js` hands the `/vod/` URL to.

### House rule this work established

**Break and restore through git, never through `cp`.** A `cp` restore that did not take left the LRU
serving guard silently disabled for several runs, and the "guard present, test passes" result that
came out of it was very nearly reported as real. Git-visible state makes a surviving broken
experiment obvious instead of invisible.
