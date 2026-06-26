# Spritz — Diagnostic & Improvement Report

_Generated 2026-06-26. A multi-agent diagnostic sweep of the codebase, cross-checked
against current online best-practice and advisory sources. Diagnosis only — no
behavioural code was changed by this report._

Spritz is a ~6,150-line arm64 macOS media player: an Electron main/renderer JS app
plus three Objective-C++ N-API native addons (libmpv render, AirPlay/AVFoundation,
Now Playing). Four subsystems were audited in parallel:

1. Electron process model, IPC surface & macOS entitlements
2. Networking & casting (LAN HTTP server, Cast, DLNA/SSDP, torrent)
3. Native Objective-C++ addons (memory safety & threading)
4. Dependency currency & renderer code quality

**Overall posture: above average for an Electron media player.** `contextIsolation`
is on, `nodeIntegration` is off, the preload bridge is scoped, mpv command/property
denylists exist, the OpenSubtitles path is well-hardened, SSDP `LOCATION` URLs get a
robust SSRF guard, mDNS parsing is crash-hardened, and timer/async-race hygiene in the
renderer is solid. The findings below are the gaps that remain.

---

## Top priorities (cross-subsystem)

| # | Severity | Area | Issue | Where |
|---|----------|------|-------|-------|
| 1 | Critical | Native | mpv TSFN `Release()` can race the still-running event-pump thread → use-after-free crash | `native/mpv/mpv_addon.mm:619-642` |
| 2 | Critical | Native | Cached `getNativeWindowHandle()` NSView pointer can dangle across window close/recreate | `mpv_addon.mm:282,297`; `airplay_addon.mm:124,149` |
| 3 | Critical | Network | WebTorrent server bound to `0.0.0.0` exposes a directory index of the whole torrent store to the LAN with no auth | `src/main/torrent.js:129` |
| 4 | High | Electron | No navigation hardening: `setWindowOpenHandler` / `will-navigate` are entirely absent | `src/main/main.js` (createMainWindow) |
| 5 | High | Electron | Argument injection into yt-dlp/ffmpeg — untrusted URLs/paths spawned with no `--` guard or leading-`-` rejection | `main.js:36,53,369,516` |
| 6 | High | Native | libmpv render-context state (`gRender`) raced between display-link redraw and teardown free | `mpv_addon.mm:190-226` vs `633-637` |
| 7 | High | Deps | `castv2-client` abandoned ~9 years; drives Chromecast — supply-chain liability | `package.json` |

---

## 1. Electron process model, IPC & entitlements

| Sev | Finding | Location | Fix |
|-----|---------|----------|-----|
| High | No `setWindowOpenHandler`/`will-navigate` anywhere — renderer (or DOM-injected content) can navigate top frame to a remote origin or `window.open()`. | `main.js` createMainWindow | Add `setWindowOpenHandler(() => ({action:'deny'}))` and a `will-navigate` guard that allows only `file:` (parse with `URL`, not `startsWith`). |
| High | yt-dlp/ffmpeg spawned with untrusted URLs/paths and **no** end-of-options `--` separator or leading-`-` rejection → option-injection (yt-dlp `--exec`, ffmpeg `-i` flag injection — cf. Jellyfin GHSA-866x-wj5j-2vf4). | `main.js:36` `resolveStream`, `:53` `resolveAirplayUrl`, `:369` whisper, `:516` `thumb:at` | Validate scheme with `new URL()`, reject `/^-/`, pass user value after `--`, prefix relative ffmpeg paths with `./`. |
| Medium | CSP allows `style-src 'unsafe-inline'` and lacks `connect-src`/`frame-src`/`form-action`. | `src/renderer/index.html:5-6` | Drop `unsafe-inline` (move inline styles to DOM/stylesheet), add `connect-src 'self'`, `frame-src 'none'`, `form-action 'none'`; also set CSP via `onHeadersReceived` so it can't be stripped. |
| Medium | `sandbox:false` (preload uses `require('electron')`). Renderer RCE → full Node/OS. The **only** blocker to `sandbox:true` is `clipboard` in the preload. | `main.js:212`, `preload.js:6,145` | Move `readClipboard` to an `ipcMain.handle('clipboard:read')`, confirm `webUtils.getPathForFile` under sandbox, then set `sandbox:true`. |
| Medium | `player.command`/`player.setProperty` use a **denylist** over the large mpv surface — fragile (e.g. `stream-record`, `dump-cache`, `screenshot-to-file`, `external-files`, `sub-files` not blocked). | `preload.js:14-15`, enforced `main.js:948-955` | Convert to an **allowlist** of the ~5 commands / ~15 properties the preload actually uses; keep denylist as defense-in-depth. |
| Low-Med | Broad entitlements: `disable-library-validation` + `allow-dyld-environment-variables` (the latter is **not** in Electron's standard set — a dylib-injection lever). | `build/entitlements.mac.plist:6-19` | Remove `allow-dyld-environment-variables` unless a bundled binary needs `DYLD_*`; ideally sign bundled binaries with the same Team ID and drop `disable-library-validation`. Keep `allow-jit`/`allow-unsigned-executable-memory` (required by V8). |
| Low | Global `uncaughtException`/`unhandledRejection` swallow everything — good against malformed LAN packets, but masks genuine logic bugs. | `main.js:20-21` | Keep the net, but wrap the actual untrusted parsers in tight try/catch and add structured logging so real bugs aren't lost in network noise. |

Reference: [Electron Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) ·
[Jellyfin ffmpeg arg-injection advisory](https://github.com/jellyfin/jellyfin/security/advisories/GHSA-866x-wj5j-2vf4) ·
[Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)

---

## 2. Networking & casting

| Sev | Finding | Location | Fix |
|-----|---------|----------|-----|
| Critical | WebTorrent's own server (which serves a `/webtorrent/` index of **all** torrents + every file by path, no auth) is bound to `0.0.0.0` — readable by any LAN device. | `torrent.js:129` | Bind it to `127.0.0.1`; route all LAN/TV access through the existing token-gated `lanserver.js` proxy (already fronts the localhost webtorrent server). |
| High | `serveDlnaProxy` forwards to an arbitrary `upstreamUrl` with no loopback check — a latent SSRF primitive if any caller ever sets it from network data. | `lanserver.js:234-242` | Assert `u.hostname` is `127.0.0.1`/`localhost` before forwarding. |
| High | Chromecast TLS uses self-signed 48-h device certs with no device-auth challenge → LAN MITM of the cast control channel (accepted protocol risk, ecosystem-wide). | `cast.js:21,190,212` | Can't fix at lib level; document the LAN-trust assumption, pin to the discovered host, reject mid-session host changes. |
| Medium | DLNA control URLs resolved from the device description are **not** re-validated with `isLanUrl` — a malicious description could redirect SOAP POSTs off the validated host. | `dlna.js:97-100` | Re-run `isLanUrl` on resolved `avControl`/`rcControl` before storing. |
| Medium | Network response bodies (DLNA description, eureka, SOAP) accumulated into strings with no size cap → memory-exhaustion DoS from a hostile LAN device. | `dlna.js:61`, `cast.js:151` | Abort + destroy socket past a cap (~1-2 MB). |
| Medium | Torrent `file.path` (from untrusted metadata) trusted without an in-`DL_DIR` containment check. | `torrent.js:64,141,176` | After metadata, `path.resolve` each entry and require `startsWith(DL_DIR + sep)`; refuse absolute/`..` entries. Keep the existing startup/teardown purge. |
| Medium | `/24` eureka sweep of every NIC every 60 s looks like host scanning; no backoff after discovery. | `cast.js:133-147` | Re-probe known hosts frequently, full-sweep rarely once a device is found. |
| Medium | Public-tracker announce list + DHT leak viewing IP/info-hash for every play. | `torrent.js:30-46,93` | Make trackers/DHT opt-in/configurable; honor `private` flag; document privacy impact. |
| Low | `serveHlsFile` guards traversal with a `.includes('..')` string check rather than resolve-and-verify. | `lanserver.js:290-292` | Use `path.resolve(hlsDir,name)` + `startsWith(resolve(hlsDir)+sep)` prefix check. |
| Low | No `requestTimeout`/`headersTimeout` on the `0.0.0.0` LAN media server (slowloris). | `lanserver.js:184-187` | Set both after `createServer`. |

Already done well: 128-bit `crypto.randomBytes(16)` tokens, the `isLanUrl` SSRF guard,
mDNS crash-hardening, regex "parsing" that incidentally avoids XXE, temp-store lifecycle purge.

Reference: [CallStranger CVE-2020-12695](https://www.tenable.com/blog/cve-2020-12695-callstranger-vulnerability-in-universal-plug-and-play-upnp-puts-billions-of) ·
[WebTorrent security](https://mintlify.wiki/webtorrent/webtorrent/advanced/security) ·
[Chromecast device auth](https://tristanpenman.com/blog/posts/2025/03/22/chromecast-device-authentication/) ·
[Node path-traversal prevention](https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/)

---

## 3. Native Objective-C++ addons

| Sev | Finding | Location | Fix |
|-----|---------|----------|-----|
| Critical | TSFN created with `initial_thread_count=1` for the JS thread, but the event-pump thread also issues `NonBlockingCall` without `Acquire()`, and `DetachCore` calls `Release()` from main while the pump may still call in. `Release()` must be the last TSFN op. | `mpv_addon.mm:411,434,619-642` | Pump thread `Acquire()`s at start and `Release()`s as its own final action; don't `Release()` from `DetachCore`; check `NonBlockingCall` for `napi_closing`. |
| Critical | `getNativeWindowHandle()` NSView pointer is cached/retained; Electron doesn't keep it valid across window close/recreate → dangling pointer. The env-cleanup hook fires only at process exit, not per window. | `mpv_addon.mm:282,297`; `airplay_addon.mm:124,149` | Re-fetch & validate the handle on every attach; drive teardown from the window `'closed'` event; never cache across recreation. |
| High | `drawRect`/display-link redraw reads `gRender` while `DetachCore` frees it, with no lock — libmpv forbids overlapping render/free. | `mpv_addon.mm:190-226` vs `633-637`, `247` | Guard `gRender` with a mutex (or stop the display link and remove the view **before** `mpv_render_context_free`). |
| High | AirPlay KVO add/remove unbalanced: `status` observer added to `item` but removed from `gPlayer.currentItem` (nil after replace); `@catch(...)` masks the imbalance. | `airplay_addon.mm:107-108,195-196` | Keep a strong ref to the observed `AVPlayerItem`, remove with the context-pointer variant **before** `replaceCurrentItemWithPlayerItem:nil`; stop swallowing exceptions. |
| High | Many N-API entry points coerce args (`As<String>().Utf8Value()`, `As<Number>()`) with no `Length()`/type check → thrown C++ exceptions on malformed IPC. | `mpv_addon.mm:503,600-603`; `airplay_addon.mm:145-285`; `nowplaying_addon.mm:62-66` | Validate `Length()`/`IsString()`/`IsNumber()`/`IsObject()` up front and throw a clear `TypeError` before side effects. |
| High | `gHasTsfn` is a plain `bool`; airplay/nowplaying re-register the TSFN (`Release()`+reassign) while emitter blocks read it → torn read → call on released TSFN. | `airplay_addon.mm:29,133-135`; `nowplaying_addon.mm:16,32-34` | Make `gHasTsfn` `std::atomic<bool>`; forbid live re-registration or serialize on the main queue. |
| Medium | Re-attach frees `gRender` but defers recreation to `drawRect`'s lazy path → "No render context set" window where video is disabled. | `mpv_addon.mm:288-299` | Make the new GL context current and call `CreateRenderContextCurrent()` immediately in the re-attach block. |
| Medium | `nodeToJson` recurses with no depth cap; `std::to_string(double)` is 6-digit + locale-dependent (can emit `,` decimal → breaks renderer `JSON.parse`). | `mpv_addon.mm:327-347` | Add a depth cap; format doubles with `snprintf("%.17g")` in the C locale. |
| Low | `Command()` silently drops args of unsupported type (changes arity); per-frame 1px `glReadPixels` stalls the GPU pipeline. | `mpv_addon.mm:518-523,213,222` | Reject unknown arg types; gate the readback behind a debug flag. |

Reference: [node-addon-api ThreadSafeFunction](https://github.com/nodejs/node-addon-api/blob/main/doc/threadsafe_function.md) ·
[libmpv render.h threading rules](https://github.com/mpv-player/mpv/blob/master/libmpv/render.h) ·
[Electron getNativeWindowHandle lifetime](https://github.com/electron/electron/issues/7460)

---

## 4. Dependencies & renderer

### Dependencies

| Package | Pinned | Latest (Jun 2026) | Status & action |
|---------|--------|-------------------|-----------------|
| electron (dev) | ^42.4.0 | 42.5.0; 43 in beta | At the edge of the 3-major support window (40 EOLs 2026-06-30). Keep current; plan move to 43/44. |
| node-addon-api (dev) | ^8.8.0 | npm shows **8.7.0** | **`^8.8.0` may not resolve** — verify it exists (`npm view`); correct the pin if not. |
| node-gyp (dev) | ^12.4.0 | **13.0.0** | One major behind — upgrade after testing the native rebuild. |
| castv2-client | ^1.2.0 | 1.2.0 | **Abandoned ~9 yrs.** Highest dependency risk — fork/vendor or migrate; pin exact version meanwhile. |
| dns-txt | ^2.0.2 | 2.0.2 | Abandoned ~10 yrs; trivial — consider inlining. |
| multicast-dns | ^7.2.5 | 7.2.5 | Dormant but de-facto standard — keep, monitor. |
| webtorrent | ^3.0.16 | 3.0.16 | Current & maintained; historical XSS (CVE-2019-15782) doesn't apply to Spritz's main-process usage. Keep. |

_npm registry lookups were proxy-blocked during the audit; re-confirm the two "verify"
items with `npm view` in an unrestricted environment, and run `npm audit` once installed._

### Renderer (`src/renderer/`)

| Sev | Finding | Location | Fix |
|-----|---------|----------|-----|
| Medium | `paintBuffered()` builds HTML via string concat into `innerHTML` — the one `innerHTML` that interpolates runtime (torrent-layer) data. Currently numeric-only (`.toFixed(2)`), so not exploitable today. | `renderer.js:959-963` | Rebuild with `createElement` + numeric `.style.left/.width`; this also clears the path to dropping CSP `unsafe-inline`. |
| Medium | Many user-triggered `await soda.*` IPC calls have **no** `try/catch` → a rejected call silently dead-ends the click (the safe pattern is used elsewhere — applied inconsistently). | `renderer.js:215,559,569,576,716,739,893,904` | Wrap each in `try/catch` + `toast()` on failure. |
| Medium | Icon controls are `<div class="button">`/clickable `<li>` — not keyboard-focusable, no ARIA roles. Modals lack `role="dialog"`/focus trap. | `index.html:50-95`; renderer menus | Use real `<button>`s with `aria-label`; add dialog roles/focus management; make menus keyboard-navigable. |
| Low | Keybindings use deprecated `e.keyCode`. | `renderer.js:370-391` | Migrate to `e.key`/`e.code`. |
| Low | 1,368-line monolithic renderer with shared mutable globals — hard to test. | `renderer.js` | Split into ES modules (dispatch, transports/{mpv,airplay,chromecast,dlna}, playlist, torrent, settings, ui/menus). |

All other `innerHTML` writes are `= ''` clears followed by `createElement`+`textContent`
rebuilds — confirmed XSS-safe. Timer cleanup and async race guards are solid.

Reference: [Electron release timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) ·
[endoflife.date/electron](https://endoflife.date/electron)

---

## Suggested sequencing

1. **Crash/UAF first (native C1–H1, network C1):** these are the only items that can hard-crash
   the app or expose user files — TSFN lifecycle, NSView handle, `gRender` race, and the
   `0.0.0.0` WebTorrent bind.
2. **Cheap high-value Electron hardening:** navigation handlers and the yt-dlp/ffmpeg `--`
   guard are small, self-contained, and close the biggest remaining attack surface.
3. **Robustness & defense-in-depth:** N-API arg validation, body-size caps, loopback assert
   on the DLNA proxy, torrent-path containment, IPC try/catch in the renderer.
4. **Maintenance & polish:** plan off `castv2-client`, verify/bump dev deps, CSP tightening,
   accessibility pass, renderer modularization.
