'use strict';

// Spritz — modern Electron media player, main process (arm64).
// Owns the native libmpv addon (it needs getNativeWindowHandle, which is main-only)
// and bridges it to the renderer over IPC:
//   renderer control input → IPC → main → addon (command/setProperty/loadfile)
//   addon events (TSFN)      → main → IPC('player-event') → renderer

// Cache compiled JS on disk so subsequent launches skip re-parsing/compiling the main process's
// modules (this file is ~1200 lines and pulls in webtorrent, castv2 and friends). Node >=22 only,
// and purely an optimisation — wrapped because a failure here must never stop the app booting.
try { require('module').enableCompileCache?.(); } catch (e) {}

const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, Menu, shell, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const mpvGuard = require('./mpv-guard'); // allow lists for renderer-driven mpv properties/commands
const { presentTargets } = require('./receiver-presentation');
const { runtimeIdentity } = require('./runtime-identity');
const { localMediaPath, readTextCapped, httpUrl } = require('./ipc-validate'); // renderer-supplied values
const { isAllowedNavigation } = require('./nav-guard'); // window navigation policy

// Safety net: the main process continuously parses UNTRUSTED LAN input (mDNS/SSDP/DLNA/cast
// packets). A single malformed packet that throws deep in a 3rd-party parser would otherwise put
// up Electron's "A JavaScript error occurred in the main process" dialog and kill playback. Log
// and keep running instead — a stray network packet must never crash the player. (Real bugs still
// surface in the console.) Handlers are still expected to guard their own hot paths.
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', e && e.stack || e); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e && e.stack || e); } catch (_) {} });

// Packaged builds use only their bundled copies — see bin-path.js.
const { binPath, userBinPath } = require('./bin-path');
const YTDLP = binPath('yt-dlp');
const FFMPEG = binPath('ffmpeg');

// yt-dlp's argv is not a safe place for an unvalidated string: --exec runs a command,
// --config-location loads a config that can carry one, -o writes anywhere. A value starting with
// '-' is an instruction, not a bad URL. The renderer checks for http(s) before asking, but that is
// the wrong side of the trust boundary. Validate here, and pass '--' so nothing after it can be
// read as an option even if this check is ever loosened.
const resolverJobs = new Set();
function cancelResolvers() { for (const cancel of [...resolverJobs]) cancel(); }
function ownResolver(child, callback) {
  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    resolverJobs.delete(cancel);
    try { child.kill('SIGKILL'); } catch (e) {}
  };
  const answer = (...args) => {
    if (finished) return;
    finished = true;
    resolverJobs.delete(cancel);
    callback(...args);
  };
  resolverJobs.add(cancel);
  return { cancel, answer };
}
function resolveStream(pageUrl, cb) {
  const url = httpUrl(pageUrl);
  if (!url) return cb(new Error('Not a playable web address'), null);
  let out = '', err = '';
  const ps = spawn(YTDLP, ['-f', 'best', '--no-playlist', '--get-title', '-g', '--', url], { timeout: 35000 });
  const owned = ownResolver(ps, cb); cb = owned.answer;
  ps.stdout.on('data', (d) => { out += d; });
  ps.stderr.on('data', (d) => { err += d; });
  ps.on('error', (e) => cb(e, null)); // ENOENT = yt-dlp missing
  ps.on('close', () => {
    const lines = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
    const url = lines.find((l) => /^https?:\/\//i.test(l));   // robust to title/url order
    const title = lines.find((l) => !/^https?:\/\//i.test(l));
    if (url) cb(null, { url, title: title || null });
    else cb(new Error((err.split('\n').find((l) => /ERROR/i.test(l)) || 'no playable media found').replace(/^ERROR:\s*/i, '')), null);
  });
  return owned.cancel;
}

// Resolve a progressive H.264 MP4 for the AirPlay path — AVPlayer often can't play
// yt-dlp's default HLS/DASH for sites, but a single combined MP4 (YouTube itag 22/18) works.
function resolveAirplayUrl(pageUrl, cb) {
  const url = httpUrl(pageUrl); // same reasoning as resolveStream
  if (!url) return cb(null);
  let out = '';
  const ps = spawn(YTDLP, ['-f', '22/18/b[ext=mp4][acodec!=none]/b[ext=mp4]', '--no-playlist', '-g', '--', url], { timeout: 35000 });
  const owned = ownResolver(ps, cb); cb = owned.answer;
  ps.stdout.on('data', (d) => { out += d; });
  ps.on('error', () => cb(null));
  ps.on('close', () => cb(out.trim().split('\n').map((s) => s.trim()).find((l) => /^https?:\/\//i.test(l)) || null));
  return owned.cancel;
}

app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mpvAddon = null;
try {
  mpvAddon = require(path.join(__dirname, '..', '..', 'native', 'mpv', 'build', 'Release', 'mpv_render.node'));
} catch (e) {
  console.error('[mpv addon] load failed:', e.message);
}

let apAddon = null; // AirPlay (AVFoundation) — optional; never break mpv if missing
try {
  apAddon = require(path.join(__dirname, '..', '..', 'native', 'airplay', 'build', 'Release', 'airplay.node'));
} catch (e) {
  console.error('[airplay addon] load failed:', e.message);
}

let npAddon = null; // Now Playing / media keys (MediaPlayer) — optional
try {
  npAddon = require(path.join(__dirname, '..', '..', 'native', 'nowplaying', 'build', 'Release', 'nowplaying.node'));
} catch (e) {
  console.error('[nowplaying addon] load failed:', e.message);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let psbId = -1;

  // AirPlay orchestration state
  let castUrl = null;       // current AVFoundation-castable URL (https only — ATS), or null
  let mpvLastUrl = null;    // last URL mpv loaded (to resume local playback after casting)
  let mpvDuration = 0; // last known media duration, for mapping time-pos -> file fraction
  let pickerAttached = false, lastAvTime = 0;
  let apTimeSeen = 0, apExternalActive = false, apLastLoggedTime = 0; // diagnostics: is the AVPlayer actually advancing?
  // An AVPlayer item that failed to load never heals — AVFoundation will not retry it, and every
  // later seek/play on it is silently discarded. Remember that so an engage can rebuild it instead
  // of handing the TV a corpse.
  let avItemFailed = false;
  let castSubs = [];        // sideloaded WebVTT text tracks for the current castUrl (HLS casts)
  let externalSubs = [];    // user-added external .srt/.ass files for the current source (carried into casts)
  let loadGen = 0; // invalidated by source admission and local Stop
  let receiverIntent = 0, pendingReceiverOperation = null;
  let pendingThumbnail = null;
  function retireReceiverIntent() {
    ++receiverIntent;
    const cancel = pendingReceiverOperation;
    pendingReceiverOperation = null;
    if (cancel) cancel();
    return receiverIntent;
  }
  let castResolveRetry = null;
  function invalidateLoad() {
    ++loadGen;
    retireReceiverIntent();
    if (typeof receiverPlan !== 'undefined' && receiverPlan) {
      if (receiverPlan.pendingClockTimer) clearTimeout(receiverPlan.pendingClockTimer);
      if (receiverPlan.retirePrevious) receiverPlan.retirePrevious();
      if (receiverPlan.transport && receiverPlan.transport !== lan) receiverPlan.transport.teardown();
      receiverPlan = null;
    }
    if (pendingThumbnail) pendingThumbnail();
    cancelResolvers();
    if (castResolveRetry) clearTimeout(castResolveRetry);
    castResolveRetry = null;
    return loadGen;
  }
  // Default receiver profile for the PRE-RESOLVED AirPlay URL (the target isn't known until the user
  // picks a route). Conservative video (downscale 4K — a webOS AirPlay-2 receiver may cap at 1080p)
  // but AC3/EAC3 passthrough (AVPlayer/AirPlay-2 handle Dolby). The Chromecast path re-resolves with
  // the actual device's negotiated caps (cast.capsFor) for full 4K HEVC/HDR when supported.
  // AirPlay-2 to a TV reliably plays only H.264 + SDR — HEVC/HDR10 over AirPlay makes the LG enter AirPlay
  // mode but never play the video. So force H.264 SDR (hevc:false, hdr10:false) → videoArgs transcodes a
  // 4K HEVC/HDR source to 1080p H.264 SDR, which AVPlayer/the TV actually decode. (Was hevc/hdr10 true →
  // 1080p HEVC HDR10 output = "enters mode, never plays". Matches the proven pre-session AirPlay behaviour.)
  const AIRPLAY_CAPS = { hevc: false, hevc4k: false, h264_4k: false, hdr10: false, dovi: false, audioCopy: ['aac', 'mp3', 'alac', 'ac3', 'eac3'], maxHeight: 1080 };
  // The ambitious profile, opt-in via SPRITZ_AIRPLAY_4K=1, and deliberately a SEPARATE literal rather
  // than a spread of the one above, so the proven configuration can never drift by accident.
  //
  // "AirPlay is 1080p" turned out to be this project's own rule, not Apple's: AirPlay 2 video (as
  // opposed to screen MIRRORING, which is where the 1080p figure comes from) carries 2160p HEVC, and
  // a 4K HEVC stream COPY costs 46ms of CPU for 8 seconds of video — measured — where the 1080p
  // H.264 transcode above burns ~345%. So the cheap path is the high-quality one.
  //
  // dovi:false is right for this receiver rather than a limitation: the LG reports HDR10/HLG and no
  // Dolby Vision mode, so a profile-8 source is stripped to its HDR10 base layer, which it does show.
  // h264_4k stays false — no evidence for it, and 4K H.264 is outside Apple's HLS envelope.
  const AIRPLAY_CAPS_4K = { hevc: true, hevc4k: true, h264_4k: false, hdr10: true, dovi: false, audioCopy: ['aac', 'mp3', 'alac', 'ac3', 'eac3'], maxHeight: 2160 };
  // Off unless explicitly launched with it, so a double-click is always the proven 1080p path.
  const AIRPLAY_4K = process.env.SPRITZ_AIRPLAY_4K === '1';
  // Isolation knob for one specific unknown. The receiver's /info plist advertises its video
  // capabilities in detail (3840x2160, maxFPS 60, SDR/HDR/HDR10/HLG all at 4k60) and says NOTHING
  // about audio, so whether its AirPlay receiver decodes E-AC-3 cannot be established except by
  // trying. SPRITZ_AIRPLAY_AAC=1 drops Dolby from the copy list, so a 5.1 E-AC-3 track is encoded to
  // AAC with its channel layout preserved (audioArgs never force-downmixes) — one variable, changed
  // alone, which is the only way "Cannot Decode" gets attributed rather than guessed at.
  const AIRPLAY_AAC = process.env.SPRITZ_AIRPLAY_AAC === '1';
  const airplayCaps = (base) => AIRPLAY_AAC
    ? Object.assign({}, base, { audioCopy: base.audioCopy.filter((c) => c !== 'ac3' && c !== 'eac3') })
    : base;
  const mpvPos = () => { try { return (mpvAddon.playerStat().timePos) || 0; } catch (e) { return 0; } };
  const mpvDur = () => { try { return (mpvAddon.playerStat().duration) || 0; } catch (e) { return 0; } };

  // ---- single cast-engine state machine (replaces the casting/chromecasting/dlnacasting booleans) ----
  // One authoritative value so two engines can never co-target the TV. 'pending' is set SYNCHRONOUSLY
  // at the point of user intent (before the multi-second resolve) — that's what closes the races the
  // three independent, post-resolve booleans left open. (Audit M4.)
  let castEngine = 'mpv'; // 'mpv' | 'pending' | 'airplay' | 'chromecast' | 'dlna'
  // Every engine change goes through setEngine(). The transitions used to be 16 bare assignments
  // scattered across the file, and the bugs in this area were all state bugs wearing a networking
  // costume: playback resuming locally while a TV was still playing, two engines briefly live at
  // once, a superseded handoff writing state after a newer one had won.
  //
  // This DELIBERATELY does not enforce. An illegal transition is recorded and still performed, so
  // instrumentation can never itself break playback — the point is to make the bug class visible
  // (in the Ctrl+D overlay) before changing behaviour that currently works.
  const ENGINE_OK = {
    mpv:        ['mpv', 'pending', 'airplay', 'chromecast', 'dlna'], // local → start a handoff
    pending:    ['mpv', 'pending', 'airplay', 'chromecast', 'dlna'], // resolving → settled or aborted
    airplay:    ['mpv', 'airplay'],      // a cast may only end by returning to local…
    chromecast: ['mpv', 'chromecast'],   // …never by jumping straight to another engine, which
    dlna:       ['mpv', 'dlna']          // is what "playing on two things at once" looks like
  };
  const engineLog = []; // recent transitions, newest last — surfaced in diagnostics
  function setEngine(next, reason) {
    const prev = castEngine;
    if (prev === next) return;
    if (!(ENGINE_OK[prev] || []).includes(next)) {
      recordErr('cast-state', 'illegal transition ' + prev + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
    }
    engineLog.push({ t: Date.now(), from: prev, to: next, reason: reason || '' });
    if (engineLog.length > 12) engineLog.shift();
    castEngine = next;
    // Chromecast and DLNA do not use the AirPlay HLS remux, but it keeps running through their
    // casts — burning a third of the CPU and pulling the same torrent from the front of the file
    // while the cast reads from the middle, at equal priority. Suspend it for the duration and let
    // it go again on the way back. Done here because every route change passes through this
    // function, so no path can forget.
    try {
      if (next === 'chromecast' || next === 'dlna') lan.suspendAirplayPrep();
      else if (next === 'mpv' || next === 'airplay') lan.resumeAirplayPrep();
    } catch (e) {}
    // Suspending the remux stalls whatever AVPlayer item is bound to it, and AVFoundation fails that
    // item for good — measured mid-cast as -11866 "Playback Stopped" with engine=chromecast. A failed
    // item cannot be engaged at all: the route picker has no live player to hand the TV, so the OS
    // never sends an 'external' event and the repair on engage never gets a chance to run. That is
    // why AirPlay after a Chromecast cast looked completely inert — a whole session logged not one
    // ENGAGED line. Rebuild it here, on the way back to local, once the resumed remux has had a
    // moment to write again. prepare() only — never serveHls, which deletes the directory the item
    // is pointing at and is the already-paid-for "Could not connect" regression.
    if (next === 'mpv' && avItemFailed && castUrl) {
      setTimeout(() => {
        if (!avItemFailed || !castUrl || castEngine !== 'mpv' || !apAddon || !pickerAttached) return;
        avItemFailed = false;
        console.log('[airplay] rebuilding the AVPlayer item that a cast killed');
        try { apAddon.prepare(castUrl, mpvPos()); } catch (e) { console.error('[airplay] rebuild err', e.message); }
      }, 2000);
    }
  }
  // Stop mpv and give the prepared AVPlayer the playhead. Extracted because there are TWO ways into
  // it, and only one of them used to exist.
  function handOffToAirplay(why) {
    console.log('[airplay] handing off to AirPlay (' + why + ')');
    setEngine('airplay');
    const pos = mpvPos();
    captureTracks();                        // remember language/subtitle for the return
    try { mpvAddon.command('stop'); } catch (e) {}
    try { apAddon.seek(pos); apAddon.play(); } catch (e) {}
  }
  // The second file of a session never played to the TV, and this is why: the route from the FIRST
  // file is still held, so macOS emits no new 'external' event — there is no transition to observe.
  // 'route ENGAGED' only ever logs on that edge, so the handoff never ran and the app sat in
  // engine=mpv while externalActive was still true. Observed exactly that: "time 6.0s engine=mpv
  // externalActive=true". So when a fresh castUrl is prepared and the route is ALREADY engaged,
  // hand off directly instead of waiting for an event that cannot arrive.
  function adoptAlreadyEngagedRoute() {
    if (!apAddon || !pickerAttached || !castUrl) return;
    if (!apExternalActive || castEngine === 'airplay') return;
    if (castEngine === 'chromecast' || castEngine === 'dlna' || castEngine === 'pending') return;
    handOffToAirplay('the route was already engaged from a previous file');
  }
  const isCasting = () => castEngine === 'airplay' || castEngine === 'chromecast' || castEngine === 'dlna';
  // Tear down whatever is currently casting, then enter 'pending' for the new kind. Called at intent,
  // synchronously, so a concurrent AirPlay-engage / other cast sees "busy" and backs off.
  function beginCast() {
    if (castEngine === 'airplay') { try { if (apAddon) apAddon.stopAirplay(); } catch (e) {} }
    else if (castEngine === 'chromecast') { try { cast.stop(); } catch (e) {} }
    else if (castEngine === 'dlna') { try { dlna.stop(); } catch (e) {} stopDlnaPoll(); }
    castMkv = null;
    setEngine('pending');
  }

  function setCastable(url, subs) {
    url = url || null;
    castSubs = Array.isArray(subs) ? subs : [];
    const changed = url !== castUrl;
    castUrl = url;
    // prepare only on change AND while purely local (re-preparing tears down a live casting player)
    console.log('[airplay] setCastable ->', castUrl ? String(castUrl).slice(0, 90) : 'NULL', '| pickerAttached=' + pickerAttached + ' engine=' + castEngine + ' changed=' + changed);
    try {
      if (apAddon && pickerAttached && castUrl && changed && castEngine === 'mpv') {
        avItemFailed = false;
        apAddon.prepare(castUrl, mpvPos()); console.log('[airplay] prepared AVPlayer with', String(castUrl).slice(0, 70));
        // Give the new item a moment to load before driving it, then take over a route that is still
        // engaged from the previous file.
        setTimeout(adoptAlreadyEngagedRoute, 1200);
      }
    } catch (e) { console.error('[airplay] prepare err', e.message); }
    send('airplay-event', { type: 'castable', castable: !!castUrl });
  }
  function resumeLocalFromAirplay(skipRearm) {
    setEngine('mpv');
    if (mpvLastUrl) { try { mpvAddon.command('loadfile', mpvLastUrl, 'replace', '-1', loadOpts(lastAvTime, true)); } catch (e) {} }
    // Re-arm for the next cast on a clean route-drop — but NOT after a playback error, where
    // castUrl is the thing that just failed (re-arming would set up an identical instant failure).
    if (!skipRearm) { try { if (apAddon && castUrl) apAddon.prepare(castUrl, lastAvTime); } catch (e) {} }
  }
  // A cast intent failed (same source still loaded). Return to local: if we'd torn down a PREVIOUS cast
  // (wasCasting → mpv was stopped), reload it locally so the screen isn't left black; if mpv was still
  // playing (came straight from local), leave it. castUrl/AVPlayer are untouched (the failed cast used a
  // separate Chromecast/DLNA slot, never the AirPlay HLS slot), so AirPlay stays armed — surface the error.
  function castFailedLocal(wasCasting, evChannel, msg) {
    setEngine('mpv');
    if (wasCasting && mpvLastUrl) { try { mpvAddon.command('loadfile', mpvLastUrl, 'replace', '-1', loadOpts(lastAvTime, true)); } catch (e) {} }
    if (evChannel && msg) send(evChannel, { type: 'error', message: msg });
  }
  // Debounced cast-drop: an inactive/error event during the (slow, flickery) webOS AirPlay-2
  // handshake must NOT instantly tear the cast down. Resume local only if the drop persists.
  let dropTimer = null;
  function cancelDrop() { if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; } }
  function scheduleDrop(skipRearm, errMsg) {
    if (dropTimer) clearTimeout(dropTimer);
    dropTimer = setTimeout(() => {
      dropTimer = null;
      if (castEngine !== 'airplay') return;
      resumeLocalFromAirplay(skipRearm);
      // tell the renderer to exit the cast UI: an error toast, or a synthetic route-drop.
      send('airplay-event', errMsg ? { type: 'error', message: errMsg } : { type: 'external', active: false });
    }, 5000);
  }

  // ---- "open with Spritz" / magnet handler ----
  // A source (file path or magnet/URL) opened via Finder, the dock, a magnet link, or
  // the CLI is funneled to the renderer's routeSource. Opens that arrive before the
  // renderer is ready are queued and flushed on first request.
  let pendingOpen = null, rendererReady = false;
  app.setAsDefaultProtocolClient('magnet');
  app.setAsDefaultProtocolClient('spritz');
  function openSource(src) {
    if (!src) return;
    if (rendererReady) send('open-source', { src });
    else pendingOpen = src;
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  }
  const isOpenable = (a) => a && (/^(magnet:|spritz:|https?:)/i.test(a) || /\.(mp4|mkv|webm|mov|avi|m4v|flv|ts|wmv|mpg|mpeg|m3u8|m3u|pls|torrent)$/i.test(a));
  const fromArgv = (argv) => (argv || []).find(isOpenable);
  app.on('open-file', (e, p) => { e.preventDefault(); openSource(p); });   // macOS Finder/dock file
  app.on('open-url', (e, url) => { e.preventDefault(); openSource(url); }); // macOS magnet:/spritz:
  ipcMain.on('renderer:ready', () => { rendererReady = true; if (pendingOpen) { send('open-source', { src: pendingOpen }); pendingOpen = null; } });

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    const a = fromArgv(argv.slice(1)); if (a) openSource(a); // a 2nd launch carrying a file/magnet
  });

  function createMainWindow() {
    // Open where and how big the window was last time (clamped to the displays that exist now).
    const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
    const windowState = require('./window-state');
    const restored = windowState.restore(windowState.load(windowStateFile), screen.getAllDisplays(), { width: 950, height: 560 });
    mainWindow = new BrowserWindow({
      ...restored,
      minWidth: 520,
      minHeight: 400,
      // Transparent so the native libmpv layer (below the web contents) shows
      // through where the DOM is transparent. frame:true on purpose (frameless +
      // transparent + resizable hits Electron regression #49173).
      transparent: true,
      frame: true,
      backgroundColor: '#00000000',
      fullscreenable: true,
      show: false,
      title: 'Spritz',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed: the preload only bridges IPC (see the clipboard handler below for the one thing it
        // used to do itself). A renderer compromise then has no Node and almost no Electron to work with.
        sandbox: true,
        // Left false so the renderer starts un-throttled; setBackgroundThrottling() below narrows
        // it to only while something is actually playing.
        backgroundThrottling: false
      }
    });

    // Remember size and position: debounced while the person drags or resizes, and once more on close. The
    // restored (normal) bounds are saved even in fullscreen, and the mini-player's tiny window is skipped.
    let windowStateTimer = null;
    const rememberWindow = () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const b = mainWindow.getNormalBounds();
        if (b.width >= windowState.MIN_W && b.height >= windowState.MIN_H) windowState.save(windowStateFile, b);
      } catch (e) { /* never let bookkeeping disturb playback */ }
    };
    const rememberSoon = () => { clearTimeout(windowStateTimer); windowStateTimer = setTimeout(rememberWindow, 400); };
    mainWindow.on('resize', rememberSoon);
    mainWindow.on('move', rememberSoon);
    mainWindow.on('close', () => { clearTimeout(windowStateTimer); rememberWindow(); });

    const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

    // Navigation policy. Installed BEFORE loadFile so it covers the first load too.
    //
    // window.soda is granted to whatever document occupies this window, not to the document we
    // shipped — mpv control, torrent add, cast load and local file reads all come with it. Without
    // these, anything that can talk the renderer into navigating inherits the lot. The app never
    // navigates (no window.open, no _blank, no <a href>, no <webview>, one loadFile at startup),
    // so refusing everything else costs nothing.
    const wc = mainWindow.webContents;
    wc.on('will-navigate', (e, url) => {
      if (!isAllowedNavigation(url, INDEX_HTML)) {
        e.preventDefault();
        console.warn('[nav] blocked navigation to', String(url).slice(0, 120));
      }
    });
    // Covers window.open and target=_blank. 'deny' rather than opening in the default browser:
    // the URL would be renderer-controlled, and handing an attacker-chosen URL to the OS is the
    // same problem wearing a different hat.
    wc.setWindowOpenHandler(({ url }) => {
      console.warn('[nav] blocked window.open to', String(url).slice(0, 120));
      return { action: 'deny' };
    });
    // No <webview> is used; one appearing means the page is not ours.
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // Spritz needs no web permissions — it plays video through a native mpv surface, not
    // getUserMedia, and has no use for geolocation, notifications, MIDI or clipboard-read.
    wc.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    wc.session.setPermissionCheckHandler(() => false);

    // The preload can admit a CLI/open-file source before ready-to-show. Start the
    // native core first: otherwise its loadfile command is silently discarded.
    attachPlayer();
    mainWindow.loadFile(INDEX_HTML);
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });

    // OS fullscreen → renderer (KEEP these channel names; the renderer swaps the
    // fullscreen icon + re-arms control auto-hide on them).
    mainWindow.on('enter-full-screen', () => send('enter-full-screen'));
    mainWindow.on('leave-full-screen', () => send('leave-full-screen'));

    mainWindow.on('closed', () => {
      try { if (mpvAddon && mpvAddon.detach) mpvAddon.detach(); } catch (e) {}
      try { torrent.teardown(); } catch (e) {}
      try { if (receivers) receivers.stop(); } catch (e) {}
      try { lan.teardown(); } catch (e) {}
      try { cast.teardown(); } catch (e) {}
      try { dlna.teardown(); } catch (e) {}
      mainWindow = null;
    });
  }

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }

  // Torrent/magnet streaming (webtorrent in main). Produces a localhost URL the
  // renderer feeds to the normal player-load path.
  // Tee torrent progress/errors into the diagnostics snapshot on the way to the renderer.
  const torrentSend = (channel, payload) => {
    try {
      if (channel === 'torrent:progress' && payload) {
        diagTorrent = { peers: payload.peers, speed: payload.speed, progress: payload.progress };
        torrentPreparationSample = { generation: loadGen, source: mpvLastUrl, at: Date.now(), health: payload.health };
      } else if (channel === 'torrent:error' && payload) recordErr('torrent', payload.message);
    } catch (e) {}
    send(channel, payload);
  };
  const torrent = require('./torrent')(torrentSend);
  const createReceiverService = require('./receiver-service');
  let receivers = null;   // the Spritz Receiver service; created once lanserver exists
  const lan = require('./lanserver')({
    onWarn: (m) => send('toast', { message: m }),
    // Pausing a cast kills it. The stream is a live pipe, so a paused receiver stops reading, the
    // socket fills, and about thirty seconds later the TV drops the connection — measured:
    // "PLAYING -> PAUSED at 3480s" then "ENDED by the receiver closing the connection" 33s later,
    // after which nothing was feeding the TV and pressing play did nothing. The cast was never over;
    // it just had no supply. Put one back.
    onCastStreamLost: (why) => recoverCast(why),
    // The AirPlay HLS session was destroyed (source change, teardown, watchdog). Whatever castUrl we
    // handed out points into a directory that no longer exists, so stop claiming it is castable —
    // otherwise the next engage prepares an AVPlayer against a 404 and fails with CoreMedia -16839.
    // Saying "not castable" is honest and the !castUrl gate already keeps mpv playing locally.
    onAirplayHlsGone: () => { if (castUrl && /\/hls\//.test(castUrl)) setCastable(null); },
    // A receiver seeking inside a still-downloading torrent. The DLNA proxy calls this the moment a
    // ranged GET arrives and does not wait for it; all it does is move the torrent's urgency to
    // where the viewer just jumped. Opt-in — see dlna-flags.js.
    onSeekBytes: (byteStart) => { try { torrent.ensureBytes(byteStart, () => {}); } catch (e) {} },
    // A source read observed at the proxy. Forwarded as a fact; torrent.js decides what it means.
    onSourceRead: (o) => { try { torrent.noteSourceRead(o); } catch (e) {} },
    // A packaging run started or ended. The one caller of setProducerActive; see transport-epoch.js.
    onProducerActive: (a) => { try { torrent.setProducerActive(a); } catch (e) {} }
  }); // LAN file server for local-file AirPlay
  const cast = require('./cast')();     // Google Cast (Chromecast / LG webOS)
  const dlna = require('./dlna')();     // DLNA / UPnP "play to"

  // ---- diagnostics ----
  // Spritz does a lot the user cannot see: a /24 discovery sweep, a LAN HTTP server, tracker
  // traffic, ffmpeg transcodes. When any of it fails the UI historically said nothing, so a
  // discovery failure was indistinguishable from a sleeping TV, a filtered network, or macOS
  // silently denying local-network access. Keep a small live snapshot plus the recent errors that
  // the catch-blocks would otherwise swallow, and let the debug overlay show it.
  const diagErrors = []; // ring buffer, newest last
  function recordErr(where, message) {
    if (!message) return;
    diagErrors.push({ t: Date.now(), where, message: String(message).slice(0, 200),
      sourceGeneration: loadGen, receiverIntent });
    if (diagErrors.length > 25) diagErrors.shift();
  }
  let diagCast = [], diagDlna = [], diagTorrent = null, torrentPreparationSample = null;
  function diagSnapshot() {
    let lanAddr = null, lanPort = null;
    try { lanAddr = lan.lanAddress(); } catch (e) {}
    try { lanPort = lan.serverPort ? lan.serverPort() : null; } catch (e) {}
    return {
      engine: castEngine,
      runtime: runtimeIdentity(app),
      playbackOwner: {
        sourceGeneration: loadGen,
        receiverIntent,
        pendingReceiver: pendingReceiverOperation ? pendingReceiverOperation.receiverId : null,
        receiver: receiverPlan ? {
          receiverId: receiverPlan.receiverId, mediaId: receiverPlan.mediaId,
          epoch: receiverPlan.epoch || null, autoplay: receiverPlan.autoplay !== false
        } : null
      },
      lan: { address: lanAddr, port: lanPort },
      cast: { count: diagCast.length, names: diagCast.map((d) => d.name).slice(0, 6) },
      dlna: { count: diagDlna.length, names: diagDlna.map((d) => d.name).slice(0, 6) },
      torrent: diagTorrent,
      source: mpvLastUrl ? String(mpvLastUrl).slice(0, 120) : null,
      engineLog: engineLog.slice(-4).reverse(),
      errors: diagErrors.slice(-8).reverse()
    };
  }
  ipcMain.handle('diag:get', () => { try { return diagSnapshot(); } catch (e) { return null; } });
  const { trustPosition, effectiveState } = require('./resume-point'); // which receiver clocks are worth believing
  const { playheadUpdate } = require('./receiver-playhead'); // aiming the torrent window at the RECEIVER's position
  const history = require('./history')(); // resume positions / recents
  const deviceMemory = require('./device-memory-store')(); // what each receiver has been seen to play
  // The receiver's own opinion, which the app records nowhere. Until now the only trace of what the
  // TV thought was whether a resume marker survived — evidence destroyed by the very failure being
  // diagnosed. Appends to the same file lanserver writes, so the stream's life and the receiver's
  // view of it read as one timeline.
  const CASTLOG = '/tmp/spritz-cast.log';
  const castLog = (m) => { if (!process.env.SPRITZ_DEBUG) return; try { fs.appendFileSync(CASTLOG, '[' + new Date().toISOString().slice(11, 23) + '] ' + m + '\n'); } catch (e) {} };
  let lastPlayerState = null;
  // An observation waiting on proof. Set when a cast starts, converted to a recorded success only
  // once the receiver has demonstrably decoded and advanced through the stream — see castStatus.
  let pendingObservation = null;
  // The receiver's last position while it was genuinely showing the film. Distinct from lastAvTime,
  // which is shared with the local/AirPlay resume clock; this one is never written by a transitional
  // zero, so a recast always has somewhere honest to resume from.
  let lastCastPos = 0;
  // A live cast whose stream dies is not over — the receiver simply stops being fed. Bounded so a
  // genuinely broken source cannot loop.
  const castRecovery = require('./cast-recovery'); // rate-limited, not a lifetime cap — see the module
  let castRecoveries = castRecovery.fresh();

  // ---- DLNA / UPnP casting (parallel to Chromecast) ----
  let dlnaPoll = null;
  dlna.on('devices', (devices) => { diagDlna = devices || []; send('dlna-event', { type: 'devices', devices }); });
  dlna.on('error', (e) => { recordErr('dlna', e.message); send('dlna-event', { type: 'error', message: e.message }); });
  function stopDlnaPoll() { if (dlnaPoll) { clearInterval(dlnaPoll); dlnaPoll = null; } }
  // Poll GetPositionInfo + GetTransportInfo so the remote scrubber advances and a stop-on-TV
  // returns control to local playback (DLNA has no push events).
  function startDlnaPoll() {
    stopDlnaPoll();
    // Don't treat the TV's transport state as "user stopped playback" until we've FIRST seen it actually
    // start. Many webOS firmwares briefly report STOPPED / NO_MEDIA_PRESENT in the second or two right
    // after Play while the item loads — resuming local mpv during that window makes the file play on BOTH
    // the TV and the computer (the double-playback bug). Only resume after a real PLAYING→STOPPED.
    let sawPlaying = false;
    dlnaPoll = setInterval(() => {
      try {
        dlna.position((p) => {
          if (!p || castEngine !== 'dlna') return;
          lastAvTime = p.cur || lastAvTime;
          // The LG reading a still-downloading torrent through the DLNA proxy is exactly the case
          // the critical window exists for, and it was the one case never wired to it. RelTime is a
          // position in the ORIGINAL file (the proxy serves it untouched), so it maps to the same
          // fraction mpv's time-pos does.
          const ph = playheadUpdate({ source: mpvLastUrl, cur: p.cur, dur: p.dur });
          if (ph) { try { torrent.setPlayhead(ph.frac, ph.durationSec); } catch (e) {} }
          send('dlna-event', { type: 'status', cur: p.cur, dur: p.dur });
        });
        dlna.transportState((s) => {
          if (!s || castEngine !== 'dlna') return;
          if (s !== 'STOPPED' && s !== 'NO_MEDIA_PRESENT') sawPlaying = true; // PLAYING / TRANSITIONING / PAUSED_PLAYBACK
          else if (s === 'STOPPED' && sawPlaying) { resumeLocalFromDlna(); send('dlna-event', { type: 'stopped' }); }
        });
      } catch (e) {}
    }, 1000);
  }
  function resumeLocalFromDlna() {
    setEngine('mpv'); stopDlnaPoll();
    try { dlna.stop(); } catch (e) {}
    if (mpvLastUrl) { try { mpvAddon.command('loadfile', mpvLastUrl, 'replace', '-1', loadOpts(lastAvTime, true)); } catch (e) {} }
    // NO rearmAirplay: DLNA serves the original file via its own slot and never touched the AirPlay
    // HLS slot, so castUrl/AVPlayer are still validly bound to the live pre-resolved HLS. Re-resolving
    // would cancelHls() that live slot and rebuild async, leaving a window where engaging AirPlay 404s.
  }
  // ---- Spritz Receiver -------------------------------------------------------------------------
  //
  // The renderer deals in receiver IDS and user actions. It never sees a credential, never sees a
  // pairing code, and cannot bypass the hub's authority gates — UI visibility is not access control,
  // so every one of these is a request to the main process, which remains the only holder of trust.
  // The clipboard, for the URL box's magnet/link auto-paste. Text only; the renderer is sandboxed and cannot read it itself.
  ipcMain.on('clipboard:readText', (e) => {
    try { const t = clipboard.readText(); e.returnValue = typeof t === 'string' ? t.slice(0, 8192) : ''; }
    catch (err) { e.returnValue = ''; }
  });
  ipcMain.handle('receiver:list', () => { try { return presentTargets(startReceivers().targets(), receiverTimelineTransport().vodLogical, receiverTimelineTransport().vodSourceDuration); } catch (e) { return []; } });
  // The Mac's own LAN address, shown in Devices so a person can type it on a TV that cannot find Spritz.
  ipcMain.handle('receiver:macAddress', () => { try { return lan.lanAddress() || null; } catch (e) { return null; } });
  // Show the bundled Spritz Receiver installer (.ipk) in Finder, for someone setting up a TV.
  ipcMain.handle('receiver:revealInstaller', () => {
    try {
      const file = require('./receiver-installer').findInstaller({ resourcesPath: process.resourcesPath, root: path.join(__dirname, '..', '..') });
      if (!file) return { ok: false, why: 'The receiver installer is not included in this build.' };
      shell.showItemInFolder(file);
      return { ok: true, name: path.basename(file) };
    } catch (e) { return { ok: false, why: e.message || 'Could not show the installer.' }; }
  });
  ipcMain.handle('receiver:pending', () => { try { return startReceivers().pending(); } catch (e) { return []; } });
  // The code is typed by a human who is reading it off the television. It is not a secret and it
  // authenticates nothing — see receiver-registry — but it is single-use, short-lived and
  // rate-limited, so a wrong one is answered plainly rather than retried silently.
  ipcMain.handle('receiver:pair', (_e, { code } = {}) => {
    try { const r = startReceivers().confirmPairing(String(code || '')); return { ok: !!r.ok, why: r.why || null }; }
    catch (e) { return { ok: false, why: e.message }; }
  });
  ipcMain.handle('receiver:forget', (_e, { receiverId } = {}) => {
    try {
      const id = String(receiverId || '');
      retireReceiverRequest(id);
      const r = startReceivers().revoke(id); return { ok: !!r.ok, why: r.why || null };
    }
    catch (e) { return { ok: false, why: e.message }; }
  });
  ipcMain.handle('receiver:play', (_e, { receiverId } = {}) => {
    try { return playToReceiver(String(receiverId || '')); } catch (e) { return { ok: false, why: e.message }; }
  });
  ipcMain.handle('receiver:command', (_e, { receiverId, command, arg } = {}) => {
    try {
      if (String(command) === 'select-track' && arg && arg.kind === 'audio' && String(arg.trackId).startsWith('source-audio-')) return switchReceiverAudio(String(receiverId || ''), arg);
      if (String(command) === 'seek') return seekReceiver(String(receiverId || ''), arg);
      if (String(command) === 'stop') {
        retireReceiverRequest(String(receiverId || ''));
        applyStreamCache(mpvLastUrl);
      }
      if ((command === 'play' || command === 'pause') && pendingReceiverOperation &&
          pendingReceiverOperation.receiverId === String(receiverId || '')) {
        pendingReceiverOperation.autoplay = command === 'play';
      }
      if ((command === 'play' || command === 'pause') && receiverPlan &&
          receiverPlan.receiverId === String(receiverId || '')) receiverPlan.autoplay = command === 'play';
      return startReceivers().command(String(receiverId || ''), String(command || ''), arg);
    } catch (e) { return { ok: false, why: e.message }; }
  });

  ipcMain.on('dlna:discover', () => { try { dlna.startDiscovery(); } catch (e) {} });
  ipcMain.on('dlna:load', (_e, { location } = {}) => {
    if (!location) { send('dlna-event', { type: 'error', message: 'No DLNA device selected.' }); return; }
    // DLNA renderers (LG/Samsung/Sony webOS etc.) play direct seekable files, NOT HLS. For a local
    // file we serve the ORIGINAL untouched (no remux) — the LG decodes 4K HEVC/HDR MKV natively.
    const gen = loadGen;
    const wasCasting = isCasting(); // coming from another cast → mpv is already stopped (resume on failure)
    captureTracks(); // capture language/subtitle from mpv while it may still be live (no-op if already casting)
    // Capture the media's byte size + duration NOW (before teardown) so the DIDL <res> can advertise them
    // (helps strict webOS recognize the item — DL1). Size: stat the local file if this is one. Duration:
    // read mpv while it's still live (only when we weren't already casting). Both omitted (0) when unknown.
    const localPath = dlnaLocalPath(mpvLastUrl);
    const mediaSize = localPath ? safeFileSize(localPath) : 0;
    const mediaDur = !wasCasting ? mpvDur() : 0;
    beginCast();     // synchronously claim the engine ('pending') + tear down any current cast (Audit M4)
    resolveDlna(mpvLastUrl, (durl) => {
      if (gen !== loadGen) { setEngine('mpv'); return; } // source changed mid-resolve (player:load handles mpv)
      if (!durl) return castFailedLocal(wasCasting, 'dlna-event', 'This source can’t be cast to a DLNA TV (a still-downloading torrent isn’t a complete file DLNA can play — try AirPlay).');
      // Advertise any user-added external subtitle as a sidecar the TV loads (SRT; ASS/VTT converted).
      // Embedded subs need nothing — the LG reads them from the untouched original file itself.
      const go = (subUrl) => {
        if (gen !== loadGen) { setEngine('mpv'); return; }
        try { mpvAddon.command('stop'); } catch (e) {}
        setEngine('dlna');
        dlna.load(location, { url: durl, title: lastCastTitle, contentType: dlnaContentType(durl), subtitleUrl: subUrl, size: mediaSize, duration: mediaDur }, (err) => {
          if (gen !== loadGen) { try { dlna.stop(); } catch (e) {} setEngine('mpv'); return; } // superseded during load
          if (err) { resumeLocalFromDlna(); send('dlna-event', { type: 'error', message: err.message }); }
          else { send('dlna-event', { type: 'started', location, withSub: !!subUrl }); startDlnaPoll(); }
        });
      };
      const sub = externalSubs[0];
      if (sub && sub.path) lan.serveSubtitleForDlna(sub.path, (u) => go(u || null));
      else go(null);
    });
  });
  // The on-disk path of a LOCAL source (file:// or bare /path), or null for a torrent-proxy / remote URL
  // (whose size we can't cheaply stat). Used to advertise <res size=…> in the DLNA DIDL.
  function dlnaLocalPath(url) {
    const s = String(url || '');
    if (/^https?:\/\//i.test(s)) return null; // torrent proxy or remote stream
    const p = decodeURIComponent(s.replace(/^file:\/\//, ''));
    return /^\//.test(p) ? p : null;
  }
  const safeFileSize = (p) => { try { return fs.statSync(p).size || 0; } catch (e) { return 0; } };
  // MIME for the DIDL protocolInfo — derived from the served file's extension so the LG knows the
  // container (e.g. video/x-matroska for MKV). Defaults to video/mp4.
  function dlnaContentType(url) {
    const ext = (String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1];
    return ({ mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t',
      m2ts: 'video/mp2t', mov: 'video/quicktime', m4v: 'video/x-m4v', wmv: 'video/x-ms-wmv',
      flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', ogv: 'video/ogg' }[(ext || '').toLowerCase()]) || 'video/mp4';
  }
  ipcMain.on('dlna:play', () => { try { dlna.play(); } catch (e) {} });
  ipcMain.on('dlna:pause', () => { try { dlna.pause(); } catch (e) {} });
  ipcMain.on('dlna:seek', (_e, { t } = {}) => { try { dlna.seek(t); } catch (e) {} });
  ipcMain.on('dlna:setVolume', (_e, { f } = {}) => { try { dlna.setVolume(f); } catch (e) {} });
  ipcMain.on('dlna:stop', () => { resumeLocalFromDlna(); send('dlna-event', { type: 'stopped' }); });

  // ---- Now Playing / media keys ----
  if (npAddon && npAddon.setEventListener) {
    try { npAddon.setEventListener((ev) => send('media-command', ev)); } catch (e) { console.error('[nowplaying]', e.message); }
  }
  ipcMain.on('nowplaying:update', (_e, info = {}) => { try { if (npAddon) npAddon.setInfo(info); } catch (e) {} });
  ipcMain.on('nowplaying:clear', () => { try { if (npAddon) npAddon.clear(); } catch (e) {} });

  // ---- Whisper auto-subtitles ----
  // Extract 16kHz mono audio (whisper.cpp's required format) then transcribe to an .srt
  // and hand it back for sub-add. Binary/model are discovered or overridable via env.
  function whisperBin() {
    if (process.env.WHISPER_BIN) return process.env.WHISPER_BIN;
    // user-installed, never bundled — so the system lookup applies even when packaged
    for (const n of ['whisper-cli', 'whisper-cpp']) { const p = userBinPath(n); if (p !== n) return p; }
    return null;
  }
  function whisperModel() {
    const m = process.env.WHISPER_MODEL || path.join(app.getPath('userData'), 'models', 'ggml-base.en.bin');
    return fs.existsSync(m) ? m : null;
  }
  ipcMain.handle('subtitle:generate', async (_e, { src } = {}) => {
    const bin = whisperBin(), model = whisperModel();
    const file = localMediaPath(src); // same reasoning as thumb:at — this feeds ffmpeg -i
    if (!file) return { ok: false, error: 'No media loaded' };
    if (!bin) return { ok: false, error: 'Whisper not found — install with: brew install whisper-cpp' };
    if (!model) return { ok: false, error: 'No Whisper model — put ggml-base.en.bin in app models folder' };
    const base = path.join(app.getPath('temp'), 'spritz-whisper-' + Date.now());
    const wav = base + '.wav';
    try {
      send('toast', { message: 'Extracting audio for subtitles…' });
      await run(FFMPEG, ['-y', '-i', file, '-ar', '16000', '-ac', '1', '-f', 'wav', wav], 300000); // 5 min
      send('toast', { message: 'Transcribing with Whisper…' });
      await run(bin, ['-m', model, '-f', wav, '-osrt', '-of', base], 1800000); // 30 min cap
      try { fs.unlinkSync(wav); } catch (e) {}
      if (fs.existsSync(base + '.srt')) { send('toast', { message: 'Subtitles ready ✓' }); return { ok: true, srt: base + '.srt' }; }
      return { ok: false, error: 'No subtitles produced' };
    } catch (e) { try { fs.unlinkSync(wav); } catch (_) {} return { ok: false, error: e.message }; }
  });
  // BOTH pipes have to be drained, not just stderr. A child that writes past the 64 KiB pipe buffer
  // into a stream nobody reads blocks on that write forever, and the only symptom is the timeout
  // firing much later with a misleading message. whisper-cli prints the transcript to STDOUT —
  // measured at roughly 28 bytes per second of audio, with stderr carrying only its few KB of model
  // info — so a feature-length film deadlocked somewhere past the half-hour mark while a short test
  // clip, well under 64 KiB, always finished. That gap is exactly why this looked like "works
  // standalone, broken in the app" and sent the search after the wrong change.
  function run(cmd, args, timeout) { return new Promise((res, rej) => { const p = spawn(cmd, args, { timeout: timeout || 0 }); p.stdout.on('data', () => {}); p.stderr.on('data', () => {}); p.on('error', rej); p.on('close', (c) => c === 0 ? res() : rej(new Error(path.basename(cmd) + (c === null ? ' timed out' : ' failed')))); }); }

  // ---- OpenSubtitles (legacy XML-RPC, no API key) ----
  // Hash the file and fetch a matching subtitle. Uses the OpenSubtitles
  // movie-hash (size + 64-bit sums of the first & last 64 KiB) so it matches by content, not name.
  const zlib = require('zlib');
  function osHash(file) {
    const CH = 65536, fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < CH * 2) return null; // too small to hash reliably
      let hash = BigInt(size); const buf = Buffer.alloc(CH); const MASK = (1n << 64n) - 1n;
      const sum = () => { for (let i = 0; i < CH; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & MASK; };
      fs.readSync(fd, buf, 0, CH, 0); sum();
      fs.readSync(fd, buf, 0, CH, size - CH); sum();
      return { hash: hash.toString(16).padStart(16, '0'), size };
    } finally { fs.closeSync(fd); }
  }
  function xmlrpc(method, body) {
    return new Promise((resolve, reject) => {
      const payload = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${body}</params></methodCall>`;
      const req = https.request({ host: 'api.opensubtitles.org', path: '/xml-rpc', method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'VLSub 0.10.2' } },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
      req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout'))); req.write(payload); req.end();
    });
  }
  const xmlStr = (xml, name) => { const m = new RegExp('<name>' + name + '</name>\\s*<value>\\s*<string>([^<]*)</string>', 'i').exec(xml); return m ? m[1] : null; };
  // Parse every subtitle result struct (the SearchSubtitles array) so we can rank, not just take the first.
  // Each result struct contains NESTED structs, so a non-greedy /<struct>…<\/struct>/ truncates at the first
  // inner </struct> and finds nothing. Split the array on the sibling-struct boundary instead (that pattern
  // only occurs between top-level results, never after a nested member struct → it's </struct></value></member>).
  function osStructs(xml) {
    const data = (/<data>([\s\S]*)<\/data>/i.exec(xml) || [])[1] || xml;
    return data.split(/<\/struct>\s*<\/value>\s*<value>\s*<struct>/i).map((b) => ({
      link: xmlStr(b, 'SubDownloadLink'), name: xmlStr(b, 'SubFileName'), lang: xmlStr(b, 'SubLanguageID'),
      matchedBy: xmlStr(b, 'MatchedBy'), downloads: parseInt(xmlStr(b, 'SubDownloadsCount') || '0', 10)
    })).filter((s) => s.link);
  }
  ipcMain.handle('subtitle:online', async (_e, { src, lang } = {}) => {
    const file = localMediaPath(src);
    if (!file) return { ok: false, error: 'Online subtitles need a local file' };
    let h; try { h = osHash(file); } catch (e) { return { ok: false, error: 'Could not read file' }; }
    if (!h) return { ok: false, error: 'File too small to match' };
    try {
      const login = await xmlrpc('LogIn', ['', '', 'en', 'VLSub 0.10.2'].map((s) => `<param><value><string>${s}</string></value></param>`).join(''));
      const token = xmlStr(login, 'token');
      if (!token) return { ok: false, error: 'OpenSubtitles unavailable' };
      // Search by BOTH the content hash AND the cleaned filename, so a release whose hash isn't in the DB
      // (most torrent rips) still matches by name instead of returning nothing.
      // `want` is interpolated raw into the XML-RPC body below, unlike `query` on the next line
      // which is sanitised. A renderer-supplied language code containing markup would inject into
      // the request sent to OpenSubtitles. In practice the renderer never passes one, so this is
      // shutting a door nobody has walked through — but the channel accepts the argument.
      const want = /^[a-z]{2,3}$/i.test(String(lang || '')) ? String(lang).toLowerCase() : 'eng';
      const base = String(file).split('/').pop().replace(/\.[^.]+$/, '');
      const query = base.replace(/[._]+/g, ' ').replace(/[<>&'"]/g, ' ').trim();
      const mem = (n, v) => `<member><name>${n}</name><value><string>${v}</string></value></member>`;
      const struct = (m) => `<value><struct>${m}</struct></value>`;
      const queries = struct(mem('moviehash', h.hash) + mem('moviebytesize', String(h.size)) + mem('sublanguageid', want)) +
        (query ? struct(mem('query', query) + mem('sublanguageid', want)) : '');
      const sBody = `<param><value><string>${token}</string></value></param>` +
        `<param><value><array><data>${queries}</data></array></value></param>`;
      const search = await xmlrpc('SearchSubtitles', sBody);
      const results = osStructs(search);
      if (!results.length) return { ok: false, error: 'No matching subtitle found' };
      // Rank: a content (moviehash) match beats a name match; then exact language, popularity, and how
      // many filename tokens the candidate shares with the source (release group / episode markers).
      const wl = want.toLowerCase(), toks = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const best = results.map((s) => {
        let sc = 0;
        if (/moviehash/i.test(s.matchedBy || '')) sc += 1000;
        if ((s.lang || '').toLowerCase() === wl) sc += 200;
        sc += Math.min(100, (s.downloads || 0) / 50);
        const nl = (s.name || '').toLowerCase();
        sc += toks.filter((t) => nl.includes(t)).length * 10;
        return { s, sc };
      }).sort((a, b) => b.sc - a.sc)[0].s;
      const link = best.link, name = best.name || 'subtitle.srt';
      // The link comes verbatim from the XML-RPC response — pin it to https + opensubtitles.org, cap
      // the download, and bound decompression so a malicious/MITM'd reply can't OOM the main process
      // (which owns playback + every cast engine) with a gzip bomb. (Audit M2)
      let lu; try { lu = new URL(link); } catch (e) { return { ok: false, error: 'Bad subtitle link' }; }
      if (lu.protocol !== 'https:' || !/(^|\.)opensubtitles\.org$/i.test(lu.hostname)) return { ok: false, error: 'Untrusted subtitle host' };
      const fetchGz = (u) => new Promise((resolve, reject) => {
        https.get(u, { headers: { 'User-Agent': 'VLSub 0.10.2' } }, (res) => {
          // A non-200 body is an error page, not a subtitle; gunzip would fail on it several lines
          // later with something unhelpful.
          if (res.statusCode !== 200) { res.resume(); reject(new Error('subtitle download HTTP ' + res.statusCode)); return; }
          const chunks = []; let total = 0;
          res.on('data', (c) => { total += c.length; if (total > 8 * 1024 * 1024) { res.destroy(); reject(new Error('Subtitle download too large')); return; } chunks.push(c); });
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      // OpenSubtitles will transcode to UTF-8 server-side if the download path asks for it — the old
      // player used this rather than guessing encodings locally, and a subtitle in the wrong charset
      // is a screenful of mojibake. Only a path rewrite, so it is attempted first and the original
      // link is used if the server does not recognise it.
      const utf8Link = link.includes('/download/') && !link.includes('subencoding-')
        ? link.replace('/download/', '/download/subencoding-utf8/') : null;
      let gz = null;
      if (utf8Link) { try { gz = await fetchGz(utf8Link); } catch (e) { console.log('[subs] utf-8 variant refused (' + e.message + '), using the original link'); } }
      if (!gz) gz = await fetchGz(link);
      const srt = zlib.gunzipSync(gz, { maxOutputLength: 32 * 1024 * 1024 }); // cap inflated size
      const out = path.join(app.getPath('temp'), 'spritz-os-' + Date.now() + '.srt');
      fs.writeFileSync(out, srt);
      return { ok: true, srt: out, name };
    } catch (e) { return { ok: false, error: e.message || 'OpenSubtitles failed' }; }
  });

  // External subtitle file the user attached (also sub-add'd to mpv in the renderer). Remember it so
  // an AirPlay/Chromecast cast carries it too — converted to a WebVTT rendition (HLS) or sideloaded
  // text track (direct MP4), with charset detection. Pre-cast additions are included automatically;
  // a subtitle added mid-cast needs a re-cast to appear (AirPlay/Cast can't add a rendition live).
  ipcMain.on('subtitle:external', (_e, { path: p, lang, name } = {}) => {
    if (!p || externalSubs.some((s) => s.path === p)) return;
    externalSubs.push({ path: p, lang: lang || 'und', name: name || path.basename(String(p)) });
  });

  // ---- VPN kill-switch status ----
  // A tunnel interface (utun/ppp/tun/tap/wg) that's up with an IPv4 ≈ an active VPN. Used by the
  // renderer's optional "only torrent over VPN" guard — honest detection, no bundled VPN.
  ipcMain.handle('vpn:status', () => {
    try {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        if (!/^(utun|ppp|tun|tap|wg|ipsec)/i.test(name)) continue;
        for (const a of ifaces[name] || []) if (a.family === 'IPv4' && !a.internal) return { active: true, name };
      }
    } catch (e) {}
    return { active: false, name: null };
  });

  // ---- SponsorBlock (YouTube) ----
  // Fetch crowd-sourced skip segments for a video id. Returns [] on any failure (offline,
  // no segments) so the caller degrades gracefully.
  const https = require('https');
  ipcMain.handle('sponsorblock:get', (_e, { videoId } = {}) => new Promise((resolve) => {
    if (!videoId) return resolve([]);
    const cats = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic']));
    const req = https.get('https://sponsor.ajay.app/api/skipSegments?videoID=' + encodeURIComponent(videoId) + '&categories=' + cats, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve([]); }
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d).map((s) => ({ start: s.segment[0], end: s.segment[1], cat: s.category }))); } catch (e) { resolve([]); } });
    });
    req.on('error', () => resolve([])); req.setTimeout(6000, () => req.destroy());
  }));

  // ---- thumbnail seek preview ----
  // Extract a single 160px frame at `time` via ffmpeg input-seek (fast). Bucketed to 5s
  // and LRU-capped so hovering the scrubber doesn't spawn endless ffmpegs.
  const thumbCache = new Map();
  const THUMB_CACHE_BYTES = 16 * 1024 * 1024;
  function cacheThumbnail(key, url) {
    thumbCache.delete(key); thumbCache.set(key, url);
    let bytes = 0;
    for (const value of thumbCache.values()) bytes += Buffer.byteLength(value);
    while (thumbCache.size > 400 || bytes > THUMB_CACHE_BYTES) {
      const oldest = thumbCache.keys().next().value;
      bytes -= Buffer.byteLength(thumbCache.get(oldest)); thumbCache.delete(oldest);
    }
  }
  ipcMain.handle('thumb:at', function thumbnailRequest(_e, { src, time, consumer = 'preview' } = {}) { return new Promise((resolve) => {
    // `src` reaches ffmpeg's -i, which speaks http/tcp/concat/subfile as readily as files. Both
    // call sites pass a local absolute path (the renderer only sets currentLocalPath for those),
    // so pinning it to a real local file costs nothing and drops the protocol surface.
    if (consumer !== 'preview' && consumer !== 'poster') return resolve(null);
    const file = localMediaPath(src);
    if (!file || typeof time !== 'number' || !Number.isFinite(time)) return resolve(null);
    const revision = () => {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return null;
        return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      } catch (e) { return null; }
    };
    const sourceRevision = revision();
    if (sourceRevision === null) return resolve(null);
    const bucket = Math.round(Math.max(0, time) / 5) * 5;
    const key = file + '|' + sourceRevision + '|' + bucket;
    if (thumbCache.has(key)) {
      const cached = thumbCache.get(key);
      thumbCache.delete(key); thumbCache.set(key, cached);
      return resolve(cached);
    }
    if (pendingThumbnail && pendingThumbnail.key === key) {
      if (pendingThumbnail.waiters.length >= 32) return resolve(null);
      if (consumer === 'preview') pendingThumbnail.consumer = 'preview';
      pendingThumbnail.waiters.push(resolve); return;
    }
    if (pendingThumbnail && consumer === 'poster' && pendingThumbnail.consumer === 'preview') {
      if (pendingThumbnail.waiters.length >= 32) return resolve(null);
      pendingThumbnail.waiters.push((url) => {
        if (!url) return resolve(null);
        resolve(thumbnailRequest(_e, { src, time, consumer }));
      });
      return;
    }
    if (pendingThumbnail) pendingThumbnail();
    let ff;
    try {
      ff = spawn(FFMPEG, ['-ss', String(bucket), '-i', file, '-frames:v', '1',
        '-vf', 'scale=160:-2', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { timeout: 8000 });
    } catch (e) { resolve(null); return; }
    const chunks = []; let bytes = 0, finished = false, deadline = null;
    const finish = (url) => {
      if (finished) return;
      finished = true; chunks.length = 0;
      if (deadline !== null) clearTimeout(deadline);
      if (pendingThumbnail === cancel) pendingThumbnail = null;
      for (const waiter of cancel.waiters.splice(0)) waiter(url);
    };
    const cancel = () => {
      if (finished) return;
      finish(null); try { ff.kill('SIGKILL'); } catch (e) {}
    };
    cancel.key = key; cancel.consumer = consumer; cancel.waiters = [resolve];
    pendingThumbnail = cancel;
    deadline = setTimeout(cancel, 8000);
    ff.stdout.on('data', (d) => {
      if (finished) return;
      bytes += d.length;
      if (bytes > 1024 * 1024) {
        finish(null); try { ff.kill('SIGKILL'); } catch (e) {}
        return;
      }
      chunks.push(d);
    });
    ff.stdout.on('error', cancel);
    ff.stderr.on('data', () => {});
    ff.stderr.on('error', cancel);
    ff.on('error', cancel);
    ff.on('close', (code) => {
      if (finished) return;
      if (code !== 0 || !chunks.length || revision() !== sourceRevision) return finish(null);
      const url = 'data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64');
      cacheThumbnail(key, url); finish(url);
    });
  }); });

  // ---- watch history / resume ----
  ipcMain.handle('history:get', (_e, { src } = {}) => { try { return history.get(src); } catch (e) { return null; } });
  ipcMain.on('history:save', (_e, { src, pos, dur, title } = {}) => { try { history.save(src, pos, dur, title); } catch (e) {} });
  ipcMain.on('history:remove', (_e, { src } = {}) => { try { history.remove(src); } catch (e) {} });
  ipcMain.handle('history:recents', (_e, { n } = {}) => { try { return history.recents(n); } catch (e) { return []; } });
  ipcMain.handle('pref:get', (_e, { key } = {}) => { try { return history.getPref(key); } catch (e) { return null; } });
  ipcMain.on('pref:save', (_e, { key, pref } = {}) => { try { history.setPref(key, pref); } catch (e) {} });

  // Google Cast engine state (the live engine is tracked by `castEngine`).
  let lastCastTitle = '';
  // When the Chromecast cast is the single-MKV transport, this holds what's needed to RE-CAST on a
  // seek or audio-language change (the proven single-progressive-stream mechanism — the receiver decodes one
  // bulletproof stream; switching = a fresh stream at the same position). null for direct-MP4 casts.
  let castMkv = null; // { input, caps, audioTracks:[{idx,name,lang}], dur, audioTrack }
  cast.on('devices', (devices) => { diagCast = devices || []; send('cast-event', { type: 'devices', devices }); });
  cast.on('error', (e) => { recordErr('cast', e.message); send('cast-event', { type: 'error', message: e.message }); });
  // A load that the receiver accepts is NOT proof it can play the stream. The grey-screen failures
  // all had a successful load: the receiver took the request, fetched a couple of seconds, and hung
  // up. Recording a success there would have written a permanent, false claim that this TV plays 4K
  // HEVC in Matroska — and since observations only ever widen a profile, nothing would undo it.
  //
  // So proof is playback that got somewhere: the receiver reporting PLAYING and the position having
  // advanced past where the stream began. That cannot happen without decoding what was sent.
  const OBSERVE_AFTER_SEC = 5;
  function confirmObservation(s) {
    if (!pendingObservation || !s || s.playerState !== 'PLAYING') return;
    if (!(typeof s.currentTime === 'number')) return;
    if (s.currentTime - pendingObservation.from < OBSERVE_AFTER_SEC) return;
    const { key, traits } = pendingObservation;
    pendingObservation = null;
    deviceMemory.noteSuccess(key, Object.assign({}, traits, { at: Date.now() }));
    const d = deviceMemory.describe(key);
    if (d) console.log('[cast] learned ' + (d.label || key) + ' plays: ' + d.played.join(', '));
  }

  // Guard against reacting to our own re-cast: the receiver reports an empty track list while the
  // new session loads, and adopting that would bounce subPick back to -1 and re-cast again.
  const { createSettleGuard, createSelectionBaseline } = require('./settle-guard');
  const subGuard = createSettleGuard(), subBaseline = createSelectionBaseline();
  function adoptReceiverSub(s) {
    if (!castMkv || castEngine !== 'chromecast') return;
    // Only a CHANGE in what the receiver has selected, seen while nothing is being rebuilt, is the viewer
    // using the TV remote. The first quiet report is just the starting state.
    if (!subBaseline.observe(s.activeTrackIds, subGuard.active())) return;
    const n = (castMkv.menuSubs || []).filter((m) => !m.burn).length;
    if (!n) return;
    // cast.js assigns sideloaded text tracks ids 1000+i, in offer order. Anything outside that range
    // is not one of ours (audio, or an embedded track the receiver found itself).
    const want = require('./lanserver').receiverSubPick(s.activeTrackIds, n, castMkv.subPick); // a module helper, not on the instance
    if (want == null) return;
    if (want < 0) { castMkv.subPick = -1; return; }   // switched off — nothing to extract, nothing to reload
    castMkv.subPick = want;
    castLog('subtitle chosen on the receiver (track ' + (1000 + want) + ') — extracting it and re-casting');
    // recastMkv holds subGuard for the whole rebuild, so the receiver's own reports during it are not
    // read as another choice made on the remote.
    recastMkv(lastCastPos || lastAvTime || 0, castMkv.audioTrack, castMkv.burnSub, () => {
      try { cast.setTrack('subs', 1000 + want); } catch (e) {}
    });
  }
  cast.on('status', (s) => {
    if (!s) return;
    // The live pipe's clock counts from the start of the STREAM (the MP4 muxer zeroes it), so a cast
    // resumed an hour in reports seconds. Add back the film time of that zero; every position below
    // — resume marker, recovery point, subtitle sync, the renderer's clock — is then film time.
    if (castMkv && !castMkv.direct && Number.isFinite(s.currentTime)) {
      const origin = lan.castOrigin();
      if (origin > 0) s = Object.assign({}, s, { currentTime: s.currentTime + origin });
    }
    // Every transition, with the reason attached. FINISHED mid-film and ERROR mid-film are entirely
    // different failures that look identical from outside, and this is the line that separates them.
    if (s.playerState && s.playerState !== lastPlayerState) {
      castLog('receiver state ' + (lastPlayerState || '-') + ' -> ' + s.playerState +
        (s.idleReason ? ' (' + s.idleReason + ')' : '') +
        ' at ' + Math.round(s.currentTime || 0) + 's' +
        (castMkv && castMkv.dur ? ' of ' + Math.round(castMkv.dur) + 's' : ''));
      lastPlayerState = s.playerState;
    }
    confirmObservation(s);
    // Subtitles can also be changed on the TV's own remote, which never reaches our IPC. Since every
    // track but the selected one is served as a stub, not noticing that would hand the remote a list
    // of tracks that are selectable and permanently blank — worse than offering none. The receiver
    // reporting a different activeTrackId IS the selection; treat it exactly like one made in our UI.
    adoptReceiverSub(s);
    // Only believe the clock while the receiver is actually showing the film. It reports
    // currentTime 0 during IDLE and BUFFERING, and taking that at face value wipes the resume
    // position — observed: a recast triggered while paused at 3876s relaunched at 3391s, minutes
    // behind, because the position it read had been clobbered by a transitional zero.
    //
    // But most position updates arrive on frames that carry ONLY a timestamp, with no state at all,
    // and testing those against the state discarded every one of them. Over a 7m14s cast the last
    // position recorded was 1s, so the recovery restarted the film from the beginning — a worse
    // outcome than the failure it exists to repair. A frame that does not mention the state is not a
    // state change; it means "still whatever I last said".
    const believable = trustPosition(effectiveState(s.playerState, lastPlayerState), s.currentTime);
    if (believable) {
      lastAvTime = s.currentTime;
      lastCastPos = s.currentTime;
    }
    // Tell the LAN server where the receiver actually is. If it re-requests the stream — which it
    // does on any stall, and which we do not control — this is what stops the restart being served
    // from the original seek point, minutes behind where it is playing.
    if (castMkv && believable) { try { lan.noteCastPosition(s.currentTime); } catch (e) {} }
    const dur = (castMkv && castMkv.dur) || (s.media && s.media.duration) || 0; // MKV stream length is the source's
    // And tell the TORRENT engine, so its critical piece window travels with the receiver the way it
    // already travels with mpv. Without this the window froze wherever local playback last left it
    // — usually the head of the file — for the entire cast, and the pieces the television was about
    // to read were no more urgent than any other. Same trust gate as the resume clock above; see
    // receiver-playhead.js for why a reading is refused rather than coerced.
    if (believable) {
      const ph = playheadUpdate({ source: mpvLastUrl, cur: s.currentTime, dur });
      if (ph) { try { torrent.setPlayhead(ph.frac, ph.durationSec); } catch (e) {} }
    }
    send('cast-event', { type: 'status', cur: s.currentTime || 0, dur, state: s.playerState });
  });
  // Receiver finished the media (IDLE/FINISHED) → tear the session down HERE (so the renderer can go
  // home without a cast:stop that would reload+replay the finished file locally) and tell the renderer
  // to clear resume + leave the wedged last frame. (Audit M5)
  cast.on('ended', () => {
    castLog('receiver reported the media FINISHED' + (castMkv && castMkv.dur ? ' (stream was ' + Math.round(castMkv.dur) + 's long)' : '') + ' — tearing the session down and clearing resume');
    if (castEngine !== 'chromecast') return;
    setEngine('mpv'); castMkv = null;
    try { cast.stop(); } catch (e) {}
    send('cast-event', { type: 'ended' });
  });
  // A LIVE Chromecast session dropped (Wi-Fi blip) on the non-seekable MKV pipe → re-cast a fresh stream
  // from the live position (cast.js can't just re-GET the URL). Bounded so a dead TV can't loop forever.
  let mkvReconnects = 0, mkvReconnectAt = 0;
  cast.on('reconnect', ({ at } = {}) => {
    if (castEngine !== 'chromecast' || !castMkv) return;
    const now = Date.now();
    if (now - mkvReconnectAt > 30000) mkvReconnects = 0; // 30s of stability resets the budget
    if (mkvReconnects >= 3) { resumeLocalFromChromecast(); send('cast-event', { type: 'error', message: 'Cast connection lost.' }); return; }
    mkvReconnects++; mkvReconnectAt = now;
    // `at` is the receiver's own clock, which counts from the start of the stream; lastCastPos is film time.
    recastMkv(lastCastPos || lastAvTime || at || 0, castMkv.audioTrack); // fresh MKV stream from the live position
  });
  function resumeLocalFromChromecast() {
    setEngine('mpv'); castMkv = null;
    try { cast.stop(); } catch (e) {}
    if (mpvLastUrl) { try { mpvAddon.command('loadfile', mpvLastUrl, 'replace', '-1', loadOpts(lastAvTime, true)); } catch (e) {} }
    // NO rearmAirplay: the Chromecast (serveMkv) transport uses its own slot and never touched the
    // AirPlay HLS slot, so castUrl/AVPlayer remain validly bound to the live pre-resolved HLS. Re-
    // resolving would cancelHls() that live slot and rebuild asynchronously, leaving a multi-second
    // window where selecting AirPlay hands AVFoundation a 404'ing item → "Could not connect".
  }

  // Resolve the AirPlay-castable URL for a source the Apple TV can actually fetch:
  //   • https + AV container            → use as-is (ATS-safe, e.g. yt-dlp / direct MP4)
  //   • torrent localhost URL + AV ext  → rewrite host to the Mac's LAN IP (TV can't reach loopback)
  //   • local file + AV container       → serve it over the LAN file server
  //   • anything else (mkv/webm, http)  → null (no AirPlay; gated honestly in the UI)
  const ctypeFor = (u) => /\.m3u8(\?|#|$)/i.test(u || '') ? 'application/vnd.apple.mpegurl'
    : /\.mkv(\?|#|$)/i.test(u || '') ? 'video/x-matroska' : 'video/mp4';
  // caps = receiver capability profile (copy-vs-transcode); extraSubs implied from externalSubs.
  // forCast = this resolution is for an actual Chromecast handoff (extract sideloadable subs for a
  // direct MP4); the AirPlay pre-resolution leaves it false so we don't spawn sub-extractors on every
  // local MP4 load (AVPlayer reads an MP4's embedded subs itself).
  // Buffer health is a conservative hint, scoped to the current source and load.
  function receiverSourceWaiting(source, generation) {
    return require('./receiver-preparation-policy').sourceWaiting(torrentPreparationSample,
      { source, generation, now: Date.now() });
  }

  function resolveCastable(url, cb, caps, forCast, extra) {
    const mediaLan = extra && extra.transport || lan;
    const resolutionGen = loadGen;
    const s = String(url || '');
    // The 4K profile is offered ONLY for local files. A stream copy has no bitrate knob, and a torrent
    // swarm measured here at 0.0 MB/s for four and a half straight minutes; an EVENT playlist that
    // stops growing is exactly what produces -16839, and after readiness the permanently-fatal -11866.
    // A local file is a disk read. capsFallback carries the proven profile so lanserver can decline.
    // Streamed sources may now take the 4K profile too. The original local-only rule was written
    // when a failed 4K copy demoted to a 4K SOFTWARE encode, which never produces a segment and ends
    // the launch ladder at cb(null) — on a torrent that was a real risk, so the gate stayed shut.
    // lanserver now retreats from a wedged 4K copy to the PROVEN 1080p profile instead (see
    // retreatFrom4k), so the failure mode the rule guarded against no longer exists.
    //
    // Still opt-in via SPRITZ_AIRPLAY_4K=1: a torrent pays receive AND send on one radio, so a ~60Mbps
    // copy costs roughly twice the airtime of the transcode it replaces. Worth it for the picture —
    // the copy is native 2160p HDR10 at 46ms of CPU per 8s, against a 1080p re-encode at ~345% — but
    // not something to switch on for everyone without the hardware evidence.
    const hlsOpts = () => (!caps && AIRPLAY_4K && !(extra && extra.receiver))
      ? { caps: airplayCaps(AIRPLAY_CAPS_4K), capsFallback: airplayCaps(AIRPLAY_CAPS), extraSubs: externalSubs }
      : { ...(extra && extra.receiver && require('./receiver-preparation-policy').receiverFeatures(process.env).sourceAudio && Number.isFinite(extra.startSec) ? { receiverStartSec: () => extra.startSec } : {}), ...(extra && Number.isInteger(extra.audioHint) ? { audioHint: extra.audioHint } : {}), receiverSourceWaiting: () => receiverSourceWaiting(s, resolutionGen), sourceSelectedAudio: !!(extra && extra.receiver && require('./receiver-preparation-policy').receiverFeatures(process.env).sourceAudio), sideloadSubs: !!(extra && extra.receiver), receiverSubtitles: !!(extra && extra.receiverSubtitles), caps: caps || airplayCaps(AIRPLAY_CAPS), ...(caps && caps.hevc4k ? { capsFallback: require('./device-profile').defaultProfile() } : {}), extraSubs: externalSubs };
    // Remote https (yt-dlp / direct): no probe/remux — use as-is when it's an AV container.
    if (/^https:\/\//i.test(s)) return cb(mediaLan.avCompatible(s) ? s : null);
    // Torrent localhost stream: rewrite host→LAN IP so the TV can fetch webtorrent's
    // range-served stream directly. NO ffprobe/remux here — probing a torrent stream stalls
    // (moov may be at the tail / whole file not downloaded), which would block the cast button.
    // AVPlayer range-reads the moov itself. MKV/etc can't be cast (no AV container) → null.
    const tor = s.match(/^http:\/\/(?:localhost|127\.0\.0\.1)(:\d+)(\/webtorrent\/.*)$/i);
    if (tor) {
      if (mediaLan.avCompatible(s)) { // mp4/mov/m4v → AVPlayer fetches webtorrent's stream directly
        const ip = mediaLan.lanAddress();
        return cb(ip ? 'http://' + ip + tor[1] + tor[2] : null);
      }
      // mkv/avi/ts/etc (H.264/HEVC) → live HLS remux so AVPlayer/Chromecast can play it as it streams
      if (/\.(mkv|avi|ts|m2ts|webm|wmv|flv|mpg|mpeg|ogv)(\?|#|$)/i.test(s)) return mediaLan.serveHls(s, cb, hlsOpts());
      return cb(null);
    }
    // Local file. MP4/MOV → direct serve (prepareCast). Foreign containers (MKV/AVI/TS/…)
    // → live HLS so embedded subtitles + multi-audio survive the cast (sidecar WebVTT +
    // selectable audio renditions), instead of the subtitle-dropping remux-to-MP4 path.
    const filePath = decodeURIComponent(s.replace(/^file:\/\//, ''));
    if (/^\//.test(filePath)) {
      if (/\.(mkv|avi|ts|m2ts|webm|wmv|flv|mpg|mpeg|ogv)$/i.test(filePath)) {
        // Try the SEEKABLE VOD playlist first, and fall back to live HLS when it declines.
        //
        // This is the same film either way; the difference is what the AVPlayer is handed. Live HLS
        // is an EVENT playlist growing behind one long-lived ffmpeg — the arrangement that produced
        // this project's resume-point module, its cast-recovery module, and a stack of commits about
        // paused receivers killing sockets. A VOD playlist is finite and complete before anything is
        // encoded, so a pause is simply not asking for the next segment and a seek is asking for a
        // different index. See hls-vod.js and lanserver's serveVod.
        //
        // serveVod returns null when it is switched off (the default), when the receiver cannot
        // decode the source's video, or when the file has no usable duration — so the fallback is
        // the ordinary case, not an error path. LOCAL FILES ONLY, deliberately: the keyframe probe
        // is a full pass over the file, which on a still-downloading torrent would either stall or
        // read pieces that have not arrived. That case is a separate piece of work.
        const opts = hlsOpts();
        // startSec is where the viewer is; an epoch-backed session opens its first epoch there rather
        // than at 0 and then superseding it.
        let cancelled = false, completed = false, fallback = false;
        const disposers = [];
        const dispose = fn => { if (typeof fn === 'function') { try { fn(); } catch (e) {} } };
        const retain = fn => { if (cancelled) dispose(fn); else if (typeof fn === 'function') disposers.push(fn); };
        const finish = (url, subs, metadata) => {
          if (cancelled || completed || resolutionGen !== loadGen) return;
          completed = true; cb(url, subs, metadata);
        };
        if (opts.sourceSelectedAudio) { retain(mediaLan.serveHls(filePath, finish, opts)); return () => { cancelled = true; for (const fn of disposers.splice(0)) dispose(fn); }; }
        retain(mediaLan.serveVod(filePath, { caps: opts.caps, startSec: extra && extra.startSec }, (vodUrl, result) => {
          if (cancelled || completed || fallback || resolutionGen !== loadGen || result && result.outcome === 'cancelled') return;
          if (vodUrl) return finish(vodUrl);
          fallback = true;
          retain(mediaLan.serveHls(filePath, finish, opts));
        }));
        return () => {
          if (cancelled || completed) return;
          cancelled = true;
          for (const fn of disposers.splice(0)) dispose(fn);
        };
      }
      // MP4/MOV: direct-serve if already compatible, else live HLS (fast) instead of a slow full
      // remux — so a 4K MP4 with TrueHD/DTS audio still becomes castable in seconds, not minutes.
      return mediaLan.prepareCast(filePath, true, cb, (input, c) => mediaLan.serveHls(input, c, hlsOpts()), { extraSubs: externalSubs, directSubs: !!forCast });
    }
    cb(null);
  }

  // Resolve the CHROMECAST (LG built-in) URL — the proven single-stream transport: ONE progressive
  // Matroska stream over a single HTTP GET (video -c:v copy for castable, exactly one audio track),
  // subtitles SIDELOADED as WebVTT TEXT tracks. This is dramatically more reliable on the webOS Cast
  // receiver than Spritz's old live-fMP4-HLS (which the receiver parsed unreliably → "can't cast").
  // cb(url, meta) — meta = { subs, audioTracks, dur, isMkv, input, caps, audioTrack }.
  function resolveChromecast(url, caps, audioTrack, startSec, cb) {
    const s = String(url || '');
    if (/^https:\/\//i.test(s)) return cb(lan.avCompatible(s) ? s : null, { subs: [], audioTracks: [], dur: 0, isMkv: false });
    const tor = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i.test(s);
    const filePath = decodeURIComponent(s.replace(/^file:\/\//, ''));
    const input = tor ? s : filePath;
    if (!tor && !/^\//.test(filePath)) return cb(null);
    const serve = () => {
      lan.serveMkv(input, { caps, extraSubs: externalSubs, audioTrack, startSec }, (u, sideloadSubs, audioTracks, aTrack, dur, menuSubs, sent, direct) => {
        if (!u) return cb(null);
        cb(u, { subs: sideloadSubs || [], menuSubs: menuSubs || [], audioTracks: audioTracks || [], dur: dur || 0, isMkv: true, input, caps, audioTrack: aTrack, sent: sent || null, direct: !!direct });
      });
    };
    // ffmpeg cannot emit a frame until it has demuxed the source, and it cannot demux an MP4 whose
    // index sits at the end of a file the torrent has only downloaded the front of. It blocks, the
    // receiver never receives a byte, and the TV shows its idle screen indefinitely — which reads as
    // "casting is broken" rather than "one 8 MB region is missing". Fetch it first when needed.
    if (tor) { try { return torrent.ensureIndexForCast(serve); } catch (e) { return serve(); } }
    serve();
  }

  // Resolve a DLNA-playable URL — NEVER HLS (DLNA renderers can't play m3u8). For a LOCAL file we
  // serve the ORIGINAL untouched: LG/Samsung/Sony webOS decode MKV/HEVC/HDR natively, so casting is
  // full quality with no remux/transcode. A still-downloading torrent isn't a complete seekable file
  // (DLNA needs that) so foreign-container torrents are rejected → use AirPlay for those.
  function resolveDlna(url, cb) {
    const s = String(url || '');
    if (/\.m3u8(\?|#|$)/i.test(s)) return cb(null);              // remote HLS → DLNA can't play it
    if (/^https:\/\//i.test(s)) return cb(lan.avCompatible(s) ? s : null);
    const tor = s.match(/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\/.*/i);
    if (tor) {
      // Serve the ORIGINAL torrent stream (any container) to the LG through our DLNA-AWARE PROXY.
      // webOS decodes MKV/HEVC/HDR/Dolby Vision natively + gives its own scrubber/subtitle/audio
      // menus, but it's a STRICT renderer: it HEADs the URL and needs contentFeatures.dlna.org /
      // TransferMode headers + range support, which webtorrent's raw server doesn't emit (→ "device
      // is disconnected"). The proxy adds them and forwards ranged GETs to webtorrent, so the TV
      // connects and seeks. (Local files already go through our own range-served /file/ endpoint.)
      return lan.serveDlna(s, dlnaContentType(s), cb);
    }
    const filePath = decodeURIComponent(s.replace(/^file:\/\//, ''));
    if (/^\//.test(filePath)) return lan.serve(filePath, cb); // serve the original file untouched (native quality)
    cb(null);
  }

  // Native application menu — items send a 'menu-action' to the renderer, which
  // owns the player. (Replaces the old menu.js; renderer keybindings mirror these.)
  // Help > Check for Updates. On request only: Spritz never contacts GitHub by itself. Nothing is downloaded or
  // installed; a newer release just offers to open its page.
  async function checkForUpdates() {
    const current = app.getVersion();
    const r = await require('./update-check').check({ current });
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    if (r.status === 'newer') {
      const { response } = await dialog.showMessageBox(parent, { type: 'info', message: 'Spritz ' + r.version + ' is available',
        detail: 'You have ' + current + '.' + (r.notes ? '\n\n' + r.notes : ''), buttons: ['Open Release Page', 'Not Now'], defaultId: 0, cancelId: 1 });
      if (response === 0) shell.openExternal(r.url);
    } else if (r.status === 'current') {
      await dialog.showMessageBox(parent, { type: 'info', message: 'Spritz is up to date', detail: 'You have ' + current + ', the newest release.', buttons: ['OK'] });
    } else {
      const { response } = await dialog.showMessageBox(parent, { type: 'warning', message: 'Couldn’t check for updates',
        detail: (r.message || 'GitHub could not be reached') + '.\n\nYou can look for a newer release yourself.', buttons: ['Open Releases Page', 'OK'], defaultId: 1, cancelId: 1 });
      if (response === 0) shell.openExternal(require('./update-check').RELEASES_PAGE);
    }
  }

  function buildMenu() {
    const isMac = process.platform === 'darwin';
    const act = (a) => () => send('menu-action', a);
    const template = [
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: act('open-file') },
          { label: 'Open URL…', accelerator: 'CmdOrCtrl+U', click: act('open-url') },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' }
        ]
      },
      { role: 'editMenu' }, // undo/cut/copy/PASTE/selectAll — needed for Cmd+V in text fields
      {
        label: 'Playback',
        submenu: [
          { label: 'Play/Pause', accelerator: 'CmdOrCtrl+P', click: act('playpause') },
          { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: act('stop') }
        ]
      },
      {
        label: 'View',
        submenu: [
          { label: 'Toggle Full Screen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11', click: act('fullscreen') },
          { label: 'Toggle Stats Overlay', accelerator: 'I', click: act('stats') },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: act('settings') },
          { type: 'separator' },
          { label: 'Float on Top', accelerator: 'CmdOrCtrl+Shift+T', click: act('float') },
          { label: 'Mini Player', accelerator: 'CmdOrCtrl+Shift+M', click: act('mini') },
          { type: 'separator' },
          {
            label: 'Anime4K Upscale',
            submenu: [
              { label: 'Off', accelerator: 'Ctrl+0', click: act('shader-off') },
              { label: 'Mode A (1080p source)', accelerator: 'Ctrl+1', click: act('shader-A') },
              { label: 'Mode B (720p source)', accelerator: 'Ctrl+2', click: act('shader-B') },
              { label: 'Mode C (480p source)', accelerator: 'Ctrl+3', click: act('shader-C') }
            ]
          },
          { type: 'separator' },
          { role: 'toggleDevTools' }
        ]
      },
      { role: 'windowMenu' },
      require('./help-menu').helpMenu({
        checkForUpdates, shell, userDataDir: app.getPath('userData'), logsDir: path.join(app.getPath('home'), 'Library', 'Logs', 'DiagnosticReports'),
        exists: fs.existsSync, version: app.getVersion(), licensesDir: path.join(process.resourcesPath, 'licenses'),
        installer: require('./receiver-installer').findInstaller({ resourcesPath: process.resourcesPath, root: path.join(__dirname, '..', '..') })
      })
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // Attach the native video surface under the web contents, forward addon events
  // to the renderer, and start the mpv core. The renderer drives the first load.
  function attachPlayer() {
    if (!mpvAddon || !mpvAddon.attachTestSurface) {
      console.error('[player] addon unavailable');
      return;
    }
    try {
      mpvAddon.attachTestSurface(mainWindow.getNativeWindowHandle());
      const mpvLog = require('./mpv-log').createMpvLog({ file: path.join(app.getPath('userData'), 'mpv.log') });
      mpvAddon.setEventListener((ev) => {
        if (mpvLog.handle(ev)) return; // libmpv error lines go to userData/mpv.log, not the renderer
        // Temp torrent diag: log mpv's load lifecycle for a torrent URL so we can see whether mpv actually
        // opened the stream (file-loaded) or failed (end-file reason=4=ERROR). Remove once "press twice" is solved.
        if (process.env.SPRITZ_DEBUG && ev && (ev.type === 'file-loaded' || ev.type === 'end-file') && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i.test(mpvLastUrl || '')) {
          try { fs.appendFileSync('/tmp/spritz-torrent.log', '[' + new Date().toISOString().slice(11, 23) + '] mpv ' + ev.type + (ev.type === 'end-file' ? ' reason=' + ev.reason : '') + '\n'); } catch (e) {}
        }
        // Feed the play position to the torrent engine so it can keep its CRITICAL piece window
        // travelling with the play head instead of leaving everything after the prebuffer to plain
        // sequential download. Cheap: a couple of numbers, no allocation, and torrent.js only acts
        // on it once per second when it emits progress.
        if (ev && ev.type === 'property-change' && ev.name === 'time-pos' && typeof ev.value === 'number' && mpvDuration > 0) {
          try { torrent.setPlayhead(ev.value / mpvDuration, mpvDuration); } catch (e) {}
        }
        if (ev && ev.type === 'property-change' && ev.name === 'duration' && typeof ev.value === 'number') mpvDuration = ev.value;
        send('player-event', ev);
      }); // BEFORE startPlayer
      const sp = mpvAddon.startPlayer();
      console.log('[player] started', JSON.stringify(sp));
      // Sidecar auto-discovery. Releases routinely ship "Movie.mkv" beside "Movie.en.srt" (or a
      // Subs/ folder, or a separate audio track), and none of it was being picked up: mpv only
      // loads sidecars when told to. 'fuzzy' matches files whose name starts with the video's,
      // which is the convention scene releases follow, without dragging in every file in the
      // directory the way 'all' would.
      try {
        mpvAddon.setProperty('sub-auto', 'fuzzy');
        mpvAddon.setProperty('audio-file-auto', 'fuzzy');
        // Common subtitle subfolder names, relative to the media file.
        mpvAddon.setProperty('sub-file-paths', 'Subs:subs:Subtitles:subtitles');
      } catch (e) { console.error('[player] sidecar auto-load setup', e.message); }
      if (apAddon && apAddon.setEventListener) {
        apAddon.setEventListener((ev) => {            // listener BEFORE attachPicker (TSFN invariant)
          if (ev.type !== 'time') console.log('[airplay]', JSON.stringify(ev)); // diag
          if (ev.type === 'time' && typeof ev.cur === 'number') {
            // Time events are the ONLY evidence that the player is actually advancing, and they were
            // suppressed entirely — so a session that loaded cleanly, engaged the route and then sat
            // frozen looked identical in the log to one that was playing perfectly. Log the first few
            // and then one every ~30s: enough to answer "is it moving?" without burying the file.
            apTimeSeen++;
            // Every ~5s once engaged. The previous cadence (first five, then every 60th) could not
            // show a STALL: a stream that started and froze at 8s looked identical to one playing
            // fine, because the next line was 30s of playback away and never came. A frozen picture
            // is the thing most likely to be mistaken for "subtitles aren't working".
            if (apTimeSeen <= 5 || apTimeSeen % 10 === 0) {
              const moved = ev.cur - apLastLoggedTime;
              console.log('[airplay] time ' + ev.cur.toFixed(1) + 's (event ' + apTimeSeen + ') engine=' + castEngine +
                ' externalActive=' + apExternalActive + (apTimeSeen > 5 ? ' advanced=' + moved.toFixed(1) + 's' + (moved < 0.5 ? ' STALLED' : '') : ''));
              apLastLoggedTime = ev.cur;
            }
            lastAvTime = ev.cur; avItemFailed = false; if (castEngine === 'airplay') cancelDrop();
            // Tell the LAN server where the player is, so a subtitle extractor started from the remote
            // seeks to the play head instead of reading the file from the beginning.
            try { lan.noteAirplayPosition(ev.cur); } catch (e) {}
          } // frames flowing → not dropped, not failed
          if (ev.type === 'external') {
            apExternalActive = !!ev.active;
            if (ev.active) apTimeSeen = 0;   // fresh engage → count again from zero
            // Ignore an AirPlay route engaged (e.g. from Control Center) while a Chromecast/DLNA cast
            // is already active OR a cast handoff is mid-resolve ('pending') — two engines at once
            // would orphan the other session. (Audit M4 — the 'pending' check closes the resolve window.)
            if (ev.active && (castEngine === 'chromecast' || castEngine === 'dlna' || castEngine === 'pending')) {
              // Logged because this used to return in silence, and "we refused it" is indistinguishable
              // from "the OS never told us" when neither writes a line.
              console.log('[airplay] route engage REFUSED — ' + castEngine + ' is already casting');
              try { apAddon.stopAirplay(); } catch (e) {} return;
            }
            if (ev.active) {
              console.log('[airplay] route ENGAGED by user | castUrl=' + (castUrl ? String(castUrl).slice(0, 80) : 'NULL') + ' engine=' + castEngine);
              // Nothing castable for this source (or not yet resolved) → don't stop mpv into a dead/empty
              // AVPlayer item (that surfaces as "Could not connect"); back the route off and stay local.
              if (!castUrl) { console.error('[airplay] BLOCKED: no castable URL resolved yet (HLS pre-resolve not ready/failed) — staying local'); try { apAddon.stopAirplay(); } catch (e) {} return; }
              cancelDrop();                            // route (re)engaged → cancel any pending drop
              // A failed item is permanent: AVFoundation will not reload it, and the handoff below is
              // guarded on castEngine !== 'airplay' — so once an item had failed, the engine stayed
              // 'airplay' and every further press of the AirPlay button did LITERALLY NOTHING. Observed
              // four times in one session. Rebuild the item first, and drive it from here when the
              // handoff is going to be skipped.
              if (avItemFailed) {
                const at = castEngine === 'airplay' ? lastAvTime : mpvPos();
                console.log('[airplay] rebuilding a failed AVPlayer item at ' + Math.round(at) + 's before engaging');
                avItemFailed = false;
                try { apAddon.prepare(castUrl, at); } catch (e) { console.error('[airplay] re-prepare err', e.message); }
                if (castEngine === 'airplay') { try { apAddon.seek(at); apAddon.play(); } catch (e) {} }
              }
              if (castEngine !== 'airplay') handOffToAirplay('route engaged');
            } else if (castEngine === 'airplay') {
              // DEBOUNCE: a 4K webOS AirPlay-2 session flickers externalPlaybackActive=NO mid-
              // handshake. Resuming local on the FIRST inactive drops the cast the instant it
              // connects. Only resume if it STAYS inactive (and no frames arrive) for a few seconds.
              // Do NOT forward the transient inactive to the renderer (it would exitCasting now).
              scheduleDrop(false);
              return;
            }
          }
          // AVPlayer failure (bad codec, network, ATS). A transient error can also fire during the
          // handshake, so debounce it the same way — a real failure stays errored and resumes after
          // the grace; a spurious one is cancelled by the next 'external active' / 'time' event.
          if (ev.type === 'error' || (ev.type === 'status' && ev.value === 2)) {
            avItemFailed = true;
            console.error('[airplay] native FAIL event:', ev.type, '·', ev.message || ('status=' + ev.value), '· engine=' + castEngine + ' (if this fires after route-engage, the LG/AVFoundation rejected our HLS — not a castUrl problem)');
            if (castEngine === 'airplay') scheduleDrop(true, ev.message || 'AirPlay playback failed');
            return;
          }
          send('airplay-event', ev);
        });
        // Start route detection + create the (hidden) picker at startup so 'routes'
        // events flow before the button is ever shown.
        try { apAddon.attachPicker(mainWindow.getNativeWindowHandle(), 0, 0, 1, 1); pickerAttached = true; } catch (e) {}
      }
    } catch (e) {
      console.error('[player] attach failed:', e.message);
    }
  }

  // Audio/subtitle selection live across a cast → return-to-local reload. Captured from the
  // mpv core just before a cast handoff stops it, so resuming doesn't reset the user's chosen
  // language/subtitle back to track 1 / off. null → use mpv defaults (first load).
  let savedAid = null, savedSid = null;
  function captureTracks() {
    // Only capture from a LIVE local core. If a cast is already active mpv is stopped, so
    // playerStat() returns stale/empty values that would clobber the genuine capture.
    if (isCasting()) return;
    try {
      const s = mpvAddon.playerStat() || {};
      savedAid = (s.aid != null && s.aid !== '' && s.aid !== 'auto') ? s.aid : null;
      savedSid = (s.sid != null && s.sid !== '' && s.sid !== 'auto') ? s.sid : null;
    } catch (e) {}
  }
  function loadOpts(start, restore) {
    // First load: aid=1 + sid=no (default audio, subs off). Cast-return (restore): re-apply the
    // captured aid/sid so the user's language/subtitle choice survives the reload.
    const aid = restore && savedAid ? savedAid : '1';
    const sid = restore && savedSid ? savedSid : 'no';
    const opts = ['vid=1', 'aid=' + aid, 'sid=' + sid, 'pause=no'];
    if (typeof start === 'number' && start > 0) opts.push('start=+' + start);
    return opts.join(',');
  }

  // Send whatever is currently open to a Spritz Receiver.
  //
  // Spritz's EXISTING analysis and planning stay authoritative: resolveCastable is the same function
  // the AirPlay path uses, so a film reaches the television through the machinery that already knows
  // how to prepare it. Nothing about media is re-decided here.
  //
  // Two things are passed in as FACTS, and neither is a policy:
  //   - startSec: where the viewer actually is (mpv's clock, or the last AirPlay reading). It sets
  //     where a NEW load begins. It must never cause a reload — receiver-session.shouldLoad() is the
  //     only thing that decides that, and it compares what the television reports holding against
  //     what the application wants. resume-point.js is deliberately NOT consulted: it answers where
  //     to relaunch ffmpeg for a live cast pipe, a question this path does not have.
  //   - mediaId: stable per source, so "the same film" and "a different film" are distinguishable.
  //     Derived from the source, not from the URL, because a URL carries a fresh token per session
  //     and would make every re-pick look like new media.
  //
  // Authenticated platform UHD and codec reports enable HEVC copy; unknown receivers stay 1080p.
  function receiverTransportFor() {
    const source = mpvLastUrl, generation = loadGen;
    return require('./lanserver')({
      registerSourceProducer: input => generation === loadGen && source === mpvLastUrl && input === source
        ? torrent.registerProducer() : null,
      onWarn: message => recordErr('receiver-media', message)
    });
  }
  function receiverTimelineTransport() { return receiverPlan && receiverPlan.transport || lan; }

  let receiverPlan = null; // the last plan sent to a receiver: what a seek or a position report refers to
  function retireReceiverRequest(receiverId) {
    if (pendingReceiverOperation ? pendingReceiverOperation.receiverId === receiverId :
        receiverPlan && receiverPlan.receiverId === receiverId) retireReceiverIntent();
    if (receiverPlan && receiverPlan.receiverId === receiverId) {
      if (receiverPlan.pendingClockTimer) clearTimeout(receiverPlan.pendingClockTimer);
      if (receiverPlan.retirePrevious) receiverPlan.retirePrevious();
      if (receiverPlan.transport && receiverPlan.transport !== lan) receiverPlan.transport.teardown();
      receiverPlan = null;
    }
  }
  function validReceiverTransport(epoch, url, position) {
    return typeof epoch === 'string' && epoch.length > 0 && typeof url === 'string' && url.length > 0 &&
      Number.isFinite(position) && position >= 0;
  }
  // The audio track the Mac is playing, as a source ordinal, so the first cast starts in the same
  // language. null when the viewer has not picked one (mpv reports 'auto'/'no').
  function macAudioOrdinal() {
    try { return require('./receiver-audio-plan').audioOrdinalFromAid((mpvAddon.playerStat() || {}).aid); }
    catch (e) { return null; }
  }
  function playToReceiver(receiverId) {
    const intent = retireReceiverIntent(), generation = loadGen;
    const svc = startReceivers();
    const src = mpvLastUrl;
    if (!src) return Promise.resolve({ ok: false, why: 'nothing is open' });
    const startSec = mpvPos() || lastAvTime || 0;
    const mediaId = require('crypto').createHash('sha1').update(String(src)).digest('hex').slice(0, 16) + require('crypto').randomBytes(4).toString('hex');
    const mediaLan = typeof receiverTransportFor === 'function' ? receiverTransportFor() : lan;
    const previous = receiverPlan && receiverPlan.receiverId === receiverId ? receiverPlan : null;
    const title = (() => { try { return path.basename(decodeURIComponent(String(src).replace(/^file:\/\//, ''))); } catch (e) { return null; } })();
    return new Promise((resolve) => {
      let finished = false, preparing = false, deadline = null, disposeEpoch = null, disposeSource = null, failed = false;
      let releaseAirplay = null, holdTimer = null;
      const holdUnusedAirplay = () => {
        holdTimer = null;
        if (finished || !current() || castEngine !== 'mpv' || mediaLan === lan || previous && previous.transport === lan ||
            typeof lan.holdReadyAirplayPrep !== 'function') return;
        try { releaseAirplay = lan.holdReadyAirplayPrep(); }
        catch (e) { recordErr('receiver-handoff', e.message || 'AirPlay preparation hold failed'); return; }
        if (!releaseAirplay) holdTimer = setTimeout(holdUnusedAirplay, 500);
      };
      const disposePreparation = () => {
        const owned = [disposeSource, disposeEpoch]; disposeSource = null; disposeEpoch = null;
        for (const dispose of owned) if (typeof dispose === 'function') { try { dispose(); } catch (e) {} }
      };
      const current = () => intent === receiverIntent && generation === loadGen && src === mpvLastUrl;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
        if (holdTimer !== null) clearTimeout(holdTimer);
        holdTimer = null;
        if (pendingReceiverOperation === cancel) pendingReceiverOperation = null;
        failed = !result.ok;
        if (result.ok && previous && previous.transport && previous.transport !== mediaLan && receiverPlan && receiverPlan.transport === mediaLan) {
          receiverPlan.retirePrevious = () => {
            if (previous.retirePrevious) previous.retirePrevious();
            if (previous.transport !== lan) previous.transport.teardown();
          };
        }
        if (failed) {
          disposePreparation(); if (mediaLan !== lan) mediaLan.teardown();
          if (receiverPlan && receiverPlan.transport === mediaLan) receiverPlan = previous;
        }
        if (result.ok && current() && castEngine === 'mpv') {
          // A dedicated receiver transport owns playback now; retire speculative AirPlay
          // work unless that transport is still needed for replacement rollback.
          if (mediaLan !== lan && (!previous || previous.transport !== lan)) {
            if (castResolveRetry) clearTimeout(castResolveRetry);
            castResolveRetry = null;
            try { lan.retireReceiverHls(); }
            catch (e) { recordErr('receiver-handoff', e.message || 'AirPlay preparation cleanup failed'); }
          }
          try {
            mpvAddon.setProperty('pause', true);
            mpvAddon.setProperty('demuxer-max-bytes', 33554432);
            mpvAddon.setProperty('demuxer-max-back-bytes', 8388608);
          }
          catch (e) { recordErr('receiver-handoff', e.message || 'local pause failed'); }
        }
        if (releaseAirplay) {
          try { releaseAirplay(castEngine === 'mpv' || castEngine === 'airplay'); }
          catch (e) { recordErr('receiver-handoff', e.message || 'AirPlay preparation release failed'); }
          releaseAirplay = null;
        }
        resolve(result.ok ? { ...result, mediaId } : result);
      };
      const cancel = () => finish({ ok: false, why: 'receiver playback superseded' });
      cancel.receiverId = receiverId;
      cancel.autoplay = true;
      pendingReceiverOperation = cancel;
      const protect = (fn) => (...args) => {
        if (finished) return;
        try { return fn(...args); }
        catch (e) { finish({ ok: false, why: e.message || 'receiver preparation failed' }); }
      };
      deadline = setTimeout(() => finish({ ok: false, why: typeof receiverSourceWaiting === 'function' && receiverSourceWaiting(src, generation)
        ? 'Torrent data is still buffering; receiver preparation timed out' : 'receiver preparation timed out' }), 60000);
      holdUnusedAirplay();
      protect(() => { disposeSource = resolveCastable(src, protect((url, subtitles, metadata) => {
        if (finished || preparing) return;
        if (!current()) return finish({ ok: false, why: 'receiver playback superseded' });
        if (!url) return finish({ ok: false, why: 'this source cannot be prepared for a Spritz Receiver' });
        preparing = true;
        // Epoch-backed (SPRITZ_VOD_EPOCH=1): the URL is one transport of the film. The LOAD names it,
        // and the start position is EPOCH-LOCAL — the epoch, not this function, knows the mapping.
        // The first epoch was opened at startSec by resolveCastable, so the seek below is normally an
        // in-epoch one; if it is not (the epoch landed elsewhere), it takes the same path a viewer's
        // seek takes.
        const ep = mediaLan.vodEpoch && mediaLan.vodEpoch();
        if (ep && ep.current) {
          const epochId = ep.current.id;
          const send = (epochId, url2, localStart) => {
            if (finished) return;
            if (!current()) return finish({ ok: false, why: 'receiver playback superseded' });
            if (!validReceiverTransport(epochId, url2, localStart)) return finish({ ok: false, why: 'invalid receiver transport plan' });
            receiverPlan = { receiverId, mediaId, title, epoch: epochId, url: url2, src, transport: mediaLan, autoplay: cancel.autoplay };
            finish(svc.play(receiverId, { mediaId, epoch: epochId, url: url2, title, startSec: localStart, autoplay: cancel.autoplay }));
          };
          if (startSec > 0) {
            disposeEpoch = mediaLan.vodSeek(startSec, protect((r) => {
              if (r && r.kind === 'new-epoch') return send(r.epoch, r.url, r.startSec);
              if (r && r.kind === 'in-epoch') return send(epochId, url, r.localSec);
              finish({ ok: false, why: 'the receiver start position could not be prepared' });
            }));
            if (finished && failed) disposePreparation();
            return;
          }
          return send(epochId, url, 0);
        }
        console.log('[spritz] receiver source audio: catalog=' + (metadata && metadata.audio ? metadata.audio.length : 0));
        const subtitleTrackId = previous && previous.src === src && typeof svc.subtitleSelection === 'function'
          ? svc.subtitleSelection(receiverId, previous.mediaId, previous.epoch) : undefined;
        receiverPlan = { receiverId, mediaId, title, epoch: null, url, src, subtitles, subtitleTrackId, timelineOrigin: metadata && metadata.timelineOrigin, sourceDuration: metadata && metadata.sourceDuration, audioCatalog: metadata && metadata.audio, selectedAudio: metadata && metadata.selectedAudio, transport: mediaLan, autoplay: cancel.autoplay };
        finish(svc.play(receiverId, { mediaId, url, title, startSec, subtitles, subtitleTrackId, timelineOrigin: metadata && metadata.timelineOrigin, sourceDuration: metadata && metadata.sourceDuration, audioCatalog: metadata && metadata.audio, autoplay: cancel.autoplay }));
      }), typeof svc.profile === 'function' ? svc.profile(receiverId) : null, true, { startSec, receiver: true, receiverSubtitles: true, audioHint: macAudioOrdinal(), transport: mediaLan });
      if (finished && failed) disposePreparation();
      })();
    });
  }

  function rollbackReceiverAudio(failed, why) {
    if (receiverPlan !== failed || !failed.previous) return;
    clearTimeout(failed.pendingClockTimer);
    const previous = failed.previous;
    const svc = startReceivers();
    const target = svc.targets().find(t => t.id === failed.receiverId);
    const state = target && target.playback && target.playback.state;
    // A viewer can resume or pause while replacement startup is pending.
    if (state === 'playing' || state === 'paused') previous.autoplay = state === 'playing';
    const selectedSubtitle = typeof svc.subtitleSelection === 'function'
      ? svc.subtitleSelection(failed.receiverId, failed.mediaId, failed.epoch) : undefined;
    if (selectedSubtitle !== undefined) previous.subtitleTrackId = selectedSubtitle;
    const result = svc.play(previous.receiverId, { ...previous, startSec: previous.position || 0, forceReload: true });
    if (result.ok) {
      receiverPlan = previous; failed.transport.teardown();
      send('receiver-event', { type: 'track-load', receiverId: previous.receiverId, previousMediaId: failed.mediaId, mediaId: previous.mediaId });
    }
    send('receiver-event', { type: 'track-error', receiverId: previous.receiverId, why: result.ok ? why : 'Audio recovery failed; reconnect the receiver' });
  }

  // Experimental until the selected-audio transition is qualified with real torrent input.
  function switchReceiverAudio(receiverId, arg) {
    const owner = receiverPlan;
    const found = startReceivers().targets().find(t => t.id === receiverId);
    const playback = found && found.playback;
    if (!owner || owner.receiverId !== receiverId || owner.src !== mpvLastUrl || !owner.audioCatalog ||
        !arg || arg.mediaId !== owner.mediaId || (arg.epoch || null) !== (owner.epoch || null) || owner.epoch) {
      return Promise.resolve({ ok: false, why: 'Source audio selection is unavailable for this transport' });
    }
    if (owner.retirePrevious) return Promise.resolve({ ok: false, why: 'Wait for the previous audio change to finish loading' });
    const track = owner.audioCatalog.find(t => t.id === arg.trackId);
    if (!track) return Promise.resolve({ ok: false, why: 'Source audio track unavailable' });
    const index = Number(track.id.slice('source-audio-'.length));
    const seekPosition = Number.isFinite(arg.seekSec) && arg.seekSec >= 0 ? arg.seekSec : null;
    if (index === owner.selectedAudio && seekPosition === null) return Promise.resolve({ ok: true });
    const position = seekPosition !== null ? seekPosition : Number.isFinite(owner.position) ? owner.position : playback && playback.currentTime;
    if (!Number.isFinite(position) || position < 0) return Promise.resolve({ ok: false, why: 'Wait for a receiver playback position before switching audio' });
    const intent = retireReceiverIntent(), generation = loadGen, svc = startReceivers();
    const transport = typeof receiverTransportFor === 'function' ? receiverTransportFor() : require('./lanserver')({});
    return new Promise(resolve => {
      let finished = false, timer = null;
      const current = () => intent === receiverIntent && generation === loadGen && receiverPlan === owner && owner.src === mpvLastUrl;
      const finish = result => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (pendingReceiverOperation === cancel) pendingReceiverOperation = null;
        if (!result.ok) transport.teardown();
        send('receiver-event', { type: 'track-pending', receiverId, pending: false });
        resolve(result);
      };
      const cancel = () => finish({ ok: false, why: 'Audio selection superseded' });
      cancel.receiverId = receiverId; cancel.autoplay = owner.autoplay !== false; cancel.sourceAudio = true;
      pendingReceiverOperation = cancel;
      timer = setTimeout(() => finish({ ok: false, why: 'Audio preparation timed out; previous stream retained' }), 60000);
      send('receiver-event', { type: 'track-pending', receiverId, pending: true });
      let preparationAttempt = 0;
      const prepare = inputStart => {
        const attempt = ++preparationAttempt;
        transport.serveHls(owner.src, (url, subtitles, metadata) => {
          if (finished || attempt !== preparationAttempt) return;
          if (!current()) return cancel();
          if (!url && metadata && metadata.retryFromOrigin === true && inputStart > 0) return prepare(0);
          if (!url || !metadata) return finish({ ok: false, why: 'Audio preparation failed; previous stream retained' });
          // A fresh presentation identity rejects delayed reports/commands from the previous URL.
          const mediaId = require('crypto').randomBytes(8).toString('hex');
          const resumePosition = seekPosition !== null ? seekPosition : Number.isFinite(owner.position) ? owner.position : position;
          // Re-read selection at commit: the viewer may change subtitles or choose
          // Off while the replacement audio is being prepared.
          const currentPlayback = svc.targets().find(t => t.id === receiverId);
          const reported = currentPlayback && currentPlayback.playback && currentPlayback.playback.tracks;
          const selected = reported && reported.subtitles.find(t => t.selected);
          const subtitleTrackId = typeof svc.subtitleSelection === 'function'
            ? svc.subtitleSelection(receiverId, owner.mediaId, owner.epoch)
            : selected ? selected.id : 'off';
          const next = { ...owner, timelineOrigin: metadata.timelineOrigin, sourceDuration: metadata.sourceDuration, mediaId, url, epoch: null, transport, subtitles, previous: { ...owner, subtitleTrackId: subtitleTrackId },
            audioCatalog: metadata.audio, selectedAudio: index, position: resumePosition, audioStartPosition: resumePosition, autoplay: cancel.autoplay };
          const result = svc.play(receiverId, { ...next, startSec: resumePosition,
            subtitleTrackId: subtitleTrackId });
          if (!result.ok) return finish(result);
          receiverPlan = next;
          // Retain the previous producer until the replacement reports a usable playback clock.
          next.retirePrevious = () => {
            if (owner.transport === lan) lan.retireReceiverHls();
            else if (owner.transport) owner.transport.teardown();
          };
          next.pendingClockTimer = setTimeout(() => {
            if (receiverPlan === next && next.previous) rollbackReceiverAudio(next, 'New audio did not become ready; restoring previous stream');
          }, 30000);
          send('receiver-event', { type: 'track-load', receiverId, previousMediaId: owner.mediaId, mediaId });
          finish({ ok: true, mediaId });
        }, { caps: svc.profile(receiverId), sourceSelectedAudio: true, audioTrack: index,
          sideloadSubs: true, receiverSubtitles: true, extraSubs: externalSubs,
          receiverInputStartSec: inputStart,
          receiverSourceWaiting: () => receiverSourceWaiting(owner.src, generation),
          receiverStartSec: () => seekPosition !== null ? seekPosition : Number.isFinite(owner.position) ? owner.position : position });
      };
      try {
        prepare(require('./receiver-preparation-policy').receiverFeatures(process.env).nearAudio && svc.supportsLogicalTimeline && svc.supportsLogicalTimeline(receiverId) ? Math.max(0, position - 20) : 0);
      } catch (e) { finish({ ok: false, why: e.message || 'Audio preparation failed' }); }
    });
  }

  // A seek on a receiver, in LOGICAL film time. Inside the current epoch it is a plain seek to the
  // epoch-local position; outside it a new epoch is produced at that position and the receiver is
  // moved to the new transport — through svc.play, so shouldLoad decides the LOAD, as always.
  function seekReceiver(receiverId, logicalSec) {
    if (!Number.isFinite(logicalSec) || logicalSec < 0) return { ok: false, why: 'invalid seek position' };
    if (receiverPlan && receiverPlan.receiverId === receiverId && Number.isFinite(receiverPlan.timelineOrigin) && logicalSec < receiverPlan.timelineOrigin) {
      return switchReceiverAudio(receiverId, { mediaId: receiverPlan.mediaId, epoch: receiverPlan.epoch, trackId: 'source-audio-' + receiverPlan.selectedAudio, seekSec: logicalSec });
    }
    const intent = retireReceiverIntent(), generation = loadGen, owner = receiverPlan;
    const svc = startReceivers();
    const mediaLan = owner && owner.transport || lan;
    const ep = mediaLan.vodEpoch && mediaLan.vodEpoch();
    if (!ep || !ep.current || !receiverPlan || receiverPlan.receiverId !== receiverId) {
      return svc.command(receiverId, 'seek', logicalSec);
    }
    return new Promise((resolve) => {
      let finished = false, deadline = null, dispose = null, failed = false;
      const disposePreparation = () => {
        const owned = dispose; dispose = null;
        if (typeof owned === 'function') { try { owned(); } catch (e) {} }
      };
      const finish = (result) => {
        if (finished) return;
        finished = true;
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
        if (pendingReceiverOperation === cancel) pendingReceiverOperation = null;
        failed = !result.ok;
        if (failed) disposePreparation();
        resolve(result);
      };
      const cancel = () => finish({ ok: false, why: 'receiver seek superseded' });
      cancel.receiverId = receiverId;
      cancel.autoplay = owner.autoplay !== false;
      pendingReceiverOperation = cancel;
      deadline = setTimeout(() => finish({ ok: false, why: 'receiver seek preparation timed out' }), 60000);
      try {
        dispose = mediaLan.vodSeek(logicalSec, (r) => {
          if (finished) return;
          try {
            if (intent !== receiverIntent || generation !== loadGen || owner !== receiverPlan) {
              return cancel();
            }
            if (!r) return finish({ ok: false, why: 'the seek could not be planned' });
            if (r.kind === 'in-epoch') {
              if (!Number.isFinite(r.localSec) || r.localSec < 0) return finish({ ok: false, why: 'invalid receiver seek plan' });
              return finish(svc.command(receiverId, 'seek', r.localSec));
            }
            if (r.kind !== 'new-epoch') return finish({ ok: false, why: 'the seek plan is unsupported' });
            if (!validReceiverTransport(r.epoch, r.url, r.startSec)) return finish({ ok: false, why: 'invalid receiver transport plan' });
            console.log('[spritz] receiver seek to ' + logicalSec + 's: new transport ' + r.epoch +
              ' (first playable ' + r.firstPlayableSec + 's, lead-in ' + r.leadInSec + 's)');
            receiverPlan = Object.assign({}, receiverPlan, { epoch: r.epoch, url: r.url, autoplay: cancel.autoplay });
            finish(svc.play(receiverId, { mediaId: receiverPlan.mediaId, epoch: r.epoch, url: r.url, title: receiverPlan.title, startSec: r.startSec, autoplay: cancel.autoplay }));
          } catch (e) { finish({ ok: false, why: e.message || 'receiver seek preparation failed' }); }
        });
        if (finished && failed) disposePreparation();
      } catch (e) { finish({ ok: false, why: e.message || 'receiver seek preparation failed' }); }
    });
  }

  // The Spritz Receiver.
  //
  // Started once, from the application lifecycle, and given lanserver so its control channel shares
  // the media port through `upgrade` — one address for a television to find. The service owns the
  // trust store's path and lifecycle; the proven hub and registry are called, never edited.
  //
  // The store lives beside the rest of Spritz's state in userData, NOT in the repository and not in
  // a temp directory: it holds the credentials that authenticate televisions, and losing it means
  // re-pairing every screen in the house.
  function startReceivers() {
    if (receivers) return receivers;
    receivers = createReceiverService({
      storePath: path.join(app.getPath('userData'), 'receivers.json'),
      lan,
      onSelectTrack: (receiverId, arg) => switchReceiverAudio(receiverId, arg),
      onLog: (m) => { try { console.log('[spritz] ' + m); } catch (e) {} }
    });
    // The renderer is told about targets and pending pairings; it is never told a credential.
    receivers.on('targets', (list) => send('receiver-event', { type: 'targets', targets: presentTargets(list, receiverTimelineTransport().vodLogical, receiverTimelineTransport().vodSourceDuration) }));
    receivers.on('playback-stopped', ({ receiverId }) => retireReceiverRequest(receiverId));
    receivers.on('track-request-error', (e) => send('receiver-event', { type: 'track-error', ...e }));
    receivers.on('pairing', (pending) => send('receiver-event', { type: 'pairing', pending }));
    // A position is EPOCH-LOCAL as the television counts it. Translate to logical film time before
    // anyone downstream sees it, keeping the local reading beside it for the log.
    receivers.on('position', (p) => {
      if (!p || !Number.isFinite(p.currentTime) || p.currentTime < 0) return;
      let out = p;
      if (p.epoch) {
        const mediaLan = receiverTimelineTransport();
        if (typeof mediaLan.vodLogical !== 'function') return;
        out = presentTargets([{ playback: p }], mediaLan.vodLogical, mediaLan.vodSourceDuration)[0].playback;
        if (!Number.isFinite(out.currentTime) || out.currentTime < 0) return;
      }
      if (typeof receiverPlan !== 'undefined' && receiverPlan && p.receiverId === receiverPlan.receiverId &&
          p.mediaId === receiverPlan.mediaId && (p.epoch || null) === (receiverPlan.epoch || null) &&
          typeof p.paused === 'boolean') {
        // A finite clock alone does not prove that the replacement restored the film.
        // Keep the old producer and its resume point until arrival near the requested clock.
        const arrivalTarget = Number.isFinite(p.requestedTime) ? p.requestedTime : receiverPlan.audioStartPosition;
        if (receiverPlan.retirePrevious && (p.seeking || Math.abs(out.currentTime - arrivalTarget) >= 2)) return;
        receiverPlan.autoplay = !p.paused; receiverPlan.position = out.currentTime;
        if (pendingReceiverOperation && pendingReceiverOperation.sourceAudio && pendingReceiverOperation.receiverId === p.receiverId) pendingReceiverOperation.autoplay = !p.paused;
        if (receiverPlan.retirePrevious) { const retire = receiverPlan.retirePrevious; receiverPlan.retirePrevious = null; receiverPlan.previous = null;
          clearTimeout(receiverPlan.pendingClockTimer); receiverPlan.pendingClockTimer = null; retire(); }
      }
      send('receiver-event', { type: 'position', position: out });
    });
    receivers.on('playback-error', (e) => {
      const failed = receiverPlan;
      if (e.code === 'seek-outside-transport' && Number.isFinite(e.requestedTime) && e.requestedTime >= 0 && failed && failed.mediaId === e.mediaId && failed.receiverId === e.receiverId && (failed.epoch || null) === (e.epoch || null)) {
        Promise.resolve(switchReceiverAudio(e.receiverId, { mediaId: failed.mediaId, epoch: failed.epoch, trackId: 'source-audio-' + failed.selectedAudio, seekSec: e.requestedTime })).then(result => { if (!result.ok) send('receiver-event', { type: 'track-error', receiverId: e.receiverId, why: result.why }); }).catch(error => send('receiver-event', { type: 'track-error', receiverId: e.receiverId, why: error.message }));
        return;
      }
      if ((e.fatal || e.code === 'startup-position') && failed && failed.previous && failed.mediaId === e.mediaId && failed.receiverId === e.receiverId && (failed.epoch || null) === (e.epoch || null)) {
        rollbackReceiverAudio(failed, 'New audio failed; restoring previous stream');
      }
      send('receiver-event', { type: 'error', error: e });
    });
    receivers.start();
    return receivers;
  }

  app.whenReady().then(() => { buildMenu(); createMainWindow(); startReceivers(); const a = fromArgv(process.argv.slice(1)); if (a) openSource(a); });

  // Parse a local .m3u/.m3u8(non-HLS)/.pls playlist → ordered list of entries {url,title}.
  ipcMain.handle('playlist:parse', (_e, { path: p } = {}) => {
    try {
      // Capped: readFileSync on a renderer-named path will allocate whatever it is pointed at.
      // 4MB is far beyond any real .m3u/.pls — IPTV lists with tens of thousands of entries sit
      // well under it — and bounds the damage from being pointed at something enormous.
      const txt = readTextCapped(p, 4 * 1024 * 1024);
      if (txt === null) return null;
      const dir = path.dirname(p);
      const resolve = (e) => /^(https?|magnet|spritz):/i.test(e) ? e : (e.startsWith('/') ? e : path.join(dir, e));
      const out = [];
      if (/\.pls$/i.test(p)) {
        const files = {}, titles = {};
        txt.split(/\r?\n/).forEach((l) => {
          let m;
          if ((m = l.match(/^File(\d+)=(.+)$/i))) files[m[1]] = m[2].trim();
          else if ((m = l.match(/^Title(\d+)=(.+)$/i))) titles[m[1]] = m[2].trim();
        });
        Object.keys(files).sort((a, b) => +a - +b).forEach((k) => out.push({ url: resolve(files[k]), title: titles[k] || '' }));
      } else {
        let title = '';
        txt.split(/\r?\n/).forEach((l) => {
          l = l.trim();
          if (!l) return;
          if (/^#EXTINF:/i.test(l)) { title = l.replace(/^#EXTINF:[^,]*,/i, '').trim(); return; }
          if (l.startsWith('#')) return;
          out.push({ url: resolve(l), title }); title = '';
        });
      }
      return out;
    } catch (e) { return null; }
  });

  // Sibling video files in the same folder, natural-sorted — for "play next episode".
  ipcMain.handle('fs:siblings', (_e, { path: p } = {}) => {
    try {
      const dir = path.dirname(p), base = path.basename(p);
      const VID = /\.(mp4|mkv|webm|mov|avi|m4v|flv|ts|wmv|mpg|mpeg|ogv|m2ts)$/i;
      const list = fs.readdirSync(dir).filter((f) => VID.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      const i = list.indexOf(base);
      return { dir, files: list, index: i, next: i >= 0 && i < list.length - 1 ? path.join(dir, list[i + 1]) : null };
    } catch (e) { return null; }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    invalidateLoad();
    try { history.flush(); } catch (e) {}
    try { if (mpvAddon && mpvAddon.detach) mpvAddon.detach(); } catch (e) {}
    try { torrent.teardown(); } catch (e) {}
      try { lan.teardown(); } catch (e) {}
      try { cast.teardown(); } catch (e) {}
      try { dlna.teardown(); } catch (e) {}
  });

  // Tear down any active cast when the source changes — otherwise the TV keeps playing the OLD
  // media while mpv decodes the new file locally (double audio + a wedged renderer engine).
  function endCastsForNewSource() {
    if (castEngine === 'chromecast') { try { cast.stop(); } catch (e) {} send('cast-event', { type: 'stopped' }); }
    else if (castEngine === 'dlna') { try { dlna.stop(); } catch (e) {} stopDlnaPoll(); send('dlna-event', { type: 'stopped' }); }
    else if (castEngine === 'airplay') { try { if (apAddon) apAddon.stopAirplay(); } catch (e) {} } // external=false → renderer exitCasting
    cancelDrop(); // a pending AirPlay drop timer must not fire into the next source's state
    setEngine('mpv'); castMkv = null; // also clears a 'pending' handoff; its in-flight resolve cb bails on the loadGen bump
    try { lan.cancelActive(); } catch (e) {} // kill any orphan HLS/remux ffmpeg reading the old source
  }

  // ---- player control input (renderer → addon) ----
  // Browser-like UA helps sites that block non-browser clients; a Referer satisfies hotlink
  // protection. Set as mpv properties before loadfile (NOT in the comma-joined loadfile options,
  // which would clash with header commas). Reset for non-web sources so they don't leak across loads.
  const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  function applyHttpHeaders(url, referer) {
    const web = /^https?:\/\//i.test(url || '') && !/^http:\/\/(?:localhost|127\.0\.0\.1):/i.test(url || '');
    try {
      mpvAddon.setProperty('user-agent', web ? BROWSER_UA : '');
      mpvAddon.setProperty('referrer', web && referer ? String(referer) : '');
    } catch (e) {}
  }
  // Tune mpv's demuxer cache per source. A local file can be read instantly, so no big cache is
  // needed; but a torrent or web stream feeds bytes at network/peer speed. A 4K/HDR release is
  // ~25 Mbps — with the default tiny cache mpv keeps under-running and never reaches the buffer
  // it needs to START, so playback hangs on "buffering" forever. For HTTP(S) sources we open a
  // large cache and a generous read-ahead so mpv front-loads enough to begin and ride out dips.
  function applyStreamCache(url) {
    const stream = /^https?:\/\//i.test(url || ''); // torrent localhost + web both stream over HTTP
    try {
      mpvAddon.setProperty('cache', stream ? 'yes' : 'auto');
      if (stream) {
        mpvAddon.setProperty('cache-secs', 60);                // keep 60s of decoded-ahead in cache
        mpvAddon.setProperty('demuxer-max-bytes', 268435456);  // 256 MiB forward buffer (fits ~80s of 25 Mbps 4K)
        mpvAddon.setProperty('demuxer-max-back-bytes', 67108864); // 64 MiB back-buffer for instant small seeks
        mpvAddon.setProperty('demuxer-readahead-secs', 30);    // read 30s ahead of the play head
        mpvAddon.setProperty('network-timeout', 60);           // don't give up on a slow-feeding torrent server
        // NOTE: do NOT set cache-pause-initial=yes — for a slowly-fed torrent stream mpv's cache-duration
        // may never reach the threshold, so playback never un-pauses ("never starts"). mpv's default
        // cache-pause=yes already re-pauses + refills on an underrun, which is the behaviour we want.
      }
    } catch (e) {}
  }
  ipcMain.on('player:load', (_e, { url, start, referer } = {}) => {
    const gen = invalidateLoad();
    applyHttpHeaders(url, referer);
    applyStreamCache(url);
    endCastsForNewSource();
    externalSubs = []; // a new source drops any external subs the user attached to the previous one
    lastAvTime = 0;    // reset the shared cast resume-clock so a new source can't inherit the previous title's position
    lastCastPos = 0; lastPlayerState = null; pendingObservation = null;
    setCastable(null); // clear immediately so a cast tapped before resolution can't fire the OLD title
    // mpv 0.38+ loadfile signature: <url> [<flags> [<index> [<options>]]] — the
    // 'index' slot was inserted before 'options', so pass '-1' (default) or the
    // opts land in the index slot and the file silently fails to load.
    const isTorLoad = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i.test(url || '');
    if (isTorLoad && process.env.SPRITZ_DEBUG) { try { fs.appendFileSync('/tmp/spritz-torrent.log', '[' + new Date().toISOString().slice(11, 23) + '] player:load -> mpv loadfile ' + String(url).slice(0, 90) + '\n'); } catch (e) {} }
    try {
      mpvAddon.command('loadfile', url, 'replace', '-1', loadOpts(start));
      mpvLastUrl = url;
      if (mainWindow && url) {
        const base = decodeURIComponent(String(url).split('/').pop().split('?')[0] || '');
        if (base) { mainWindow.setTitle(base); lastCastTitle = base; }
      }
      // AirPlay-castable for https, torrent (via LAN IP), or local files (via LAN server).
      // Guard on loadGen: a slow resolution for a superseded source must NOT overwrite the
      // newer source's castUrl (cross-source contamination → cast plays the wrong title).
      // Torrents: the HLS remux can't produce a segment until enough is downloaded, so a
      // just-started torrent resolves to null. Retry as it buffers so the cast button appears.
      const isTor = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i.test(url || '');
      let tries = 0;
      const tryResolve = () => resolveCastable(url, (av, subs) => {
        if (gen !== loadGen || receiverPlan && receiverPlan.src === url) return;
        if (av) { setCastable(av, subs); return; }
        if (isTor && tries++ < 40) castResolveRetry = setTimeout(() => { castResolveRetry = null; if (gen === loadGen && !(receiverPlan && receiverPlan.src === url)) tryResolve(); }, 3000); // fast bounded retry (~2 min)
      });
      tryResolve();
    } catch (e) { console.error('[player:load]', e.message); }
  });
  // Defense-in-depth: the renderer drives mpv via these, but a COMPROMISED renderer must not be able
  // to turn mpv into an arbitrary-code / file-exfil primitive. These were deny lists; they are now
  // allow lists in src/main/mpv-guard.js, which explains why and is unit-tested. The deny lists had
  // real gaps — `log-file` and `dump-cache` write attacker-chosen paths, `load-config-file` reads
  // one — and enumerating the dangerous half of a several-hundred-name API never converges.
  ipcMain.on('player:setProperty', (_e, { name, value } = {}) => {
    try { if (mpvGuard.allowProperty(name)) mpvAddon.setProperty(name, value); } catch (e) {}
  });
  // backgroundThrottling was disabled for the whole session, so a backgrounded Spritz sitting on
  // the welcome screen kept its renderer running at full rate for no reason (timers, rAF, the
  // idle-fill GL path) — pure battery cost. Throttling MUST stay off while playing, or a
  // backgrounded window starves the UI that drives playback. So: off during playback, on otherwise.
  ipcMain.on('player:playbackActive', (_e, { active } = {}) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(!active);
    } catch (e) {}
  });
  ipcMain.on('player:command', (_e, { args } = {}) => {
    try { if (mpvGuard.allowCommand(args)) mpvAddon.command(...args); } catch (e) {}
  });
  ipcMain.handle('player:stat', () => { try { return mpvAddon.playerStat(); } catch (e) { return null; } });

  // ---- Anime4K / GLSL shader upscaling ----
  // libmpv opens these itself, so they must be real files (build.asarUnpack), not asar entries.
  const SHADER_DIR = require('./asar-path').unpackedPath(path.join(__dirname, '..', '..', 'vendor', 'shaders', 'anime4k'));
  const A4K_MODES = {
    A: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Restore_CNN_VL.glsl', 'Anime4K_Upscale_CNN_x2_VL.glsl', 'Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
    B: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Restore_CNN_Soft_VL.glsl', 'Anime4K_Upscale_CNN_x2_VL.glsl', 'Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
    C: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl', 'Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl']
  };
  // Motion interpolation (MEMC) — resample frames to the display rate to cut judder.
  ipcMain.on('player:setInterpolation', (_e, { on } = {}) => {
    try {
      mpvAddon.setProperty('video-sync', on ? 'display-resample' : 'audio');
      mpvAddon.setProperty('interpolation', !!on);
      if (on) mpvAddon.setProperty('tscale', 'oversample'); // low-ringing temporal scaler
      send('toast', { message: on ? 'Motion interpolation on' : 'Motion interpolation off' });
    } catch (e) { console.error('[interpolation]', e.message); }
  });

  ipcMain.on('player:setShaders', (_e, { mode } = {}) => {
    try {
      mpvAddon.command('change-list', 'glsl-shaders', 'clr', '');
      // Own-property lookup only: `mode` comes from the renderer, and a plain index would resolve
      // '__proto__' / 'constructor' to inherited values. Not exploitable here (only the hardcoded
      // filenames in A4K_MODES ever become paths) but it should not be a lookup that can leave
      // the object at all.
      const files = Object.prototype.hasOwnProperty.call(A4K_MODES, mode) ? A4K_MODES[mode] : null;
      if (files) files.forEach((f) => mpvAddon.command('change-list', 'glsl-shaders', 'append', path.join(SHADER_DIR, f)));
      // Informational, NOT fatal — must not go through player:notice, whose renderer handler
      // stops playback 2.4s later (that channel is for unrecoverable load errors). Use a toast,
      // same as setInterpolation above. This is why changing upscale mode killed playback.
      send('toast', { message: files ? ('Anime4K · Mode ' + mode) : 'Upscaling off' });
    } catch (e) { console.error('[shaders]', e.message); }
  });
  ipcMain.handle('player:mediaStats', () => { try { return mpvAddon.mediaStats(); } catch (e) { return null; } });

  // ---- stream-site URL → yt-dlp → mpv ----
  ipcMain.on('player:openSite', (_e, { url } = {}) => {
    if (!url) return;
    const gen = invalidateLoad();
    endCastsForNewSource();
    externalSubs = [];
    setCastable(null);
    resolveStream(url, (e, res) => {
      if (gen !== loadGen) return; // superseded by a newer load
      if (e || !res || !res.url) {
        send('player:notice', { message: 'Could not load stream: ' + (e ? e.message : 'no media') });
        return;
      }
      try {
        mpvAddon.command('loadfile', res.url, 'replace', '-1', loadOpts());
        mpvLastUrl = res.url;
        if (mainWindow && res.title) mainWindow.setTitle(res.title);
        // AirPlay needs an AVPlayer-friendly progressive MP4 (resolve separately, async)
        resolveAirplayUrl(url, (apUrl) => { if (apUrl && gen === loadGen) setCastable(apUrl); });
      } catch (err) { send('player:notice', { message: err.message }); }
    });
  });

  // ---- airplay ----
  ipcMain.on('airplay:showButton', (_e, { rect } = {}) => {
    try { if (apAddon && rect) apAddon.updatePickerRect(rect.x, rect.y, rect.w, rect.h, true); }
    catch (e) { console.error('[airplay:showButton]', e.message); }
  });
  ipcMain.on('airplay:hideButton', () => { try { if (apAddon) apAddon.updatePickerRect(0, 0, 0, 0, false); } catch (e) {} });
  ipcMain.on('airplay:play', () => { try { if (apAddon) apAddon.play(); } catch (e) {} });
  ipcMain.on('airplay:pause', () => { try { if (apAddon) apAddon.pause(); } catch (e) {} });
  ipcMain.on('airplay:seek', (_e, { t } = {}) => { try { if (apAddon) apAddon.seek(t); } catch (e) {} });
  ipcMain.on('airplay:setVolume', (_e, { f } = {}) => { try { if (apAddon) apAddon.setVolume(f); } catch (e) {} });
  ipcMain.on('airplay:stop', () => {
    try { if (apAddon) apAddon.stopAirplay(); } catch (e) {}
    // skipRearm: do NOT re-prepare immediately. Re-binding the picker to a fresh AVPlayer in the
    // same tick re-adopts the still-selected system route before it can drop — that's why the TV
    // stayed connected and the next cast played only locally. Let the route drop, then re-arm a
    // clean player after a delay so the next cast selects a FRESH route (fires externalPlaybackActive).
    resumeLocalFromAirplay(true);
    setTimeout(() => { try { if (apAddon && castUrl && castEngine === 'mpv') apAddon.prepare(castUrl, mpvPos()); } catch (e) {} }, 1800);
  });
  ipcMain.handle('airplay:stat', () => { try { return apAddon ? apAddon.stat() : null; } catch (e) { return null; } });
  ipcMain.handle('airplay:mediaTracks', () => { try { return apAddon ? apAddon.mediaTracks() : null; } catch (e) { return null; } });
  ipcMain.on('airplay:selectMedia', (_e, { kind, index } = {}) => {
    // Switch the casting AVPlayer's audio/subtitle rendition via AVMediaSelectionGroup — the native,
    // supported path for HLS alternate renditions, and (unlike the old apAddon.reloadItem, which was
    // never exported by the addon and silently threw) one that actually exists. Works without a
    // reload, so the AirPlay route stays connected. kind='audio'|'subs'; index<0 = subtitles off.
    try { if (apAddon) apAddon.selectMedia(kind, index); } catch (e) {}
  });

  // ---- Google Cast (Chromecast / LG webOS) ----
  ipcMain.on('cast:discover', () => { try { cast.startDiscovery(); } catch (e) {} });
  // User-entered TV addresses, probed in addition to normal discovery. Also handed to the DLNA
  // side, since a TV that hides from one discovery protocol usually hides from both.
  ipcMain.on('cast:manualHosts', (_e, { csv } = {}) => {
    try { cast.setManualHosts(csv); } catch (e) {}
    try { dlna.setManualHosts(csv); } catch (e) {}
  });
  ipcMain.on('cast:load', (_e, { host } = {}) => {
    if (!host) { send('cast-event', { type: 'error', message: 'No TV selected.' }); return; }
    // Start from what discovery believes, then add what this receiver has actually been seen to
    // play. A device that demonstrably decoded 4K HEVC HDR should not be re-guessed as 1080p-only
    // because a later probe was less informative — that is the whole point of ranking capabilities
    // by where they came from. Widening only, and a user override still wins.
    const discovered = cast.capsFor(host);
    const caps = deviceMemory.profileFor(deviceMemory.keyFor({ id: discovered && discovered.id, label: discovered && discovered.label, host }), discovered);
    const gen = loadGen;
    const wasCasting = isCasting(); // coming from another cast → mpv is already stopped (resume on failure)
    captureTracks(); // capture language/subtitle from mpv while it may still be live (no-op if already casting)
    beginCast();     // synchronously claim the engine ('pending') + tear down any current cast (Audit M4)
    // Remote (stream-site https) → cast the already-resolved URL as-is (no local transcode applies).
    if (/^https:\/\//i.test(mpvLastUrl || '')) {
      if (!castUrl) return castFailedLocal(wasCasting, 'cast-event', 'This source can’t be cast (needs an MP4/WebM the TV can play).');
      return doCastLoad(host, castUrl, castSubs, gen, null);
    }
    // Local/torrent → the single-MKV transport (the proven progressive Cast path): one progressive
    // Matroska stream, video copy for non-4K H.264, the user's CURRENT audio language muxed in, subs
    // sideloaded as WebVTT TEXT tracks. Far more reliable on the LG receiver than the old live-HLS.
    const aTrack = savedAid ? Math.max(0, parseInt(savedAid, 10) - 1) : 0; // cast the language the user was watching
    const startSec = mpvPos() || lastAvTime || 0;
    resolveChromecast(mpvLastUrl, caps, aTrack, startSec, (av, meta) => {
      if (gen !== loadGen) { setEngine('mpv'); return; } // source changed while resolving (player:load handles mpv)
      if (!av) return castFailedLocal(wasCasting, 'cast-event', 'This source can’t be cast to this TV.');
      castRecoveries = castRecovery.fresh(); // a new cast gets a fresh budget
      castMkv = (meta && meta.isMkv) ? { host, direct: !!(meta && meta.direct), input: meta.input, caps: meta.caps, audioTracks: meta.audioTracks, dur: meta.dur, audioTrack: meta.audioTrack, burnSub: null, subDelay: 0, menuSubs: meta.menuSubs || [], subPick: -1 } : null;
      doCastLoad(host, av, (meta && meta.subs) || [], gen, { startSec, audioTracks: (meta && meta.audioTracks) || [], audioTrack: (meta && meta.audioTrack) || 0, menuSubs: (meta && meta.menuSubs) || [], sent: (meta && meta.sent) || null, deviceLabel: (meta && meta.caps && meta.caps.label) || null, deviceId: (meta && meta.caps && meta.caps.id) || null });
    });
  });
  function doCastLoad(host, url, subs, gen, info) {
    if (gen == null) gen = loadGen;
    if (!url || gen !== loadGen) { setEngine('mpv'); if (!url) send('cast-event', { type: 'error', message: 'This source can’t be cast (needs an MP4/WebM the TV can play).' }); return; }
    // The MKV transport bakes the start position into the stream (the server seeks before it streams) and
    // cast.js tells the receiver 0; the status handler adds the stream's origin back. A direct cast
    // uses the live mpv position.
    const pos = info && typeof info.startSec === 'number' ? info.startSec : (mpvPos() || lastAvTime);
    try { mpvAddon.command('stop'); } catch (e) {} // hand off from local playback (AirPlay already dropped by beginCast)
    setEngine('chromecast');
    // A /mkv/ URL carries no extension, so ctypeFor() fell through to a plain video/mp4 guess that
    // happened to disagree with what the server sent. Ask the server what it is actually serving.
    const isLivePipe = !!castMkv && /\/mkv\//.test(String(url || ''));
    // Arm the observation. It stays pending — and is recorded only if the receiver actually gets
    // somewhere in the stream.
    const devLabel = (info && info.deviceLabel) || (castMkv && castMkv.caps && castMkv.caps.label) || null;
    const obsKey = deviceMemory.keyFor({ id: (info && info.deviceId) || null, label: devLabel, host });
    pendingObservation = (obsKey && info && info.sent)
      ? { key: obsKey, from: pos || 0, traits: Object.assign({ label: devLabel }, info.sent) }
      : null;
    subGuard.begin(); // the receiver reports its own default selection while the first LOAD settles
    cast.load(host, { url, title: lastCastTitle, contentType: isLivePipe ? lan.castMime() : ctypeFor(url), livePipe: isLivePipe, currentTime: pos, subs: subs || [] }, (err) => {
      // The source changed (or a cast was cancelled) during the ~12s handshake → don't resurrect. (Audit M3)
      subGuard.end(4000);
      if (gen !== loadGen) { pendingObservation = null; try { cast.stop(); } catch (e) {} setEngine('mpv'); return; }
      if (err) {
        if (err.detailedErrorCode) console.error('[cast] LOAD failed, detailedErrorCode=' + err.detailedErrorCode + ' (104=container/codec unsupported, e.g. a real Chromecast rejecting MKV)');
        // Recorded as context only. What a refusal does NOT tell us is which of the stream's
        // properties was unacceptable, so it must not narrow anything (see device-memory.js).
        if (obsKey) deviceMemory.noteFailure(obsKey, Object.assign({ at: Date.now() }, (info && info.sent) || {}), err.message);
        pendingObservation = null;
        resumeLocalFromChromecast(); send('cast-event', { type: 'error', message: err.message });
      }
      else send('cast-event', { type: 'started', host, audioTracks: (info && info.audioTracks) || [], audioActive: (info && info.audioTrack) || 0, isMkv: !!castMkv, subTracks: (info && info.menuSubs) || [], burnActive: null });
    });
  }
  // Re-cast the MKV transport at a new position and/or audio track — the old app's mechanism for a seek
  // or an audio-language change on a single-stream cast (the receiver can't seek a non-seekable stream
  // or switch a not-muxed track, so we hand it a fresh stream from the right point). Same host/session.
  // burnSub: undefined = keep the current burned-in bitmap sub; a number = burn that 0:s index;
  // -1/null = no burn. cb runs after the fresh cast loads (used to apply a text sub after un-burning).
  function recastMkv(startSec, audioTrack, burnSub, cb) {
    if (!castMkv || castEngine !== 'chromecast') return;
    // connectedHost is null right after a reconnect's teardownClient() → fall back to the host captured
    // at cast-load time so a Wi-Fi-blip re-cast can still find the TV.
    const host = (cast.connectedHost && cast.connectedHost()) || castMkv.host;
    if (!host) return;
    // Shut for the rebuild and a few seconds after: the receiver reports an empty track list during the
    // new LOAD and the previous selection just after setTrack, neither of which is a choice the viewer made.
    subGuard.begin();
    const gen = loadGen;
    const at = (typeof audioTrack === 'number') ? audioTrack : castMkv.audioTrack;
    const bs = (burnSub === undefined) ? castMkv.burnSub : burnSub;
    lan.serveMkv(castMkv.input, { caps: castMkv.caps, extraSubs: externalSubs, audioTrack: at, startSec: Math.max(0, startSec || 0), burnSub: bs, subDelay: castMkv.subDelay || 0, subPick: (castMkv.subPick != null ? castMkv.subPick : -1) }, (u, sideloadSubs, audioTracks, aTrack, dur, menuSubs) => {
      if (gen !== loadGen || castEngine !== 'chromecast' || !u) { subGuard.end(0); return; }
      castMkv.audioTrack = aTrack; castMkv.burnSub = (bs != null && bs >= 0) ? bs : null; castMkv.menuSubs = menuSubs || [];
      cast.load(host, { url: u, title: lastCastTitle, contentType: lan.castMime(), livePipe: true, currentTime: Math.max(0, startSec || 0), subs: sideloadSubs || [] }, (err) => {
        if (err) { subGuard.end(0); send('cast-event', { type: 'error', message: err.message }); return; }
        send('cast-event', { type: 'started', host, audioTracks: audioTracks || [], audioActive: aTrack, isMkv: true, subTracks: menuSubs || [], burnActive: castMkv.burnSub });
        if (cb) cb();
        subGuard.end(4000); // after cb: setTrack's echo arrives a moment later
      });
    });
  }
  // Re-establish a cast whose stream died under it. Deliberately narrow: only while a Chromecast
  // session is genuinely still live, only when the receiver has not said the film finished, and
  // bounded — a source that cannot be streamed must be allowed to fail rather than loop.
  function recoverCast(why) {
    if (castEngine !== 'chromecast' || !castMkv) return;
    // A RATE limit, not a lifetime one. The budget exists to stop a loop, and a loop is dense in
    // time; a film that drops once every twenty minutes and recovers each time is not looping. The
    // old lifetime count ended a 63-minute episode four minutes in, after three recoveries that had
    // all worked. Survive the window and the attempts are forgiven — surviving is the evidence.
    const decision = castRecovery.allowRecovery(castRecoveries, Date.now());
    if (!decision.allow) {
      castLog('not recovering: ' + decision.reason);
      send('cast-event', { type: 'error', message: 'The cast stopped and could not be resumed.' });
      return;
    }
    const at = lastCastPos || lastAvTime || 0;
    castRecoveries = decision.state;
    castLog('recovering the cast (' + why + ') from ' + Math.round(at) + 's — ' + decision.reason);
    // A moment's grace: the receiver has just closed a socket, and re-offering it a stream in the
    // same tick tends to be refused.
    //
    // Then check again before acting. Receivers frequently re-request the URL themselves, and the
    // server restarts it from the right position without help — observed at 16:43:28, where the
    // re-GET was already serving 60ms later and this recast arrived 1.2s after that, tore down a
    // working stream and cost an extra IDLE/BUFFERING bounce. If something is already flowing, the
    // cast recovered on its own and the best thing to do is nothing.
    setTimeout(() => {
      if (castEngine !== 'chromecast' || !castMkv) return;
      if (lan.hasLiveCastStream()) {
        castRecoveries = castRecovery.refund(castRecoveries); // it healed itself; don't spend an attempt
        castLog('recovery not needed — the receiver re-requested the stream itself');
        return;
      }
      recastMkv(at, castMkv.audioTrack);
    }, 1200);
  }

  ipcMain.on('cast:play', () => { try { cast.play(); } catch (e) {} });
  ipcMain.on('cast:pause', () => { try { cast.pause(); } catch (e) {} });
  // A single MKV-cast "seek" is a whole re-cast: fresh ffmpeg + a receiver LOAD. Dragging the
  // scrubber emits a stream of them, so without coalescing every intermediate value spawns a
  // transcode that's abandoned milliseconds later. Debounce to the final target; the native
  // (non-MKV) seek is a cheap protocol message and stays immediate. recastMkv() re-checks
  // castMkv/castEngine itself, so a timer that fires after casting stopped is a no-op.
  let seekTimer = null, seekTarget = 0;
  ipcMain.on('cast:seek', (_e, { t } = {}) => {
    // A direct file cast is seekable at the receiver: it just asks for a different byte range. Only
    // the live pipe has to be rebuilt to move, and rebuilding a seekable one would be strictly worse
    // — a visible stall in place of an instant jump.
    if (castMkv && castMkv.direct && castEngine === 'chromecast') { try { cast.seek(t); } catch (e) {} return; }
    if (castMkv && castEngine === 'chromecast') {
      seekTarget = t;
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => { seekTimer = null; recastMkv(seekTarget, castMkv && castMkv.audioTrack); }, 400);
      return;
    }
    try { cast.seek(t); } catch (e) {}
  });
  ipcMain.on('cast:setVolume', (_e, { f } = {}) => { try { cast.setVolume(f); } catch (e) {} });
  ipcMain.on('cast:setSourceAudio', (_e, { idx } = {}) => { // MKV audio-language change → re-cast at current pos (keep burn)
    if (castMkv && castEngine === 'chromecast') recastMkv(lastCastPos || lastAvTime || 0, Math.max(0, parseInt(idx, 10) || 0));
  });
  ipcMain.on('cast:setBurnSub', (_e, { subIdx } = {}) => { // burn a bitmap sub in (subIdx>=0) or off (-1) → re-cast
    if (castMkv && castEngine === 'chromecast') recastMkv(lastCastPos || lastAvTime || 0, castMkv.audioTrack, (subIdx >= 0 ? subIdx : -1));
  });
  ipcMain.on('cast:subDelay', (_e, { delta } = {}) => { // MKV cast subtitle sync: shift the sideloaded VTT cues → re-cast
    if (!castMkv || castEngine !== 'chromecast') return;
    castMkv.subDelay = Math.round(((castMkv.subDelay || 0) + (parseFloat(delta) || 0)) * 10) / 10; // 0.1s precision
    recastMkv(lastCastPos || lastAvTime || 0, castMkv.audioTrack);
  });
  ipcMain.on('cast:stop', () => { resumeLocalFromChromecast(); send('cast-event', { type: 'stopped' }); });
  ipcMain.handle('cast:mediaTracks', () => { try { return cast.tracks(); } catch (e) { return null; } });
  ipcMain.on('cast:selectTrack', (_e, { kind, id } = {}) => {
    // Switching to a TEXT sub (or off) while a bitmap sub is BURNED IN → un-burn first (re-cast without
    // overlay), then apply the sideloaded text track on the fresh cast. Otherwise toggle live.
    if (castMkv && castEngine === 'chromecast' && kind === 'subs' && castMkv.burnSub != null) {
      return recastMkv(lastCastPos || lastAvTime || 0, castMkv.audioTrack, -1, () => { if (id >= 0) { try { cast.setTrack('subs', id); } catch (e) {} } });
    }
    // A sideloaded text track is a STUB until it is the selected one — every track but the pick
    // answers empty, so that eight minutes of ffmpeg is not spent extracting tracks nobody chose.
    // Choosing one therefore has to re-cast: the receiver read the stub at LOAD and will not fetch
    // that URL again, and EDIT_TRACKS_INFO cannot hand it a different one. Same shape as changing the
    // audio language, which has always re-cast. Toggling OFF (-1) needs no extraction, so it stays
    // live — and re-selecting a track already extracted costs nothing, because it is still cached.
    if (castMkv && castEngine === 'chromecast' && kind === 'subs' && id >= 0) {
      const pick = id - 1000;                       // cast.js assigns trackId 1000+i in offer order
      if (pick >= 0 && pick !== castMkv.subPick) {
        castMkv.subPick = pick;
        return recastMkv(lastCastPos || lastAvTime || 0, castMkv.audioTrack, castMkv.burnSub,
          () => { try { cast.setTrack('subs', id); } catch (e) {} });
      }
    }
    if (castMkv && castEngine === 'chromecast' && kind === 'subs' && id < 0) castMkv.subPick = -1;
    try { cast.setTrack(kind, id); } catch (e) {}
  });

  // ---- torrent ----
  ipcMain.on('torrent:add', (_e, { src } = {}) => { if (src) torrent.add(src); });
  ipcMain.on('torrent:selectFile', (_e, { index } = {}) => torrent.selectFile(index));
  ipcMain.on('torrent:cancel', () => {
    // NOT while a cast is live. This fires when the renderer returns to the home screen, and handing
    // off to AirPlay stops mpv — which the renderer reads as "playback ended" and goes home. So the
    // act of starting a cast asked us to destroy the stream feeding it. Measured: session 874dbe7c
    // was prepared, loaded (status=1), handed off, and demolished in the same breath —
    // "GET /hls 404: STALE TOKEN 874dbe7c (current is none)", then -16839 as the receiver starved.
    // The first cast of a session escaped it only because the renderer knew it was casting by then.
    //
    // Keeping the torrent and its stream alive while something is actually watching them is the whole
    // point; teardown still happens on cast:stop, on a source change, and on quit.
    if (isCasting()) { castLog('torrent:cancel ignored — ' + castEngine + ' is casting from this source'); return; }
    invalidateLoad(); // invalidate late resolver success and retries before disposing their source
    setCastable(null);
    try { lan.cancelActive(); } catch (e) {}
    torrent.cancel();
  });

  // ---- dialogs / window / power (renderer → main) ----
  ipcMain.handle('dialog:openFile', async (_e, opts) => {
    if (!mainWindow) return { canceled: true, filePaths: [] };
    const res = await dialog.showOpenDialog(mainWindow, opts || {});
    return { canceled: res.canceled, filePaths: res.filePaths };
  });
  ipcMain.on('window:toggleFullScreen', () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); });
  ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  // Float-on-top + mini-player (compact always-on-top window)
  let onTop = false, mini = false, prevBounds = null;
  function setFloat(v) { onTop = v; if (mainWindow) mainWindow.setAlwaysOnTop(v, 'floating'); send('window-state', { onTop, mini }); }
  ipcMain.on('window:toggleFloat', () => setFloat(!onTop));
  ipcMain.on('window:toggleMini', () => {
    if (!mainWindow) return;
    if (!mini) { prevBounds = mainWindow.getBounds(); mainWindow.setSize(480, 270, true); setFloat(true); mini = true; }
    else { if (prevBounds) mainWindow.setBounds(prevBounds); setFloat(false); mini = false; }
    send('window-state', { onTop, mini });
  });
  ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });
  // manual window dragging (-webkit-app-region is unreliable on the transparent window)
  let dragOrigin = null;
  ipcMain.on('window:beginDrag', () => { if (mainWindow) dragOrigin = mainWindow.getPosition(); });
  ipcMain.on('window:dragTo', (_e, { dx, dy } = {}) => {
    if (mainWindow && dragOrigin) mainWindow.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
  });
  ipcMain.on('window:setTitle', (_e, { title } = {}) => { if (mainWindow && title != null) mainWindow.setTitle(title); });
  ipcMain.on('power:block', () => { if (psbId < 0) psbId = powerSaveBlocker.start('prevent-display-sleep'); });
  ipcMain.on('power:unblock', () => { if (psbId >= 0) { powerSaveBlocker.stop(psbId); psbId = -1; } });

  ipcMain.handle('app:getVersions', () => ({
    app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, arch: process.arch
  }));
}
