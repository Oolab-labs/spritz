'use strict';

// Spritz — modern Electron media player, main process (arm64).
// Owns the native libmpv addon (it needs getNativeWindowHandle, which is main-only)
// and bridges it to the renderer over IPC:
//   renderer control input → IPC → main → addon (command/setProperty/loadfile)
//   addon events (TSFN)      → main → IPC('player-event') → renderer

const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Safety net: the main process continuously parses UNTRUSTED LAN input (mDNS/SSDP/DLNA/cast
// packets). A single malformed packet that throws deep in a 3rd-party parser would otherwise put
// up Electron's "A JavaScript error occurred in the main process" dialog and kill playback. Log
// and keep running instead — a stray network packet must never crash the player. (Real bugs still
// surface in the console.) Handlers are still expected to guard their own hot paths.
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', e && e.stack || e); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e && e.stack || e); } catch (_) {} });

// External helper binaries (yt-dlp/ffmpeg/ffprobe/whisper). A GUI app's PATH won't find
// Homebrew bins, and a *packaged* app should prefer its own bundled copies (Resources/bin)
// so it's portable. Probe bundled-first, then Homebrew/system, then bare name.
function binPath(name) {
  const bundled = process.resourcesPath ? [require('path').join(process.resourcesPath, 'bin', name)] : [];
  return bundled.concat(['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name])
    .find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || name;
}
const YTDLP = binPath('yt-dlp');
const FFMPEG = binPath('ffmpeg');

// Argument-injection guards. No shell is used, so the danger is the argument VECTOR itself:
// a value beginning with '-' is parsed by yt-dlp/ffmpeg as an OPTION (yt-dlp --exec, ffmpeg
// input flags — cf. Jellyfin GHSA-866x-wj5j-2vf4), not as a URL/path. Untrusted page URLs go
// after a '--' end-of-options separator and must be http(s); ffmpeg -i inputs get a leading
// '-' neutralized with './'. (Audit — yt-dlp/ffmpeg argument injection.)
function isHttpUrl(s) { try { const p = new URL(String(s)).protocol; return p === 'http:' || p === 'https:'; } catch (_) { return false; } }
function ffInput(s) { s = String(s); return (isHttpUrl(s) || !s.startsWith('-')) ? s : './' + s; }

function resolveStream(pageUrl, cb) {
  if (!isHttpUrl(pageUrl)) return cb(new Error('not a valid http(s) URL'), null);
  let out = '', err = '';
  const ps = spawn(YTDLP, ['-f', 'best', '--no-playlist', '--get-title', '-g', '--', pageUrl], { timeout: 35000 });
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
}

// Resolve a progressive H.264 MP4 for the AirPlay path — AVPlayer often can't play
// yt-dlp's default HLS/DASH for sites, but a single combined MP4 (YouTube itag 22/18) works.
function resolveAirplayUrl(pageUrl, cb) {
  if (!isHttpUrl(pageUrl)) return cb(null);
  let out = '';
  const ps = spawn(YTDLP, ['-f', '22/18/b[ext=mp4][acodec!=none]/b[ext=mp4]', '--no-playlist', '-g', '--', pageUrl], { timeout: 35000 });
  ps.stdout.on('data', (d) => { out += d; });
  ps.on('error', () => cb(null));
  ps.on('close', () => cb(out.trim().split('\n').map((s) => s.trim()).find((l) => /^https?:\/\//i.test(l)) || null));
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
  let pickerAttached = false, lastAvTime = 0;
  let castSubs = [];        // sideloaded WebVTT text tracks for the current castUrl (HLS casts)
  let externalSubs = [];    // user-added external .srt/.ass files for the current source (carried into casts)
  let loadGen = 0;          // bumped each player:load — async castable resolution checks it (no stale-URL cast)
  // Default receiver profile for the PRE-RESOLVED AirPlay URL (the target isn't known until the user
  // picks a route). Conservative video (downscale 4K — a webOS AirPlay-2 receiver may cap at 1080p)
  // but AC3/EAC3 passthrough (AVPlayer/AirPlay-2 handle Dolby). The Chromecast path re-resolves with
  // the actual device's negotiated caps (cast.capsFor) for full 4K HEVC/HDR when supported.
  // AirPlay-2 to a TV reliably plays only H.264 + SDR — HEVC/HDR10 over AirPlay makes the LG enter AirPlay
  // mode but never play the video. So force H.264 SDR (hevc:false, hdr10:false) → videoArgs transcodes a
  // 4K HEVC/HDR source to 1080p H.264 SDR, which AVPlayer/the TV actually decode. (Was hevc/hdr10 true →
  // 1080p HEVC HDR10 output = "enters mode, never plays". Matches the proven pre-session AirPlay behaviour.)
  const AIRPLAY_CAPS = { hevc: false, hevc4k: false, h264_4k: false, hdr10: false, dovi: false, audioCopy: ['aac', 'mp3', 'alac', 'ac3', 'eac3'], maxHeight: 1080 };
  const mpvPos = () => { try { return (mpvAddon.playerStat().timePos) || 0; } catch (e) { return 0; } };
  const mpvDur = () => { try { return (mpvAddon.playerStat().duration) || 0; } catch (e) { return 0; } };

  // ---- single cast-engine state machine (replaces the casting/chromecasting/dlnacasting booleans) ----
  // One authoritative value so two engines can never co-target the TV. 'pending' is set SYNCHRONOUSLY
  // at the point of user intent (before the multi-second resolve) — that's what closes the races the
  // three independent, post-resolve booleans left open. (Audit M4.)
  let castEngine = 'mpv'; // 'mpv' | 'pending' | 'airplay' | 'chromecast' | 'dlna'
  const isCasting = () => castEngine === 'airplay' || castEngine === 'chromecast' || castEngine === 'dlna';
  // Tear down whatever is currently casting, then enter 'pending' for the new kind. Called at intent,
  // synchronously, so a concurrent AirPlay-engage / other cast sees "busy" and backs off.
  function beginCast() {
    if (castEngine === 'airplay') { try { if (apAddon) apAddon.stopAirplay(); } catch (e) {} }
    else if (castEngine === 'chromecast') { try { cast.stop(); } catch (e) {} }
    else if (castEngine === 'dlna') { try { dlna.stop(); } catch (e) {} stopDlnaPoll(); }
    castMkv = null;
    castEngine = 'pending';
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
        apAddon.prepare(castUrl, mpvPos()); console.log('[airplay] prepared AVPlayer with', String(castUrl).slice(0, 70));
      }
    } catch (e) { console.error('[airplay] prepare err', e.message); }
    send('airplay-event', { type: 'castable', castable: !!castUrl });
  }
  function resumeLocalFromAirplay(skipRearm) {
    castEngine = 'mpv';
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
    castEngine = 'mpv';
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
    mainWindow = new BrowserWindow({
      width: 950,
      height: 560,
      minWidth: 480,
      minHeight: 320,
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
        sandbox: false,
        backgroundThrottling: false
      }
    });

    // Navigation hardening (Electron security checklist). The renderer is a local
    // file:// app; it must never navigate the top frame to a remote origin or open
    // new windows. Without this, a DOM-injection foothold (untrusted page titles,
    // OpenSubtitles filenames, M3U/PLS entries, LAN device names) could escape the
    // local-only CSP. Parse with URL() — string prefix checks are bypassable.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (e, url) => {
      let proto = null;
      try { proto = new URL(url).protocol; } catch (_) {}
      if (proto !== 'file:') e.preventDefault();
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      attachPlayer();
    });

    // OS fullscreen → renderer (KEEP these channel names; the renderer swaps the
    // fullscreen icon + re-arms control auto-hide on them).
    mainWindow.on('enter-full-screen', () => send('enter-full-screen'));
    mainWindow.on('leave-full-screen', () => send('leave-full-screen'));

    mainWindow.on('closed', () => {
      try { if (mpvAddon && mpvAddon.detach) mpvAddon.detach(); } catch (e) {}
      try { torrent.teardown(); } catch (e) {}
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
  const torrent = require('./torrent')(send);
  const lan = require('./lanserver')({ onWarn: (m) => send('toast', { message: m }) }); // LAN file server for local-file AirPlay
  const cast = require('./cast')();     // Google Cast (Chromecast / LG webOS)
  const dlna = require('./dlna')();     // DLNA / UPnP "play to"
  const history = require('./history')(); // resume positions / recents

  // ---- DLNA / UPnP casting (parallel to Chromecast) ----
  let dlnaPoll = null;
  dlna.on('devices', (devices) => send('dlna-event', { type: 'devices', devices }));
  dlna.on('error', (e) => send('dlna-event', { type: 'error', message: e.message }));
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
        dlna.position((p) => { if (p && castEngine === 'dlna') { lastAvTime = p.cur || lastAvTime; send('dlna-event', { type: 'status', cur: p.cur, dur: p.dur }); } });
        dlna.transportState((s) => {
          if (!s || castEngine !== 'dlna') return;
          if (s !== 'STOPPED' && s !== 'NO_MEDIA_PRESENT') sawPlaying = true; // PLAYING / TRANSITIONING / PAUSED_PLAYBACK
          else if (s === 'STOPPED' && sawPlaying) { resumeLocalFromDlna(); send('dlna-event', { type: 'stopped' }); }
        });
      } catch (e) {}
    }, 1000);
  }
  function resumeLocalFromDlna() {
    castEngine = 'mpv'; stopDlnaPoll();
    try { dlna.stop(); } catch (e) {}
    if (mpvLastUrl) { try { mpvAddon.command('loadfile', mpvLastUrl, 'replace', '-1', loadOpts(lastAvTime, true)); } catch (e) {} }
    // NO rearmAirplay: DLNA serves the original file via its own slot and never touched the AirPlay
    // HLS slot, so castUrl/AVPlayer are still validly bound to the live pre-resolved HLS. Re-resolving
    // would cancelHls() that live slot and rebuild async, leaving a window where engaging AirPlay 404s.
  }
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
      if (gen !== loadGen) { castEngine = 'mpv'; return; } // source changed mid-resolve (player:load handles mpv)
      if (!durl) return castFailedLocal(wasCasting, 'dlna-event', 'This source can’t be cast to a DLNA TV (a still-downloading torrent isn’t a complete file DLNA can play — try AirPlay).');
      // Advertise any user-added external subtitle as a sidecar the TV loads (SRT; ASS/VTT converted).
      // Embedded subs need nothing — the LG reads them from the untouched original file itself.
      const go = (subUrl) => {
        if (gen !== loadGen) { castEngine = 'mpv'; return; }
        try { mpvAddon.command('stop'); } catch (e) {}
        castEngine = 'dlna';
        dlna.load(location, { url: durl, title: lastCastTitle, contentType: dlnaContentType(durl), subtitleUrl: subUrl, size: mediaSize, duration: mediaDur }, (err) => {
          if (gen !== loadGen) { try { dlna.stop(); } catch (e) {} castEngine = 'mpv'; return; } // superseded during load
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
    for (const n of ['whisper-cli', 'whisper-cpp']) { const p = binPath(n); if (p !== n) return p; }
    return null;
  }
  function whisperModel() {
    const m = process.env.WHISPER_MODEL || path.join(app.getPath('userData'), 'models', 'ggml-base.en.bin');
    return fs.existsSync(m) ? m : null;
  }
  ipcMain.handle('subtitle:generate', async (_e, { src } = {}) => {
    const bin = whisperBin(), model = whisperModel();
    if (!src) return { ok: false, error: 'No media loaded' };
    if (!bin) return { ok: false, error: 'Whisper not found — install with: brew install whisper-cpp' };
    if (!model) return { ok: false, error: 'No Whisper model — put ggml-base.en.bin in app models folder' };
    const base = path.join(app.getPath('temp'), 'spritz-whisper-' + Date.now());
    const wav = base + '.wav';
    try {
      send('toast', { message: 'Extracting audio for subtitles…' });
      await run(FFMPEG, ['-y', '-i', ffInput(src), '-ar', '16000', '-ac', '1', '-f', 'wav', wav], 300000); // 5 min
      send('toast', { message: 'Transcribing with Whisper…' });
      await run(bin, ['-m', model, '-f', wav, '-osrt', '-of', base], 1800000); // 30 min cap
      try { fs.unlinkSync(wav); } catch (e) {}
      if (fs.existsSync(base + '.srt')) { send('toast', { message: 'Subtitles ready ✓' }); return { ok: true, srt: base + '.srt' }; }
      return { ok: false, error: 'No subtitles produced' };
    } catch (e) { try { fs.unlinkSync(wav); } catch (_) {} return { ok: false, error: e.message }; }
  });
  function run(cmd, args, timeout) { return new Promise((res, rej) => { const p = spawn(cmd, args, { timeout: timeout || 0 }); p.stderr.on('data', () => {}); p.on('error', rej); p.on('close', (c) => c === 0 ? res() : rej(new Error(path.basename(cmd) + (c === null ? ' timed out' : ' failed')))); }); }

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
    if (!src || !/^\//.test(src)) return { ok: false, error: 'Online subtitles need a local file' };
    let h; try { h = osHash(src); } catch (e) { return { ok: false, error: 'Could not read file' }; }
    if (!h) return { ok: false, error: 'File too small to match' };
    try {
      const login = await xmlrpc('LogIn', ['', '', 'en', 'VLSub 0.10.2'].map((s) => `<param><value><string>${s}</string></value></param>`).join(''));
      const token = xmlStr(login, 'token');
      if (!token) return { ok: false, error: 'OpenSubtitles unavailable' };
      // Search by BOTH the content hash AND the cleaned filename, so a release whose hash isn't in the DB
      // (most torrent rips) still matches by name instead of returning nothing.
      const want = (lang || 'eng');
      const base = String(src).split('/').pop().replace(/\.[^.]+$/, '');
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
      const gz = await new Promise((resolve, reject) => {
        https.get(link, { headers: { 'User-Agent': 'VLSub 0.10.2' } }, (res) => {
          const chunks = []; let total = 0;
          res.on('data', (c) => { total += c.length; if (total > 8 * 1024 * 1024) { res.destroy(); reject(new Error('Subtitle download too large')); return; } chunks.push(c); });
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
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
  ipcMain.handle('thumb:at', (_e, { src, time } = {}) => new Promise((resolve) => {
    if (!src || time == null) return resolve(null);
    const key = src + '|' + Math.round(time / 5) * 5;
    if (thumbCache.has(key)) return resolve(thumbCache.get(key));
    const ff = spawn(FFMPEG, ['-ss', String(Math.max(0, time)), '-i', ffInput(src), '-frames:v', '1',
      '-vf', 'scale=160:-2', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { timeout: 8000 });
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', () => {});
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      if (!chunks.length) return resolve(null);
      const url = 'data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64');
      if (thumbCache.size >= 400) thumbCache.delete(thumbCache.keys().next().value); // evict oldest (bounded)
      thumbCache.set(key, url); resolve(url);
    });
  }));

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
  cast.on('devices', (devices) => send('cast-event', { type: 'devices', devices }));
  cast.on('error', (e) => send('cast-event', { type: 'error', message: e.message }));
  cast.on('status', (s) => {
    if (!s) return;
    if (typeof s.currentTime === 'number') lastAvTime = s.currentTime; // reuse resume clock (absolute: MKV uses -copyts)
    const dur = (castMkv && castMkv.dur) || (s.media && s.media.duration) || 0; // MKV stream length is the source's
    send('cast-event', { type: 'status', cur: s.currentTime || 0, dur, state: s.playerState });
  });
  // Receiver finished the media (IDLE/FINISHED) → tear the session down HERE (so the renderer can go
  // home without a cast:stop that would reload+replay the finished file locally) and tell the renderer
  // to clear resume + leave the wedged last frame. (Audit M5)
  cast.on('ended', () => {
    if (castEngine !== 'chromecast') return;
    castEngine = 'mpv'; castMkv = null;
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
    recastMkv(at || lastAvTime || 0, castMkv.audioTrack); // fresh MKV stream from the live position
  });
  function resumeLocalFromChromecast() {
    castEngine = 'mpv'; castMkv = null;
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
  function resolveCastable(url, cb, caps, forCast) {
    const s = String(url || '');
    const hlsOpts = { caps: caps || AIRPLAY_CAPS, extraSubs: externalSubs };
    // Remote https (yt-dlp / direct): no probe/remux — use as-is when it's an AV container.
    if (/^https:\/\//i.test(s)) return cb(lan.avCompatible(s) ? s : null);
    // Torrent localhost stream: rewrite host→LAN IP so the TV can fetch webtorrent's
    // range-served stream directly. NO ffprobe/remux here — probing a torrent stream stalls
    // (moov may be at the tail / whole file not downloaded), which would block the cast button.
    // AVPlayer range-reads the moov itself. MKV/etc can't be cast (no AV container) → null.
    const tor = s.match(/^http:\/\/(?:localhost|127\.0\.0\.1)(:\d+)(\/webtorrent\/.*)$/i);
    if (tor) {
      if (lan.avCompatible(s)) { // mp4/mov/m4v → AVPlayer fetches webtorrent's stream directly
        const ip = lan.lanAddress();
        return cb(ip ? 'http://' + ip + tor[1] + tor[2] : null);
      }
      // mkv/avi/ts/etc (H.264/HEVC) → live HLS remux so AVPlayer/Chromecast can play it as it streams
      if (/\.(mkv|avi|ts|m2ts|webm|wmv|flv|mpg|mpeg|ogv)(\?|#|$)/i.test(s)) return lan.serveHls(s, cb, hlsOpts);
      return cb(null);
    }
    // Local file. MP4/MOV → direct serve (prepareCast). Foreign containers (MKV/AVI/TS/…)
    // → live HLS so embedded subtitles + multi-audio survive the cast (sidecar WebVTT +
    // selectable audio renditions), instead of the subtitle-dropping remux-to-MP4 path.
    const filePath = decodeURIComponent(s.replace(/^file:\/\//, ''));
    if (/^\//.test(filePath)) {
      if (/\.(mkv|avi|ts|m2ts|webm|wmv|flv|mpg|mpeg|ogv)$/i.test(filePath)) return lan.serveHls(filePath, cb, hlsOpts);
      // MP4/MOV: direct-serve if already compatible, else live HLS (fast) instead of a slow full
      // remux — so a 4K MP4 with TrueHD/DTS audio still becomes castable in seconds, not minutes.
      return lan.prepareCast(filePath, true, cb, (input, c) => lan.serveHls(input, c, hlsOpts), { extraSubs: externalSubs, directSubs: !!forCast });
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
    lan.serveMkv(input, { caps, extraSubs: externalSubs, audioTrack, startSec }, (u, sideloadSubs, audioTracks, aTrack, dur, menuSubs) => {
      if (!u) return cb(null);
      cb(u, { subs: sideloadSubs || [], menuSubs: menuSubs || [], audioTracks: audioTracks || [], dur: dur || 0, isMkv: true, input, caps, audioTrack: aTrack });
    });
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
      { role: 'windowMenu' }
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
      mpvAddon.setEventListener((ev) => {
        // Temp torrent diag: log mpv's load lifecycle for a torrent URL so we can see whether mpv actually
        // opened the stream (file-loaded) or failed (end-file reason=4=ERROR). Remove once "press twice" is solved.
        if (process.env.SPRITZ_DEBUG && ev && (ev.type === 'file-loaded' || ev.type === 'end-file') && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i.test(mpvLastUrl || '')) {
          try { fs.appendFileSync('/tmp/spritz-torrent.log', '[' + new Date().toISOString().slice(11, 23) + '] mpv ' + ev.type + (ev.type === 'end-file' ? ' reason=' + ev.reason : '') + '\n'); } catch (e) {}
        }
        send('player-event', ev);
      }); // BEFORE startPlayer
      const sp = mpvAddon.startPlayer();
      console.log('[player] started', JSON.stringify(sp));
      if (apAddon && apAddon.setEventListener) {
        apAddon.setEventListener((ev) => {            // listener BEFORE attachPicker (TSFN invariant)
          if (ev.type !== 'time') console.log('[airplay]', JSON.stringify(ev)); // diag
          if (ev.type === 'time' && typeof ev.cur === 'number') { lastAvTime = ev.cur; if (castEngine === 'airplay') cancelDrop(); } // frames flowing → not dropped
          if (ev.type === 'external') {
            // Ignore an AirPlay route engaged (e.g. from Control Center) while a Chromecast/DLNA cast
            // is already active OR a cast handoff is mid-resolve ('pending') — two engines at once
            // would orphan the other session. (Audit M4 — the 'pending' check closes the resolve window.)
            if (ev.active && (castEngine === 'chromecast' || castEngine === 'dlna' || castEngine === 'pending')) { try { apAddon.stopAirplay(); } catch (e) {} return; }
            if (ev.active) {
              console.log('[airplay] route ENGAGED by user | castUrl=' + (castUrl ? String(castUrl).slice(0, 80) : 'NULL') + ' engine=' + castEngine);
              // Nothing castable for this source (or not yet resolved) → don't stop mpv into a dead/empty
              // AVPlayer item (that surfaces as "Could not connect"); back the route off and stay local.
              if (!castUrl) { console.error('[airplay] BLOCKED: no castable URL resolved yet (HLS pre-resolve not ready/failed) — staying local'); try { apAddon.stopAirplay(); } catch (e) {} return; }
              cancelDrop();                            // route (re)engaged → cancel any pending drop
              if (castEngine !== 'airplay') {          // route taken → hand off from mpv
                castEngine = 'airplay';
                const pos = mpvPos();
                captureTracks();                        // remember language/subtitle for the return
                try { mpvAddon.command('stop'); } catch (e) {}
                try { apAddon.seek(pos); apAddon.play(); } catch (e) {}
              }
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

  app.whenReady().then(() => { buildMenu(); createMainWindow(); const a = fromArgv(process.argv.slice(1)); if (a) openSource(a); });

  // Parse a local .m3u/.m3u8(non-HLS)/.pls playlist → ordered list of entries {url,title}.
  ipcMain.handle('playlist:parse', (_e, { path: p } = {}) => {
    try {
      const txt = fs.readFileSync(p, 'utf8');
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
    castEngine = 'mpv'; castMkv = null; // also clears a 'pending' handoff; its in-flight resolve cb bails on the loadGen bump
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
    const gen = ++loadGen;
    applyHttpHeaders(url, referer);
    applyStreamCache(url);
    endCastsForNewSource();
    externalSubs = []; // a new source drops any external subs the user attached to the previous one
    lastAvTime = 0;    // reset the shared cast resume-clock so a new source can't inherit the previous title's position
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
        if (gen !== loadGen) return;
        if (av) { setCastable(av, subs); return; }
        if (isTor && tries++ < 40) setTimeout(() => { if (gen === loadGen) tryResolve(); }, 3000); // fast bounded retry (~2 min)
      });
      tryResolve();
    } catch (e) { console.error('[player:load]', e.message); }
  });
  // Defense-in-depth: the renderer drives mpv via these, but a COMPROMISED renderer must not be able
  // to turn mpv into an arbitrary-code / file-exfil primitive. mpv's `run`/`subprocess` execute external
  // programs, and `input-ipc-server`/script properties load attacker-controlled code — none are used by
  // our renderer, so deny them. (Audit — player:command/setProperty hardening.)
  // Also deny mpv's file-write / file-read / capture primitives: a compromised renderer
  // could otherwise use stream-record / dump-cache / screenshot-to-file to write arbitrary
  // files, or external-files / sub-files to read them. (Audit — extend denylist.)
  const MPV_CMD_DENY = new Set(['run', 'subprocess', 'load-script', 'loadlist', 'dump-cache', 'screenshot-to-file']);
  const MPV_PROP_DENY = new Set(['input-ipc-server', 'scripts', 'load-scripts', 'script-opts', 'input-conf', 'config-dir', 'configdir', 'ytdl-raw-options', 'stream-record', 'external-files', 'sub-files']);
  ipcMain.on('player:setProperty', (_e, { name, value } = {}) => {
    try { if (name && !MPV_PROP_DENY.has(String(name).toLowerCase())) mpvAddon.setProperty(name, value); } catch (e) {}
  });
  ipcMain.on('player:command', (_e, { args } = {}) => {
    try { if (Array.isArray(args) && args.length && !MPV_CMD_DENY.has(String(args[0]).toLowerCase())) mpvAddon.command(...args); } catch (e) {}
  });
  ipcMain.handle('player:stat', () => { try { return mpvAddon.playerStat(); } catch (e) { return null; } });

  // ---- Anime4K / GLSL shader upscaling ----
  const SHADER_DIR = path.join(__dirname, '..', '..', 'vendor', 'shaders', 'anime4k');
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
      const files = A4K_MODES[mode];
      if (files) files.forEach((f) => mpvAddon.command('change-list', 'glsl-shaders', 'append', path.join(SHADER_DIR, f)));
      send('player:notice', { message: files ? ('Anime4K · Mode ' + mode) : 'Upscaling off' });
    } catch (e) { console.error('[shaders]', e.message); }
  });
  ipcMain.handle('player:mediaStats', () => { try { return mpvAddon.mediaStats(); } catch (e) { return null; } });

  // ---- stream-site URL → yt-dlp → mpv ----
  ipcMain.on('player:openSite', (_e, { url } = {}) => {
    if (!url) return;
    const gen = ++loadGen;
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
  ipcMain.on('cast:load', (_e, { host } = {}) => {
    if (!host) { send('cast-event', { type: 'error', message: 'No TV selected.' }); return; }
    const caps = cast.capsFor(host);
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
      if (gen !== loadGen) { castEngine = 'mpv'; return; } // source changed while resolving (player:load handles mpv)
      if (!av) return castFailedLocal(wasCasting, 'cast-event', 'This source can’t be cast to this TV.');
      castMkv = (meta && meta.isMkv) ? { host, input: meta.input, caps: meta.caps, audioTracks: meta.audioTracks, dur: meta.dur, audioTrack: meta.audioTrack, burnSub: null, subDelay: 0, menuSubs: meta.menuSubs || [] } : null;
      doCastLoad(host, av, (meta && meta.subs) || [], gen, { startSec, audioTracks: (meta && meta.audioTracks) || [], audioTrack: (meta && meta.audioTrack) || 0, menuSubs: (meta && meta.menuSubs) || [] });
    });
  });
  function doCastLoad(host, url, subs, gen, info) {
    if (gen == null) gen = loadGen;
    if (!url || gen !== loadGen) { castEngine = 'mpv'; if (!url) send('cast-event', { type: 'error', message: 'This source can’t be cast (needs an MP4/WebM the TV can play).' }); return; }
    // MKV transport bakes the start position into the stream (-ss/-copyts) → tell the receiver that
    // absolute position; a direct/HLS cast uses the live mpv position.
    const pos = info && typeof info.startSec === 'number' ? info.startSec : (mpvPos() || lastAvTime);
    try { mpvAddon.command('stop'); } catch (e) {} // hand off from local playback (AirPlay already dropped by beginCast)
    castEngine = 'chromecast';
    cast.load(host, { url, title: lastCastTitle, contentType: ctypeFor(url), currentTime: pos, subs: subs || [] }, (err) => {
      // The source changed (or a cast was cancelled) during the ~12s handshake → don't resurrect. (Audit M3)
      if (gen !== loadGen) { try { cast.stop(); } catch (e) {} castEngine = 'mpv'; return; }
      if (err) { if (err.detailedErrorCode) console.error('[cast] LOAD failed, detailedErrorCode=' + err.detailedErrorCode + ' (104=container/codec unsupported, e.g. a real Chromecast rejecting MKV)'); resumeLocalFromChromecast(); send('cast-event', { type: 'error', message: err.message }); }
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
    const gen = loadGen;
    const at = (typeof audioTrack === 'number') ? audioTrack : castMkv.audioTrack;
    const bs = (burnSub === undefined) ? castMkv.burnSub : burnSub;
    lan.serveMkv(castMkv.input, { caps: castMkv.caps, extraSubs: externalSubs, audioTrack: at, startSec: Math.max(0, startSec || 0), burnSub: bs, subDelay: castMkv.subDelay || 0 }, (u, sideloadSubs, audioTracks, aTrack, dur, menuSubs) => {
      if (gen !== loadGen || castEngine !== 'chromecast' || !u) return;
      castMkv.audioTrack = aTrack; castMkv.burnSub = (bs != null && bs >= 0) ? bs : null; castMkv.menuSubs = menuSubs || [];
      cast.load(host, { url: u, title: lastCastTitle, contentType: 'video/x-matroska', currentTime: Math.max(0, startSec || 0), subs: sideloadSubs || [] }, (err) => {
        if (err) { send('cast-event', { type: 'error', message: err.message }); return; }
        send('cast-event', { type: 'started', host, audioTracks: audioTracks || [], audioActive: aTrack, isMkv: true, subTracks: menuSubs || [], burnActive: castMkv.burnSub });
        if (cb) cb();
      });
    });
  }
  ipcMain.on('cast:play', () => { try { cast.play(); } catch (e) {} });
  ipcMain.on('cast:pause', () => { try { cast.pause(); } catch (e) {} });
  ipcMain.on('cast:seek', (_e, { t } = {}) => {
    if (castMkv && castEngine === 'chromecast') return recastMkv(t, castMkv.audioTrack); // re-cast at t, keep burn/audio
    try { cast.seek(t); } catch (e) {}
  });
  ipcMain.on('cast:setVolume', (_e, { f } = {}) => { try { cast.setVolume(f); } catch (e) {} });
  ipcMain.on('cast:setSourceAudio', (_e, { idx } = {}) => { // MKV audio-language change → re-cast at current pos (keep burn)
    if (castMkv && castEngine === 'chromecast') recastMkv(lastAvTime || 0, Math.max(0, parseInt(idx, 10) || 0));
  });
  ipcMain.on('cast:setBurnSub', (_e, { subIdx } = {}) => { // burn a bitmap sub in (subIdx>=0) or off (-1) → re-cast
    if (castMkv && castEngine === 'chromecast') recastMkv(lastAvTime || 0, castMkv.audioTrack, (subIdx >= 0 ? subIdx : -1));
  });
  ipcMain.on('cast:subDelay', (_e, { delta } = {}) => { // MKV cast subtitle sync: shift the sideloaded VTT cues → re-cast
    if (!castMkv || castEngine !== 'chromecast') return;
    castMkv.subDelay = Math.round(((castMkv.subDelay || 0) + (parseFloat(delta) || 0)) * 10) / 10; // 0.1s precision
    recastMkv(lastAvTime || 0, castMkv.audioTrack);
  });
  ipcMain.on('cast:stop', () => { resumeLocalFromChromecast(); send('cast-event', { type: 'stopped' }); });
  ipcMain.handle('cast:mediaTracks', () => { try { return cast.tracks(); } catch (e) { return null; } });
  ipcMain.on('cast:selectTrack', (_e, { kind, id } = {}) => {
    // Switching to a TEXT sub (or off) while a bitmap sub is BURNED IN → un-burn first (re-cast without
    // overlay), then apply the sideloaded text track on the fresh cast. Otherwise toggle live.
    if (castMkv && castEngine === 'chromecast' && kind === 'subs' && castMkv.burnSub != null) {
      return recastMkv(lastAvTime || 0, castMkv.audioTrack, -1, () => { if (id >= 0) { try { cast.setTrack('subs', id); } catch (e) {} } });
    }
    try { cast.setTrack(kind, id); } catch (e) {}
  });

  // ---- torrent ----
  ipcMain.on('torrent:add', (_e, { src } = {}) => { if (src) torrent.add(src); });
  ipcMain.on('torrent:selectFile', (_e, { index } = {}) => torrent.selectFile(index));
  ipcMain.on('torrent:cancel', () => { try { lan.cancelActive(); } catch (e) {} torrent.cancel(); }); // kill HLS remux reading the torrent first

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
