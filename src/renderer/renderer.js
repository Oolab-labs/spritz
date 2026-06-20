'use strict';

// M2 player controller. Reproduces the old mpv-player.js + player-surface.js +
// player.js event/control semantics, collapsed into one dispatcher driven by the
// addon's event pump (window.soda.player.onEvent). All control input goes out
// through window.soda.player.* (→ IPC → main → addon).

const $ = (sel, root = document) => root.querySelector(sel);

function toPlayerTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}
const paint = (el, pct) => el.style.setProperty('--p', Math.max(0, Math.min(100, pct)) + '%');
function prettyBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function isTorrentSrc(s) {
  s = String(s).trim();
  return /^(magnet:|stream-magnet:)/i.test(s) || /\.torrent$/i.test(s.split('?')[0]);
}
// http(s) URL pointing at a direct media file/stream (mpv opens it) vs a site page (needs yt-dlp)
function isDirectMedia(u) {
  try { return /\.(mp4|mkv|webm|mov|avi|m4v|flv|ts|wmv|mpg|mpeg|ogv|m3u8|mpd|m2ts|mp3|aac|flac|wav|ogg|opus)$/i.test(new URL(u).pathname); }
  catch (e) { return false; }
}
// Synchronous "this source is plausibly castable" check — lets the cast/AirPlay buttons appear the
// instant a local/direct file loads, WITHOUT waiting on the async serveHls/probe to flip `castable`
// (the cast button shows on source+device, never on a per-file resolution). Excludes
// torrents (the head must download first → rely on real `castable` + the retry) and stream-site pages.
function pathLooksCastable(src) {
  const s = String(src || '');
  if (!s || isTorrentSrc(s)) return false;
  if (/^https?:\/\//i.test(s)) return isDirectMedia(s);
  return /\.(mp4|m4v|mov|mkv|avi|ts|m2ts|webm|wmv|flv|mpg|mpeg|ogv)$/i.test(s.replace(/^file:\/\//, '').split(/[?#]/)[0]);
}

// ---- elements ----
const home = $('#home'), player = $('#player'), controls = $('#controls'), spinner = $('#spinner');
const seek = $('#seek'), curEl = $('.current'), totEl = $('.total');
const playpause = $('#playpause'), icPause = $('.pause', playpause), icPlay = $('.play', playpause), icReplay = $('.replay', playpause);
const stopBtn = $('#stop'), fsBtn = $('#fullscreen'), icFsEnter = $('.fs-enter'), icFsLeave = $('.fs-leave');
const volGroup = $('#volgroup'), muteBtn = $('#mute'), volSlider = $('#vol'), icVolOn = $('.vol-on'), icVolOff = $('.vol-off');
const openBtn = $('#open-file'), debug = $('#debug');
const btnAudio = $('#btn-audio'), btnSubs = $('#btn-subs'), menuAudio = $('#menu-audio'), menuSubs = $('#menu-subs');
const btnTune = $('#btn-tune'), btnPlaylist = $('#btn-playlist'), menuPlayback = $('#menu-playback'), menuPlaylist = $('#menu-playlist');
const btnPrev = $('#btn-prev'), btnNext = $('#btn-next'), playerTitle = $('#player-title');
const qualityEl = $('#quality'), subAddBtn = $('#sub-add');
const audioList = menuAudio.querySelector('.list'), subList = menuSubs.querySelector('.list');

// ---- state ----
const st = {
  loaded: false, duration: 0, currentTime: 0, paused: true, ended: false,
  seeking: false, dragging: false, volume: 1, muted: false, vw: 0, vh: 0,
  hwdec: 'auto-copy', fs: false, subDelay: 0, audioDelay: 0
};
// engine: 'mpv' (local) or 'airplay' (casting). Plus AirPlay availability flags.
let engine = 'mpv', routesAvailable = false, castable = false, pickerShown = false;
let currentKey = null, currentTitle = '', lastSaveT = 0, resumeTimer = null, resumeReady = false; // watch-history / resume
let playQueue = [], qIndex = -1, currentLocalPath = null, advancing = false; // playlist / queue / next-episode
let torrentQueue = [], torrentIdx = -1; // multi-file torrent (episodes) — playlist switches via selectFile
let sponsorSegments = [], skipSponsors = true, sponsorToastT = null; // SponsorBlock (YouTube)

const showSpinner = () => spinner.classList.remove('hidden');
const hideSpinner = () => spinner.classList.add('hidden');
function showIcon(which) { // 'pause' | 'play' | 'replay'
  icPause.classList.toggle('hidden', which !== 'pause');
  icPlay.classList.toggle('hidden', which !== 'play');
  icReplay.classList.toggle('hidden', which !== 'replay');
}

// ---- buffering watchdog: if time-pos stalls while playing, show the spinner ----
let bufTimer = null;
function armBufferWatchdog() {
  hideSpinner();
  clearTimeout(bufTimer);
  bufTimer = setTimeout(() => { if (!st.paused && !st.ended && st.loaded) showSpinner(); }, 800);
}

// ---- the single event dispatcher (addon → here) ----
function dispatch(ev) {
  if (ev.type === 'file-loaded') {
    st.loaded = true; st.ended = false; advancing = false; // next item is up; re-enable auto-advance
    home.classList.add('hidden'); player.classList.remove('hidden');
    btnSubs.classList.remove('hidden');
    torrentStatus.classList.add('hidden'); // stream is playing → drop the peers/speed pill for good
    if (st.subDelay !== 0) soda.player.setSubDelay(st.subDelay); // mpv resets delays per file
    if (st.audioDelay !== 0) soda.player.setProperty('audio-delay', st.audioDelay);
    $('#sub-delay-val').textContent = fmtDelay(st.subDelay); $('#audio-delay-val').textContent = fmtDelay(st.audioDelay);
    hideSpinner(); armIdle(); refreshAir();
    maybeOfferResume(); updateNowPlaying();
    return;
  }
  // end-file reason: 0=EOF (genuine finish) vs 2=STOP / 5=REDIRECT (replace/stop) — authoritative
  if (ev.type === 'end-file') { onEnded(ev.reason === 0); return; }
  if (ev.type !== 'property-change') return;

  const { name, value } = ev;
  switch (name) {
    case 'duration':
      if (typeof value === 'number') {
        st.duration = value; seek.max = value || 100;
        totEl.textContent = toPlayerTime(value); curEl.textContent = '0:00';
        updateNowPlaying();
      }
      break;
    case 'time-pos':
      if (typeof value === 'number' && !st.seeking) {
        st.currentTime = value;
        if (!st.dragging) {
          seek.value = value;
          paint(seek, st.duration ? value / st.duration * 100 : 0);
          curEl.textContent = toPlayerTime(value);
        }
        // SponsorBlock: jump past any sponsor/intro/etc. segment containing the playhead
        if (skipSponsors && sponsorSegments.length && engine === 'mpv' && !st.seeking) {
          const seg = sponsorSegments.find((s) => value >= s.start && value < s.end - 0.3);
          if (seg) { soda.player.seek(seg.end); showSponsorToast(seg.cat); }
        }
        // persist resume position every ~5s of local playback — but only AFTER the resume
        // offer has read the old position (else we'd clobber it with ~0s on reload)
        if (resumeReady && currentKey && engine === 'mpv' && st.duration > 0 && value > 1 && Date.now() - lastSaveT > 5000) {
          lastSaveT = Date.now();
          soda.history.save(currentKey, value, st.duration, currentTitle);
        }
      }
      armBufferWatchdog();
      break;
    case 'pause':
      if (!st.ended && st.paused !== value) showIcon(value ? 'play' : 'pause');
      st.paused = !!value;
      if (st.paused) { controls.classList.remove('idle'); document.body.style.cursor = 'default'; }
      updateNowPlaying();
      break;
    case 'seekable':
      if (value) seek.disabled = false;
      break;
    case 'seeking':
      if (value) showSpinner(); else { hideSpinner(); st.seeking = false; }
      break;
    case 'paused-for-cache':
      value ? showSpinner() : hideSpinner();
      break;
    case 'eof-reached':
      // completion is driven by the end-file event's reason (above); avoid double-firing here
      break;
    case 'dwidth': st.vw = value || 0; updateQuality(); break;
    case 'dheight': st.vh = value || 0; updateQuality(); break;
    case 'hwdec-current': if (typeof value === 'string' && value) st.hwdec = value; break;
    case 'track-list': try { onTrackList(JSON.parse(value || '[]')); } catch (e) { console.error('[track-list]', e && e.stack || e); } break;
    case 'aid': setActiveTrack(audioList, value); break; // track-list doesn't re-fire on selection
    case 'sid': setActiveTrack(subList, value); break;
  }
  updateDebug();
}

function onEnded(genuine) {
  if (genuine && advancing) return; // a stray end-file during a handoff must not double-advance
  // Only a genuine EOF (eof-reached property) clears resume + auto-advances; the end-file
  // EVENT also fires on stop/replace, which must not count as finishing the file.
  if (genuine && currentKey) soda.history.remove(currentKey); // finished → no resume next time
  if (genuine && playNext()) { advancing = true; return; }    // auto-advance: next in queue / next episode
  st.ended = true; showIcon('replay'); hideSpinner();
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  if (st.fs) soda.fullscreen.toggle();
}

// ---- resume playback (per-source position, offered for a few seconds) ----
const resumeBtn = $('#resume-btn'), resumeTime = $('#resume-time');
function titleFromSrc(s) {
  try {
    if (/^magnet:/i.test(s)) { const m = s.match(/dn=([^&]+)/i); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : 'Torrent'; }
    if (/^https?:\/\//i.test(s)) { const u = new URL(s); return (decodeURIComponent(u.pathname.split('/').pop() || '') || u.hostname).replace(/\.[^.]+$/, ''); }
    return decodeURIComponent(s.split('/').pop() || s).replace(/\.[^.]+$/, '');
  } catch (e) { return ''; }
}
async function maybeOfferResume() {
  if (!currentKey || engine !== 'mpv') { resumeReady = true; return; }
  let e = null; try { e = await soda.history.get(currentKey); } catch (err) {}
  resumeReady = true; // saving may now resume (we've read the old position)
  if (!e || !e.pos) return;
  const dur = st.duration || e.dur || 0;
  if (e.pos < 30 || (dur && e.pos > dur - 20)) return; // skip if near the start or the end
  showResume(e.pos);
}
function showResume(pos) {
  resumeTime.textContent = toPlayerTime(pos);
  resumeBtn.dataset.pos = pos;
  resumeBtn.classList.remove('hidden');
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(hideResume, 8000); // dismiss after a few seconds if ignored
}
function hideResume() { clearTimeout(resumeTimer); resumeBtn.classList.add('hidden'); }
resumeBtn.addEventListener('click', () => {
  const p = parseFloat(resumeBtn.dataset.pos);
  if (p > 0) { soda.player.seek(p); st.currentTime = p; }
  hideResume();
});

// ---- open / load / stop ----
function open(src, opts) {
  st.ended = false; showIcon('pause');
  home.classList.add('hidden'); player.classList.remove('hidden');
  showSpinner();
  soda.player.load(src, { referer: opts && opts.referer }); // optional Referer for hotlink-protected web links
  soda.power.block();
}
async function openFileDialog() {
  const r = await soda.dialog.openFile({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'ts', 'wmv', 'mpg', 'm3u', 'm3u8', 'pls'] },
      { name: 'Torrent', extensions: ['torrent'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (r && !r.canceled && r.filePaths && r.filePaths.length) {
    if (r.filePaths.length > 1) enqueue(r.filePaths); // multi-select → queue
    else routeSource(r.filePaths[0]);
  }
}
function stop() {
  if (engine === 'airplay') { soda.airplay.stop(); soda.airplay.hideButton(); engine = 'mpv'; document.body.classList.remove('casting'); castOverlay.classList.add('hidden'); pickerShown = false; }
  if (engine === 'chromecast') { soda.cast.stop(); exitChromecast(); }
  if (engine === 'dlna') { soda.dlna.stop(); exitChromecast(); }
  soda.player.stop();
  soda.power.unblock();
  soda.media.clear(); // drop the Control Center Now Playing entry
  castDiscovering = false; // re-trigger discovery on the next load (cast.startDiscovery is idempotent)
  castAdvanceHost = null;  // returning home cancels any pending auto-next re-cast
  // reset UI back to the welcome screen
  st.loaded = st.ended = st.seeking = st.dragging = false;
  st.duration = st.currentTime = st.vw = st.vh = 0;
  seek.value = 0; seek.max = 100; seek.disabled = true; paint(seek, 0);
  curEl.textContent = '0:00'; totEl.textContent = '0:00';
  showIcon('pause'); hideSpinner();
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; statsPanel.classList.add('hidden'); } // was polling mediaStats() forever after Stop (Audit leak)
  btnAudio.classList.add('hidden'); btnSubs.classList.add('hidden');
  qualityEl.classList.add('hidden'); closeMenus();
  soda.torrent.cancel();
  torrentStatus.classList.add('hidden'); torrentModal.classList.add('hidden');
  btnPrev.classList.add('hidden'); btnNext.classList.add('hidden'); playerTitle.textContent = '';
  soda.window.setTitle('Spritz');
  player.classList.add('hidden'); home.classList.remove('hidden');
  renderContinueWatching();
}

// ---- bindings ----
playpause.addEventListener('click', () => {
  if (engine !== 'mpv') {
    const r = engine === 'airplay' ? soda.airplay : engine === 'chromecast' ? soda.cast : soda.dlna;
    if (!icPlay.classList.contains('hidden')) { r.play(); showIcon('pause'); }
    else { r.pause(); showIcon('play'); }
    return;
  }
  if (!st.loaded) return;
  if (!icReplay.classList.contains('hidden')) { // ended → replay
    st.ended = false; showIcon('pause'); soda.player.seek(0); soda.player.play();
  } else if (!icPlay.classList.contains('hidden')) {
    soda.player.play();
  } else {
    soda.player.pause();
  }
});
stopBtn.addEventListener('click', stop);
openBtn.addEventListener('click', openFileDialog);

// Mark a drag in progress so incoming time/status events don't yank the thumb back under
// the user's finger while scrubbing (matters most during casting — events arrive every 0.5s).
seek.addEventListener('mousedown', () => { st.dragging = true; });
seek.addEventListener('input', () => {
  st.dragging = true;
  const v = parseFloat(seek.value);
  const max = parseFloat(seek.max) || st.duration; // seek.max tracks the active engine's duration
  paint(seek, max ? v / max * 100 : 0);
  curEl.textContent = toPlayerTime(v);
});
seek.addEventListener('change', () => {
  st.dragging = false;
  const v = parseFloat(seek.value);
  if (engine === 'airplay') { soda.airplay.seek(v); return; }
  if (engine === 'chromecast') { soda.cast.seek(v); return; }
  if (engine === 'dlna') { soda.dlna.seek(v); return; }
  st.seeking = true; st.currentTime = v;
  soda.player.seek(v); updateNowPlaying();
});

// ---- scrubber thumbnail preview (local files; on-demand ffmpeg frame) ----
const thumbPreview = $('#thumb-preview'), thumbImg = $('#thumb-img'), thumbTime = $('#thumb-time');
let thumbDebounce = null, thumbReq = 0;
seek.addEventListener('mousemove', (e) => {
  if (!st.loaded || !st.duration || engine !== 'mpv' || !currentLocalPath) return;
  const r = seek.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const t = frac * st.duration;
  thumbTime.textContent = toPlayerTime(t);
  thumbPreview.style.left = e.clientX + 'px';
  thumbPreview.classList.remove('hidden');
  clearTimeout(thumbDebounce);
  const req = ++thumbReq;
  thumbDebounce = setTimeout(async () => {
    const url = await soda.thumbAt(currentLocalPath, t);
    if (url && req === thumbReq) thumbImg.src = url; // ignore out-of-order responses
  }, 130);
});
seek.addEventListener('mouseleave', () => { thumbPreview.classList.add('hidden'); clearTimeout(thumbDebounce); });
seek.addEventListener('mousedown', () => { st.dragging = true; });
document.addEventListener('mouseup', () => { st.dragging = false; });
seek.addEventListener('keydown', (e) => { if ([37, 38, 39, 40].includes(e.keyCode)) e.preventDefault(); });

volSlider.addEventListener('input', () => {
  const frac = parseFloat(volSlider.value) / 100;
  st.volume = frac; st.muted = false;
  paint(volSlider, frac * 100);
  if (engine === 'airplay') soda.airplay.setVolume(frac);
  else if (engine === 'chromecast') soda.cast.setVolume(frac);
  else if (engine === 'dlna') soda.dlna.setVolume(frac);
  else { soda.player.setVolume(frac); soda.player.setMuted(false); }
  updateVolIcon();
});
volSlider.addEventListener('mousedown', () => volGroup.classList.add('active'));
document.addEventListener('mouseup', () => volGroup.classList.remove('active'));
muteBtn.addEventListener('click', () => {
  st.muted = !st.muted;
  if (!st.muted && st.volume === 0) { st.volume = 0.2; volSlider.value = 20; }
  if (engine !== 'mpv') {
    // Cast engines have no mute command — emulate via volume (0 ↔ last level) on the TV.
    const r = engine === 'airplay' ? soda.airplay : engine === 'chromecast' ? soda.cast : soda.dlna;
    r.setVolume(st.muted ? 0 : (st.volume || 0.2));
  } else {
    if (!st.muted && st.volume === 0) soda.player.setVolume(0.2);
    soda.player.setMuted(st.muted);
  }
  updateVolIcon();
});
function updateVolIcon() {
  const off = st.muted || st.volume === 0;
  icVolOn.classList.toggle('hidden', off);
  icVolOff.classList.toggle('hidden', !off);
  paint(volSlider, off ? 0 : st.volume * 100);
}

fsBtn.addEventListener('click', () => soda.fullscreen.toggle());
player.addEventListener('dblclick', (e) => { if (!e.target.closest('.controls')) soda.fullscreen.toggle(); });
soda.fullscreen.onChange((on) => {
  st.fs = on;
  icFsEnter.classList.toggle('hidden', on);
  icFsLeave.classList.toggle('hidden', !on);
  document.documentElement.classList.toggle('fullscreen', on);
  armIdle(); repositionPicker();
});

// ---- keybindings ----
function seekBy(d) {
  if (!st.loaded) return;
  const t = Math.max(0, Math.min(st.duration || (st.currentTime + d), st.currentTime + d));
  st.seeking = true; st.currentTime = t;
  seek.value = t; paint(seek, st.duration ? t / st.duration * 100 : 0); curEl.textContent = toPlayerTime(t);
  soda.player.seek(t);
}
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toUpperCase();
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  switch (e.keyCode) {
    case 32: if (typing || !st.loaded) return; e.preventDefault(); playpause.click(); break;        // Space
    case 37: if (typing || !st.loaded) return; e.preventDefault(); seekBy(-10); break;               // ←
    case 39: if (typing || !st.loaded) return; e.preventDefault(); seekBy(10); break;                // →
    case 38: if (typing || !st.loaded) return; e.preventDefault(); volSlider.value = Math.min(100, (+volSlider.value || 0) + 5); volSlider.dispatchEvent(new Event('input')); break; // ↑ volume +5%
    case 40: if (typing || !st.loaded) return; e.preventDefault(); volSlider.value = Math.max(0, (+volSlider.value || 0) - 5); volSlider.dispatchEvent(new Event('input')); break; // ↓ volume −5%
    case 77: if (!typing && st.loaded) muteBtn.click(); break;                                        // m → mute
    case 86: if (!typing && st.loaded && engine === 'mpv') soda.player.command('cycle', 'sub-visibility'); break; // v → subtitles on/off
    case 190: if (!typing && st.loaded && engine === 'mpv') soda.player.command('frame-step'); break; // . → step one frame forward
    case 27: if (!settingsModal.classList.contains('hidden')) closeSettings(); else if (st.fs) soda.fullscreen.toggle(); break; // Esc
    case 70: if (e.metaKey || !typing) { e.preventDefault(); soda.fullscreen.toggle(); } break;       // f / Cmd+F → fullscreen
    case 72: if (e.ctrlKey && engine === 'mpv') { const m = st.hwdec === 'no' ? 'auto-copy' : 'no'; soda.player.setHwdec(m); st.hwdec = m; } break; // Ctrl+H
    case 68: if (e.ctrlKey) { debug.classList.toggle('hidden'); updateDebug(); } break;              // Ctrl+D
    case 221: if (!typing && st.loaded && engine === 'mpv') setSubDelay(st.subDelay + 0.1); break;   // ]
    case 219: if (!typing && st.loaded && engine === 'mpv') setSubDelay(st.subDelay - 0.1); break;   // [
    case 220: if (!typing && st.loaded && engine === 'mpv') setSubDelay(0); break;                   // \
    case 73: if (!typing) toggleStats(); break;                                                      // i → stats overlay
    case 48: case 49: case 50: case 51: // Ctrl+0/1/2/3 → Anime4K off / A / B / C (local engine only)
      if (e.ctrlKey && st.loaded && engine === 'mpv') setAnime4k(['', 'A', 'B', 'C'][e.keyCode - 48]);
      break;
    case 188: if (e.metaKey) { e.preventDefault(); openSettings(); } else if (!typing && st.loaded && engine === 'mpv') soda.player.command('frame-back-step'); break; // Cmd+, Settings / , step one frame back
  }
});

// ---- stats overlay (codecs / bitrate / fps / dropped frames) ----
const statsPanel = $('#stats-panel');
let statsTimer = null;
function toggleStats() {
  if (statsPanel.classList.contains('hidden')) {
    statsPanel.classList.remove('hidden'); refreshStats();
    statsTimer = setInterval(refreshStats, 1000);
  } else { statsPanel.classList.add('hidden'); clearInterval(statsTimer); statsTimer = null; }
}
async function refreshStats() {
  let s = null; try { s = await soda.player.mediaStats(); } catch (e) {}
  if (!s || !s.vcodec) { statsPanel.textContent = 'no media'; return; }
  const kbps = (b) => b > 0 ? Math.round(b / 1000) + ' kb/s' : '—';
  statsPanel.textContent = [
    'Video  ' + (s.vcodec || '—'),
    '       ' + (s.width || 0) + '×' + (s.height || 0) + '  ' + (s.fps ? s.fps.toFixed(2) : '?') + ' fps  ' + kbps(s.vbitrate),
    '       hwdec: ' + (s.hwdec || 'no'),
    'Audio  ' + (s.acodec || '—') + '  ' + kbps(s.abitrate),
    'Drops  ' + (s.drops || 0) + ' vo / ' + (s.decoderDrops || 0) + ' dec',
    'Cache  ' + (s.cacheSecs ? s.cacheSecs.toFixed(1) + 's' : '—')
  ].join('\n');
}

// ---- drag-drop ----
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) { const p = soda.pathForFile(f); if (p) routeSource(p); return; }
  const text = e.dataTransfer && e.dataTransfer.getData('text');
  if (text && isTorrentSrc(text)) routeSource(text);
});

// ---- controls auto-hide ----
let idleTimer = null;
function armIdle() {
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  torrentStatus.classList.remove('controls-hidden'); // fade the peers/speed pill back in with the controls
  refreshAir();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!st.paused && st.loaded && engine === 'mpv') { // never auto-hide the cast remote
      controls.classList.add('idle'); document.body.style.cursor = 'none';
      torrentStatus.classList.add('controls-hidden'); // auto-hide the torrent pill alongside the controls
      refreshAir();
    }
  }, 2600);
}
document.addEventListener('mousemove', armIdle);

function updateDebug() {
  if (debug.classList.contains('hidden')) return;
  debug.textContent =
    `pos ${toPlayerTime(st.currentTime)} / ${toPlayerTime(st.duration)}\n` +
    `${st.vw}x${st.vh}  hwdec=${st.hwdec}\n` +
    `paused=${st.paused} ended=${st.ended} seeking=${st.seeking}`;
}

// ---- tracks / menus / quality ----
function trackLabel(t, kind) {
  const parts = [];
  if (t.lang) parts.push(String(t.lang).toUpperCase());
  if (t.title) parts.push(t.title);
  if (!parts.length) parts.push(kind + ' ' + t.id);
  return parts.join(' · ') + (t.external ? '  (ext)' : '');
}
function onTrackList(tracks) {
  // mpv fires a transient empty track-list while swapping files; ignore it so the
  // menus don't flicker to empty mid-load (stop() resets menus explicitly).
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');

  audioList.innerHTML = '';
  audio.forEach((t) => {
    const li = document.createElement('li');
    li.dataset.track = t.id;
    li.textContent = trackLabel(t, 'Audio');
    li.classList.toggle('active', !!t.selected);
    // aid/sid set as STRINGS — mpv's track-id properties want "2"/"no", not a double.
    li.addEventListener('click', () => { soda.player.setProperty('aid', String(t.id)); recordLangPref('audio', t.lang); closeMenus(); });
    audioList.appendChild(li);
  });
  btnAudio.classList.toggle('hidden', audio.length < 2);

  subList.querySelectorAll('li[data-track], li.cast-subsync').forEach((n) => n.remove());
  const offLi = subList.querySelector('li[data-sid="off"]');
  offLi.classList.toggle('active', !subs.some((t) => t.selected));
  offLi.onclick = () => { soda.player.setProperty('sid', 'no'); recordLangPref('sub', 'off'); closeMenus(); };
  subs.forEach((t) => {
    const li = document.createElement('li');
    li.dataset.track = t.id;
    li.textContent = trackLabel(t, 'Subtitle');
    li.classList.toggle('active', !!t.selected);
    li.addEventListener('click', () => { soda.player.setProperty('sid', String(t.id)); recordLangPref('sub', t.lang); closeMenus(); });
    subList.appendChild(li);
  });
  if (st.loaded) btnSubs.classList.remove('hidden');
  applyLangPref(audio, subs); // auto-pick the language this show was last watched in
}
// ---- per-show audio/subtitle language memory (A5) ----
// "Show" = the file's folder, so every episode in a season keeps the language you picked once.
function showKeyOf() {
  if (!currentLocalPath) return null; // local files only (folder = show); streams/torrents skipped
  const i = currentLocalPath.lastIndexOf('/');
  return i > 0 ? currentLocalPath.slice(0, i) : null;
}
let prefAppliedFor = null; // guard: apply the stored pref once per file load, not on every track-list refresh
function recordLangPref(kind, lang) {
  const key = showKeyOf(); if (!key) return;
  const v = (kind === 'sub' && lang === 'off') ? 'off' : (lang ? String(lang).toLowerCase() : null);
  if (v == null) return; // a track with no language tag carries no reusable preference
  soda.prefs.save(key, kind === 'audio' ? { audioLang: v } : { subLang: v });
}
async function applyLangPref(audio, subs) {
  const key = showKeyOf(); if (!key || prefAppliedFor === key) return;
  prefAppliedFor = key; // set before the await so a re-fired track-list can't double-apply
  let pref = null; try { pref = await soda.prefs.get(key); } catch (e) {}
  if (!pref) return;
  if (pref.audioLang && audio.length > 1) {
    const m = audio.find((t) => (t.lang || '').toLowerCase() === pref.audioLang);
    if (m && !m.selected) soda.player.setProperty('aid', String(m.id));
  }
  if (pref.subLang === 'off') { if (subs.some((t) => t.selected)) soda.player.setProperty('sid', 'no'); }
  else if (pref.subLang) { const m = subs.find((t) => (t.lang || '').toLowerCase() === pref.subLang); if (m && !m.selected) soda.player.setProperty('sid', String(m.id)); }
}
// mpv emits aid/sid as "1"/"2"/"no" — move the active marker accordingly.
function setActiveTrack(list, idStr) {
  if (idStr === 'auto') return; // transient before mpv resolves to a concrete track id
  const want = (idStr === 'no' || idStr == null || idStr === false || idStr === '') ? 'off' : String(idStr);
  list.querySelectorAll('li').forEach((li) => {
    const key = (li.dataset.track != null) ? String(li.dataset.track)
      : (li.dataset.sid === 'off' ? 'off' : '');
    li.classList.toggle('active', key === want);
  });
}
function updateQuality() {
  if (st.vw && st.vh) {
    qualityEl.textContent = (st.vw >= 3820 || st.vh >= 2140) ? '4K'
      : (st.vw >= 1900 || st.vh >= 1060) ? '1080p'
      : (st.vw >= 1260 || st.vh >= 700) ? '720p' : (st.vh + 'p');
    qualityEl.classList.remove('hidden');
  } else qualityEl.classList.add('hidden');
}
function closeMenus() {
  [menuAudio, menuSubs, menuCast, menuPlayback, menuPlaylist].forEach((m) => m.classList.add('hidden'));
  if (pickerShown) showPicker(false); // the native AirPlay picker only lives while the cast menu is open
}
[btnAudio, btnSubs, btnTune, btnPlaylist].forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  const target = document.getElementById(btn.dataset.menu);
  const willOpen = target.classList.contains('hidden');
  closeMenus();
  if (willOpen) {
    if (target === menuPlayback) renderPlaybackMenu();
    if (target === menuPlaylist) renderPlaylistMenu();
    target.classList.remove('hidden');
  }
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('[data-menu]')) closeMenus();
});
subAddBtn.addEventListener('click', async () => {
  closeMenus();
  const r = await soda.dialog.openFile({
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'sub', 'smi', 'vtt'] }]
  });
  if (r && !r.canceled && r.filePaths && r.filePaths[0]) soda.player.addSubtitleFile(r.filePaths[0]);
});
$('#sub-online').addEventListener('click', async () => {
  closeMenus();
  if (!currentLocalPath) { toast('Online subtitles need a local file', 3000); return; }
  toast('Searching OpenSubtitles…', 2500);
  const res = await soda.player.onlineSubtitles(currentLocalPath);
  if (res && res.ok) { soda.player.addSubtitleFile(res.srt); toast('Subtitles added: ' + (res.name || 'OpenSubtitles') + ' ✓', 3000); }
  else toast((res && res.error) || 'No subtitles found — try Whisper', 4000);
});
$('#sub-generate').addEventListener('click', async () => {
  closeMenus();
  if (!currentLocalPath) { showSponsorToast('AI subs need a local file'); return; }
  const res = await soda.player.generateSubtitles(currentLocalPath); // Whisper (async; main posts progress notices)
  if (res && res.ok) soda.player.addSubtitleFile(res.srt);
  else toast((res && res.error) || 'Subtitle generation failed', 4000);
});
const clampDelay = (v) => Math.round(Math.max(-30, Math.min(30, v)) * 10) / 10;
const fmtDelay = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + 's';
function setSubDelay(v) { st.subDelay = clampDelay(v); soda.player.setSubDelay(st.subDelay); $('#sub-delay-val').textContent = fmtDelay(st.subDelay); }
function setAudioDelay(v) { st.audioDelay = clampDelay(v); soda.player.setProperty('audio-delay', st.audioDelay); $('#audio-delay-val').textContent = fmtDelay(st.audioDelay); }
document.querySelectorAll('.delay-btn[data-delay]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  const step = parseFloat(b.dataset.step);
  if (b.dataset.delay === 'audio') setAudioDelay(st.audioDelay + step); else setSubDelay(st.subDelay + step);
}));

// ---- Open URL modal ----
const openUrlBtn = $('#open-url'), urlModal = $('#url-modal'), urlInput = $('#url-input'),
  urlReferer = $('#url-referer'), urlOpen = $('#url-open'), urlCancel = $('#url-cancel');
// A clipboard string worth auto-pasting: magnet/.torrent or any http(s) URL.
function clipboardSource() {
  let t = ''; try { t = (soda.readClipboard() || '').trim(); } catch (e) {}
  return (isTorrentSrc(t) || /^https?:\/\/\S+$/i.test(t)) ? t : null;
}
function showUrlModal() {
  urlModal.classList.remove('hidden');
  urlInput.value = clipboardSource() || ''; // auto-paste a copied magnet/link
  urlReferer.value = '';
  urlInput.focus(); urlInput.select();
}
// When the window regains focus on the home screen, a freshly-copied magnet pops the Open-URL
// box pre-filled — copy a link in the browser, switch to Spritz, hit Enter.
let lastClip = null;
window.addEventListener('focus', () => {
  if (!home.classList.contains('hidden') && urlModal.classList.contains('hidden')) {
    const c = clipboardSource();
    if (c && c !== lastClip && isTorrentSrc(c)) { lastClip = c; showUrlModal(); }
  }
});
function hideUrlModal() { urlModal.classList.add('hidden'); }
function submitUrl() {
  const u = urlInput.value.trim(); if (!u) return;
  const referer = urlReferer.value.trim();
  hideUrlModal();
  routeSource(u, false, referer ? { referer } : undefined);
}
openUrlBtn.addEventListener('click', showUrlModal);
urlOpen.addEventListener('click', submitUrl);
urlCancel.addEventListener('click', hideUrlModal);
[urlInput, urlReferer].forEach((inp) => inp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitUrl(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideUrlModal(); }
  e.stopPropagation(); // don't let global Space/arrow handlers see modal typing
}));

// menu-driven actions from the app menu (main process)
if (soda.menu && soda.menu.onAction) {
  soda.menu.onAction((action) => {
    if (action === 'open-file') openFileDialog();
    else if (action === 'open-url') showUrlModal();
    else if (action === 'fullscreen') soda.fullscreen.toggle();
    else if (action === 'stop') stop();
    else if (action === 'playpause') playpause.click();
    else if (action === 'stats') toggleStats();
    else if (action === 'float') soda.window.toggleFloat();
    else if (action === 'mini') soda.window.toggleMini();
    else if (action === 'settings') openSettings();
    else if (action === 'shader-off') setAnime4k('');
    else if (action === 'shader-A') setAnime4k('A');
    else if (action === 'shader-B') setAnime4k('B');
    else if (action === 'shader-C') setAnime4k('C');
  });
}

// ---- torrent / magnet streaming ----
const torrentStatus = $('#torrent-status'), torrentModal = $('#torrent-modal'),
  torrentFileList = $('#torrent-file-list'), torrentCancel = $('#torrent-cancel');

// route an opened source: torrents go through webtorrent, everything else to mpv
// ---- playback tune menu (speed / aspect / zoom) ----
let playbackSpeed = 1, videoZoom = 0;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [['Default', '-1'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '64:27'], ['2.35:1', '2.35'], ['Stretch', '0']];
let currentAspect = '-1';
function setSpeed(v) { playbackSpeed = v; soda.player.setProperty('speed', v); }
function setAspect(v) { currentAspect = v; soda.player.setProperty('video-aspect-override', v); }
function setZoom(z) { videoZoom = Math.max(-0.5, Math.min(1, Math.round(z * 10) / 10)); soda.player.setProperty('video-zoom', videoZoom); const el = $('#zoom-val'); if (el) el.textContent = Math.round(videoZoom * 100) + '%'; }
function renderPlaybackMenu() {
  const sl = $('#speed-list'); sl.innerHTML = '';
  SPEEDS.forEach((v) => {
    const li = document.createElement('li'); li.textContent = v === 1 ? 'Normal' : v + '×';
    li.classList.toggle('active', v === playbackSpeed);
    li.addEventListener('click', () => { setSpeed(v); renderPlaybackMenu(); });
    sl.appendChild(li);
  });
  const al = $('#aspect-list'); al.innerHTML = '';
  ASPECTS.forEach(([label, v]) => {
    const li = document.createElement('li'); li.textContent = label;
    li.classList.toggle('active', v === currentAspect);
    li.addEventListener('click', () => { setAspect(v); renderPlaybackMenu(); });
    al.appendChild(li);
  });
  $('#zoom-val').textContent = Math.round(videoZoom * 100) + '%';
}
menuPlayback.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setZoom(videoZoom + parseFloat(b.dataset.zoom)); }));

// ---- playlist menu (queue + repeat/shuffle) ----
function renderPlaylistMenu() {
  const list = $('#playlist-list'); list.innerHTML = '';
  // A multi-file torrent (episodes) takes over the playlist — clicking switches via selectFile.
  if (torrentQueue.length > 1) {
    torrentQueue.forEach((t, i) => {
      const li = document.createElement('li'); li.className = 'pl-item';
      const name = document.createElement('span'); name.textContent = t.name; name.className = 'pl-name';
      li.classList.toggle('active', i === torrentIdx);
      li.appendChild(name);
      li.addEventListener('click', () => { showSpinner(); selectTorrentFile(t.index); closeMenus(); });
      list.appendChild(li);
    });
    $('#pl-repeat').textContent = '↻ Repeat: ' + ({ off: 'Off', all: 'All', one: 'One' }[settings.repeat] || 'Off');
    $('#pl-shuffle').textContent = '🔀 Shuffle: ' + (settings.shuffle ? 'On' : 'Off');
    return;
  }
  if (!playQueue.length) { const li = document.createElement('li'); li.className = 'cast-empty'; li.textContent = 'Queue is empty'; list.appendChild(li); }
  playQueue.forEach((src, i) => {
    const li = document.createElement('li'); li.className = 'pl-item';
    const name = document.createElement('span'); name.textContent = titleFromSrc(src); name.className = 'pl-name';
    li.classList.toggle('active', i === qIndex);
    li.appendChild(name);
    const x = document.createElement('span'); x.textContent = '✕'; x.className = 'pl-remove'; x.title = 'Remove';
    x.addEventListener('click', (e) => { e.stopPropagation(); playQueue.splice(i, 1); if (i < qIndex) qIndex--; else if (i === qIndex) qIndex = Math.min(qIndex, playQueue.length - 1); renderPlaylistMenu(); syncNavButtons(); });
    li.appendChild(x);
    li.addEventListener('click', () => { qIndex = i; routeSource(playQueue[i], true); closeMenus(); });
    list.appendChild(li);
  });
  $('#pl-repeat').textContent = '↻ Repeat: ' + ({ off: 'Off', all: 'All', one: 'One' }[settings.repeat] || 'Off');
  $('#pl-shuffle').textContent = '🔀 Shuffle: ' + (settings.shuffle ? 'On' : 'Off');
}
$('#pl-repeat').addEventListener('click', (e) => { e.stopPropagation(); settings.repeat = { off: 'all', all: 'one', one: 'off' }[settings.repeat]; saveSettings(); renderPlaylistMenu(); });
$('#pl-shuffle').addEventListener('click', (e) => { e.stopPropagation(); settings.shuffle = !settings.shuffle; saveSettings(); renderPlaylistMenu(); });
$('#pl-add').addEventListener('click', async () => {
  closeMenus();
  const r = await soda.dialog.openFile({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Media', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'ts', 'mp3', 'm4a', 'flac', 'wav'] }] });
  if (r && !r.canceled && r.filePaths && r.filePaths.length) { playQueue.push(...r.filePaths); syncNavButtons(); renderPlaylistMenu(); }
});

// queue helpers — a user open resets the queue; playNext walks it then auto-next-episode
const isPlaylistFile = (s) => /\.(m3u|pls)(\?|#|$)/i.test(String(s).split('?')[0]) && !/\.m3u8/i.test(s);
function enqueue(list, start = 0) { castAdvanceHost = null; playQueue = list.slice(); qIndex = start; if (playQueue[qIndex]) routeSource(playQueue[qIndex], true); }
function playNext() {
  // Multi-file torrent: advance to the next episode via selectFile (honoring repeat/shuffle).
  if (torrentQueue.length > 1 && torrentIdx >= 0) {
    if (settings.repeat === 'one') { selectTorrentFile(torrentQueue[torrentIdx].index); return true; }
    let n = settings.shuffle ? Math.floor(Math.random() * torrentQueue.length)
      : (torrentIdx < torrentQueue.length - 1 ? torrentIdx + 1 : (settings.repeat === 'all' ? 0 : -1));
    if (n >= 0) { showSpinner(); selectTorrentFile(torrentQueue[n].index); return true; }
    return false;
  }
  if (settings.repeat === 'one' && qIndex >= 0) { routeSource(playQueue[qIndex], true); return true; } // loop current
  if (settings.shuffle && playQueue.length > 1) { // random other item
    let n = qIndex; while (n === qIndex) n = Math.floor(Math.random() * playQueue.length); qIndex = n; routeSource(playQueue[qIndex], true); return true;
  }
  if (qIndex >= 0 && qIndex < playQueue.length - 1) { routeSource(playQueue[++qIndex], true); return true; }
  if (settings.repeat === 'all' && playQueue.length > 1) { qIndex = 0; routeSource(playQueue[0], true); return true; } // wrap to start
  if (currentLocalPath) { // no queue left → try the next episode in the folder
    soda.fsSiblings(currentLocalPath).then((info) => { if (info && info.next) routeSource(info.next, true); });
    return true;
  }
  return false;
}
function playPrev() {
  // Multi-file torrent: step back an episode (mirror playNext's torrent branch).
  if (torrentQueue.length > 1 && torrentIdx > 0) { showSpinner(); selectTorrentFile(torrentQueue[torrentIdx - 1].index); return; }
  if (qIndex > 0) routeSource(playQueue[--qIndex], true);
}
// Prev/Next + playlist buttons appear together whenever there's a real queue or a multi-file torrent to
// walk (function declaration → safely callable from the toggle sites above it). Episode-skip was already
// wired to the OS media keys (playNext/playPrev); these just surface it in the control bar.
function syncNavButtons() {
  const show = playQueue.length >= 2 || torrentQueue.length >= 2;
  btnPrev.classList.toggle('hidden', !show);
  btnNext.classList.toggle('hidden', !show);
  btnPlaylist.classList.toggle('hidden', !show);
}
btnPrev.addEventListener('click', () => playPrev());
btnNext.addEventListener('click', () => playNext());

// ---- Continue Watching wall (home screen, from watch history) ----
const continueWatching = $('#continue-watching'), cwRow = $('#cw-row');
async function renderContinueWatching() {
  let items = []; try { items = await soda.history.recents(12); } catch (e) {}
  items = (items || []).filter((e) => e && e.pos > 5 && e.dur && e.pos < e.dur - 20); // in-progress only
  if (!items.length) { continueWatching.classList.add('hidden'); return; }
  cwRow.innerHTML = '';
  items.forEach((e) => {
    const card = document.createElement('div'); card.className = 'cw-card';
    const thumb = document.createElement('div'); thumb.className = 'cw-thumb';
    const glyph = document.createElement('div'); glyph.className = 'cw-glyph'; glyph.textContent = /^magnet:/i.test(e.src) ? '🧲' : /^https?:/i.test(e.src) ? '🌐' : '🎬';
    const prog = document.createElement('div'); prog.className = 'cw-prog';
    const bar = document.createElement('span'); bar.style.width = Math.min(100, Math.round(e.pos / e.dur * 100)) + '%';
    prog.appendChild(bar); thumb.appendChild(glyph); thumb.appendChild(prog);
    const name = document.createElement('div'); name.className = 'cw-name'; name.textContent = e.title || titleFromSrc(e.src);
    card.appendChild(thumb); card.appendChild(name);
    card.addEventListener('click', () => routeSource(e.src));
    cwRow.appendChild(card);
    if (/^\//.test(e.src)) soda.thumbAt(e.src, Math.max(1, e.pos)).then((url) => { // poster = frame at resume point
      if (!url) return; const img = document.createElement('img'); img.src = url; thumb.replaceChild(img, glyph);
    });
  });
  continueWatching.classList.remove('hidden');
}

// ---- SponsorBlock ----
function youtubeId(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)youtu\.be$/i.test(url.hostname)) return url.pathname.slice(1) || null;
    if (/(^|\.)youtube\.com$/i.test(url.hostname)) return url.searchParams.get('v');
  } catch (e) {}
  return null;
}
const SPONSOR_LABEL = { sponsor: 'sponsor', selfpromo: 'self-promo', interaction: 'reminder', intro: 'intro', outro: 'outro', music_offtopic: 'non-music' };
// Non-disruptive toast (reuses the torrent pill; does NOT stop playback like onNotice).
function toast(msg, ms) {
  torrentStatus.classList.remove('hidden', 'controls-hidden');
  torrentStatus.textContent = msg;
  clearTimeout(sponsorToastT); sponsorToastT = setTimeout(() => torrentStatus.classList.add('hidden'), ms || 2200);
}
function showSponsorToast(cat) { toast('⏭ Skipped ' + (SPONSOR_LABEL[cat] || cat), 1600); }

// ---- Settings (persisted in localStorage; the single source of truth for video toggles) ----
const settingsModal = $('#settings-modal');
const settings = (() => {
  const def = { interpolation: false, anime4k: '', skipSponsors: true, subSize: 46, subBg: false, requireVpn: false, repeat: 'off', shuffle: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem('spritz-settings') || '{}')); } catch (e) { return def; }
})();
function saveSettings() { try { localStorage.setItem('spritz-settings', JSON.stringify(settings)); } catch (e) {} }
function setSubSize(px) {
  settings.subSize = parseInt(px, 10) || 46; $('#set-subsize').value = String(settings.subSize);
  soda.player.setProperty('sub-font-size', settings.subSize); saveSettings();
}
function setSubBg(on) {
  settings.subBg = !!on; $('#set-subbg').checked = !!on;
  // translucent box behind text vs. plain outlined text
  soda.player.setProperty('sub-back-color', on ? '#80000000' : '#00000000');
  soda.player.setProperty('sub-border-size', on ? 0 : 3);
  saveSettings();
}
function setRequireVpn(on) { settings.requireVpn = !!on; $('#set-requirevpn').checked = !!on; saveSettings(); refreshVpnState(); }
async function refreshVpnState() {
  let v = { active: false }; try { v = await soda.vpnStatus(); } catch (e) {}
  const el = $('#vpn-state'); if (el) el.textContent = v.active ? ('VPN: on (' + (v.name || '') + ')') : 'VPN: off';
}
function setInterpolation(on) { settings.interpolation = !!on; soda.player.setInterpolation(!!on); $('#set-interp').checked = !!on; saveSettings(); }
function setAnime4k(mode) { settings.anime4k = mode || ''; soda.player.setShaders(mode || null); $('#set-anime4k').value = settings.anime4k; saveSettings(); }
function setSkipSponsors(on) {
  settings.skipSponsors = !!on; skipSponsors = !!on; $('#set-sponsors').checked = !!on; saveSettings();
  if (on && !sponsorSegments.length && currentKey) { const v = youtubeId(currentKey); if (v) soda.sponsorSegments(v).then((s) => { sponsorSegments = s || []; }); }
}
function applySettings() {
  setInterpolation(settings.interpolation); setAnime4k(settings.anime4k); setSkipSponsors(settings.skipSponsors);
  setSubSize(settings.subSize); setSubBg(settings.subBg);
  soda.player.setProperty('sub-codepage', 'auto'); // uchardet: auto-detect external-subtitle charset (no more mojibake)
}
function openSettings() {
  $('#set-interp').checked = settings.interpolation; $('#set-anime4k').value = settings.anime4k; $('#set-sponsors').checked = settings.skipSponsors;
  $('#set-subsize').value = String(settings.subSize); $('#set-subbg').checked = settings.subBg; $('#set-requirevpn').checked = settings.requireVpn;
  refreshVpnState();
  settingsModal.classList.remove('hidden');
}
function closeSettings() { settingsModal.classList.add('hidden'); }
$('#set-interp').addEventListener('change', (e) => setInterpolation(e.target.checked));
$('#set-anime4k').addEventListener('change', (e) => setAnime4k(e.target.value));
$('#set-sponsors').addEventListener('change', (e) => setSkipSponsors(e.target.checked));
$('#set-subsize').addEventListener('change', (e) => setSubSize(e.target.value));
$('#set-subbg').addEventListener('change', (e) => setSubBg(e.target.checked));
$('#set-requirevpn').addEventListener('change', (e) => setRequireVpn(e.target.checked));
$('#settings-close').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

// ---- Now Playing / media keys ----
function updateNowPlaying() {
  if (!st.loaded || engine !== 'mpv') return;
  soda.media.update({ title: currentTitle || 'Spritz', duration: st.duration || 0, elapsed: st.currentTime || 0, rate: st.paused ? 0 : 1 });
}
function remoteSeek(t) {
  if (engine === 'airplay') soda.airplay.seek(t);
  else if (engine === 'chromecast') soda.cast.seek(t);
  else if (engine === 'dlna') soda.dlna.seek(t);
  else { soda.player.seek(t); st.currentTime = t; updateNowPlaying(); }
}
soda.media.onCommand(({ cmd, value }) => {
  switch (cmd) {
    case 'play': if (st.paused) playpause.click(); break;
    case 'pause': if (!st.paused) playpause.click(); break;
    case 'toggle': playpause.click(); break;
    case 'next': playNext(); break;
    case 'prev': playPrev(); break;
    case 'forward': seekBy(10); break;
    case 'backward': seekBy(-10); break;
    case 'seek': if (typeof value === 'number') remoteSeek(value); break;
  }
});
function startTorrent(s) {
  st.ended = false; showIcon('pause');
  home.classList.add('hidden'); player.classList.remove('hidden');
  showSpinner(); soda.power.block();
  torrentStatus.classList.remove('hidden'); torrentStatus.textContent = 'connecting…';
  soda.torrent.add(s);
}
function routeSource(src, fromQueue, opts) {
  const s = String(src).trim();
  paintBuffered([]); // clear any stale torrent-buffered overlay from the previous source
  // Drop the previous file's decoded dimensions so the cast-routing 4K check (is4kSource) and the
  // quality badge don't read stale values when switching files WITHOUT a stop() (queue / next-episode
  // / Continue-Watching / drag-drop). They repopulate from the new file's dwidth/dheight. (Audit H6)
  st.vw = 0; st.vh = 0; updateQuality();
  prefAppliedFor = null; // re-apply the show's saved language to this newly-loaded episode
  if (!fromQueue) { // user-initiated open
    if (isPlaylistFile(s)) { soda.parsePlaylist(s).then((items) => { if (items && items.length) enqueue(items.map((i) => i.url)); }); return; }
    playQueue = [s]; qIndex = 0; advancing = false; // single-item queue
    castAdvanceHost = null; // a manual open cancels any pending auto-next re-cast
    if (!isTorrentSrc(s)) { torrentQueue = []; torrentIdx = -1; } // a new non-torrent open clears the torrent playlist (a new torrent repopulates via onMetadata)
  }
  currentLocalPath = /^\//.test(s) ? s : null; // folder auto-next only for local files
  currentKey = s; currentTitle = titleFromSrc(s); lastSaveT = 0; resumeReady = false; // key resume/history by original source
  playerTitle.textContent = currentTitle; // show the title in the control bar (centered; hidden bar = hidden title)
  hideResume();
  syncNavButtons(); // prev/next/playlist visibility — show for a real queue OR a multi-file torrent
  sponsorSegments = []; const vid = youtubeId(s); // SponsorBlock: fetch skip segments for YouTube
  if (vid && skipSponsors) soda.sponsorSegments(vid).then((segs) => { if (currentKey === s) sponsorSegments = segs || []; });
  if (isTorrentSrc(s)) {
    // VPN kill-switch: when enabled, refuse to start a torrent unless a tunnel is up.
    if (settings.requireVpn) {
      soda.vpnStatus().then((v) => {
        if (v && v.active) startTorrent(s);
        else toast('Torrent blocked — no VPN active (kill-switch is on in Settings)', 5000);
      });
      return;
    }
    startTorrent(s);
  } else if (/^https?:\/\//i.test(s) && !isDirectMedia(s)) {
    // stream-site page (YouTube/Vimeo/…) → main resolves via yt-dlp, then plays
    st.ended = false; showIcon('pause');
    home.classList.add('hidden'); player.classList.remove('hidden');
    showSpinner(); soda.power.block();
    soda.player.openSite(s);
  } else {
    open(s, opts); // local file or direct media URL (opts.referer for protected web links)
  }
}
soda.player.onNotice(({ message }) => {
  console.warn('[notice]', message);
  torrentStatus.classList.remove('hidden'); torrentStatus.textContent = message;
  setTimeout(stop, 2400);
});

soda.torrent.onMetadata((m) => {
  const playable = (m.files || []).filter((f) => f.playable)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Remember all episodes as a torrent playlist so the user can switch/auto-advance between them.
  torrentQueue = playable.map((f) => ({ index: f.index, name: f.name }));
  torrentIdx = -1;
  if (playable.length > 1) {
    torrentFileList.innerHTML = '';
    playable.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f.name + '  ·  ' + prettyBytes(f.length);
      li.dataset.index = f.index;
      li.addEventListener('click', () => { torrentModal.classList.add('hidden'); showSpinner(); selectTorrentFile(+li.dataset.index); });
      torrentFileList.appendChild(li);
    });
    torrentModal.classList.remove('hidden');
  }
  // single playable file → main auto-plays
});
// Select a file within the active torrent and track our position for the playlist + auto-advance.
function selectTorrentFile(index) {
  torrentIdx = torrentQueue.findIndex((t) => t.index === index);
  syncNavButtons();
  soda.torrent.selectFile(index);
}
const seekBuffered = $('#seek-buffered');
// Paint the downloaded byte-ranges of the torrent file onto the scrubber so you can see what's
// safe to seek to. ranges = [[startFrac,endFrac],…] of the file (≈ of the timeline).
function paintBuffered(ranges) {
  if (!seekBuffered) return;
  seekBuffered.innerHTML = (ranges || []).map(([a, b]) =>
    `<span class="seg" style="left:${(a * 100).toFixed(2)}%;width:${Math.max(0, (b - a) * 100).toFixed(2)}%"></span>`).join('');
}
soda.torrent.onProgress(({ peers, speed, buffered }) => {
  paintBuffered(buffered); // always update the scrubber overlay, even once the pill is hidden
  if (st.loaded || engine === 'airplay') { torrentStatus.classList.add('hidden'); return; } // playing → no pill
  torrentStatus.classList.remove('hidden');
  // Seeding-health "light": green ≥3.5 MB/s, orange 1.5–3.5, red <1.5 or no peers (4K HEVC needs ~1.83 MB/s).
  const mbps = (speed || 0) / (1024 * 1024);
  let cls = 'poor';
  if (peers > 0 && mbps >= 3.5) cls = 'excellent';
  else if (peers > 0 && mbps >= 1.5) cls = 'good';
  // Minimal: the dot IS the status; one short line is the throughput. (The pill only shows pre-playback.)
  const dot = document.createElement('span'); dot.className = 'dot ' + cls;
  torrentStatus.replaceChildren(dot, document.createTextNode(peers <= 0 ? 'connecting…' : prettyBytes(speed) + '/s'));
});
soda.torrent.onReady(({ url }) => { soda.player.load(url); });
soda.torrent.onError(({ message }) => {
  console.error('[torrent]', message);
  torrentStatus.classList.remove('hidden');
  torrentStatus.textContent = 'Torrent error: ' + message;
  setTimeout(stop, 1800);
});
torrentCancel.addEventListener('click', () => { torrentModal.classList.add('hidden'); stop(); });

// ---- Cast / AirPlay — ONE button, unified menu (AirPlay + Chromecast + DLNA) ----
// AirPlay can't be opened programmatically (you must click the native AVRoutePickerView), so the
// picker is overlaid on the "AirPlay" row of the cast menu and shown only while that menu is open.
const airRow = $('#cast-airplay-row'), castOverlay = $('#casting-overlay'), castStop = $('#cast-stop');
function airRect() { const r = airRow.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
function placePicker() { if (pickerShown && airRow.getBoundingClientRect().width) soda.airplay.showButton(airRect()); }
function showPicker(show) {
  pickerShown = show;
  if (show) requestAnimationFrame(placePicker); else soda.airplay.hideButton();
}
function refreshAir() { refreshCast(); } // the single button + picker are driven by refreshCast/the menu
function repositionPicker() { placePicker(); }
function enterCasting() {
  engine = 'airplay'; document.body.classList.add('casting');
  castOverlay.querySelector('.cast-text').textContent = 'Playing on AirPlay';
  castStop.textContent = 'Stop AirPlay';
  castOverlay.classList.remove('hidden'); hideSpinner();
  // Hide the DOM menus, but do NOT hide the native AVRoutePickerView — hiding it mid-handshake (a
  // 4K webOS AirPlay-2 session takes several seconds to negotiate) tears the route down → idle TV
  // with no video. Park it OFF-SCREEN instead (visible, route context alive); fully dropped on exit.
  [menuAudio, menuSubs, menuCast, menuPlayback, menuPlaylist].forEach((m) => m.classList.add('hidden'));
  pickerShown = true; soda.airplay.showButton({ x: -9999, y: -9999, w: 1, h: 1 });
  castBtn.classList.add('hidden');
  showIcon('pause'); seek.disabled = false;
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  btnAudio.classList.add('hidden'); btnSubs.classList.add('hidden'); // until AVPlayer reports tracks
  // HLS audio/subtitle selection groups load AFTER the route engages and routinely arrive past 5s
  // for a downloading torrent. Kick a self-rescheduling poll (capped 30s) instead of a fixed ladder
  // that gives up forever — also re-triggered by the addon's 'status' (ready-to-play) event.
  airTracksStart = Date.now();
  populateAirTracks();
}
let airPollTimer = null, airTracksStart = 0;
// Build the audio/subtitle menus from the casting AVPlayer's media selection groups,
// wired to soda.airplay.select* instead of mpv's aid/sid.
async function populateAirTracks() {
  if (engine !== 'airplay') return;
  let t = null; try { t = await soda.airplay.mediaTracks(); } catch (e) {}
  const audio = (t && t.audio) || [], subs = (t && t.subs) || [];
  audioList.innerHTML = '';
  audio.forEach((o, i) => {
    const li = document.createElement('li');
    li.textContent = o.name || ('Audio ' + (i + 1));
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { soda.airplay.selectAudio(i); closeMenus(); setTimeout(populateAirTracks, 350); });
    audioList.appendChild(li);
  });
  btnAudio.classList.toggle('hidden', audio.length < 2);
  subList.querySelectorAll('li[data-track], li.cast-subsync').forEach((n) => n.remove());
  const offLi = subList.querySelector('li[data-sid="off"]');
  offLi.classList.toggle('active', !subs.some((o) => o.selected));
  offLi.onclick = () => { soda.airplay.selectSubtitle(-1); closeMenus(); setTimeout(populateAirTracks, 350); };
  subs.forEach((o, i) => {
    const li = document.createElement('li');
    li.dataset.track = i;
    li.textContent = o.name || ('Subtitle ' + (i + 1));
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { soda.airplay.selectSubtitle(i); closeMenus(); setTimeout(populateAirTracks, 350); });
    subList.appendChild(li);
  });
  btnSubs.classList.toggle('hidden', subs.length === 0);
  // Keep polling while the groups still haven't arrived (≤30s) — they load asynchronously.
  if (engine === 'airplay' && btnAudio.classList.contains('hidden') && btnSubs.classList.contains('hidden')
      && Date.now() - airTracksStart < 30000) {
    clearTimeout(airPollTimer); airPollTimer = setTimeout(populateAirTracks, 1000);
  }
}
function exitCasting() {
  if (engine !== 'airplay') return;
  engine = 'mpv'; document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
  pickerShown = false; soda.airplay.hideButton(); // fully drop the parked picker now the cast ended
  refreshAir();
}
function updateRemoteTime(cur, dur) {
  if (dur > 0) { seek.max = dur; totEl.textContent = toPlayerTime(dur); }
  if (!st.dragging) { seek.value = cur; paint(seek, dur ? cur / dur * 100 : 0); curEl.textContent = toPlayerTime(cur); }
  // Persist resume position during a cast too (was mpv-only) — otherwise time spent watching on a TV
  // never reaches Continue-Watching. Same throttle/guards as local playback. (Audit M6)
  if (resumeReady && currentKey && engine !== 'mpv' && dur > 0 && cur > 1 && Date.now() - lastSaveT > 5000) {
    lastSaveT = Date.now();
    soda.history.save(currentKey, cur, dur, currentTitle);
  }
}
soda.airplay.onEvent((ev) => {
  switch (ev.type) {
    case 'routes': routesAvailable = ev.available; refreshAir(); break;
    case 'castable':
      castable = !!ev.castable; refreshAir();
      // Auto-next while casting: the next episode just became castable → resume casting it to the same
      // TV without the user reopening the menu. Consumed once (cleared so a later load can't re-trigger).
      if (castable && castAdvanceHost) { const h = castAdvanceHost; castAdvanceHost = null; showSpinner(); soda.cast.load(h); }
      break;
    case 'external': ev.active ? enterCasting() : exitCasting(); break;
    case 'time': if (engine === 'airplay') updateRemoteTime(ev.cur, ev.dur); break;
    case 'status': if (engine === 'airplay' && btnAudio.classList.contains('hidden') && btnSubs.classList.contains('hidden')) populateAirTracks(); break; // ready-to-play → groups likely arrived
    case 'ended': if (engine === 'airplay') onEnded(); break;
    case 'error':
      console.warn('[airplay]', ev.message);
      hideSpinner();
      if (engine === 'airplay') exitCasting(); // main already resumed local playback
      toast('AirPlay: ' + (ev.message || 'playback failed'), 3000);
      break;
  }
});
castStop.addEventListener('click', () => {
  if (engine === 'chromecast') { soda.cast.stop(); exitChromecast(); }
  else if (engine === 'dlna') { soda.dlna.stop(); exitChromecast(); } // was falling through to airplay → DLNA never stopped (Audit H4)
  else { soda.airplay.stop(); exitCasting(); }
});

// ---- Google Cast (Chromecast / LG webOS) ----
const castBtn = $('#cast'), menuCast = $('#menu-cast'), castList = menuCast.querySelector('.list');
let castDevices = [], dlnaDevices = [], castDiscovering = false;
let castHost = null;        // host of the active Chromecast session (for auto-next re-cast)
let castAdvanceHost = null; // set when a cast finished and we're routing the next item to re-cast to this host
// Eligibility: a TV-fetchable source + at least one discovered device (Chromecast OR DLNA).
function allDevices() {
  const casts = castDevices.map((d) => ({ kind: 'chromecast', name: d.name, ref: d.host, host: d.host }));
  const dlnas = dlnaDevices.map((d) => {
    let host = ''; try { host = new URL(d.location).hostname; } catch (e) {}
    // The SAME TV often shows up as both a Cast target and a DLNA renderer. The DLNA route plays the
    // ORIGINAL file natively — full 4K HEVC / HDR / Dolby Vision, surround audio, and the TV's own
    // subtitle/language menus, with NO transcode — so prefer it for that TV.
    const dual = casts.some((c) => c.host && c.host === host);
    return { kind: 'dlna', name: d.name + (dual ? ' — native 4K/HDR (best)' : ' (DLNA)'), ref: d.location, host, dual };
  });
  // Surface "best quality" DLNA entries for dual-capable TVs first, then Cast targets, then plain DLNA.
  return dlnas.filter((d) => d.dual).concat(casts).concat(dlnas.filter((d) => !d.dual));
}
function refreshCast() {
  // Start discovery as soon as ANY media loads — NOT gated on castable. The eureka /24 sweep
  // (the only way LG webOS is found) then runs concurrently with the slow HLS probe+remux, so
  // devices are already warm when castable flips, instead of starting a fresh sweep only after.
  const loaded = engine === 'mpv' && st.loaded;
  if (loaded && !castDiscovering) { castDiscovering = true; soda.cast.discover(); soda.dlna.discover(); }
  // ONE Cast/AirPlay button: show whenever the source is castable + playing. AirPlay is ALWAYS
  // offered (first menu row, backed by the native picker); Chromecast/DLNA rows are added as
  // discovery finds them — so the button no longer waits on a device being discovered first.
  castBtn.classList.toggle('hidden', !(castable && loaded));
}
// 4K source? (mpv reports the decoded size; 2160/3840 ≫ 1080p so a midpoint threshold is safe.)
function is4kSource() { return st.vh >= 1500 || st.vw >= 2600; }
// The DLNA endpoint for the SAME TV as a Chromecast host, if discovered (so we can prefer it).
function dlnaRefForHost(host) {
  const d = dlnaDevices.find((x) => { try { return new URL(x.location).hostname === host; } catch (e) { return false; } });
  return d ? d.location : null;
}
function renderCastMenu() {
  // Keep the static AirPlay row (the native picker overlays it); rebuild only the device rows.
  castList.querySelectorAll('li.cast-dev, li.cast-empty').forEach((n) => n.remove());
  allDevices().forEach((d) => {
    const li = document.createElement('li'); li.className = 'cast-dev';
    li.textContent = d.name;
    li.addEventListener('click', () => {
      closeMenus(); showSpinner();
      if (d.kind === 'dlna') { soda.dlna.load(d.ref); return; }
      // Auto-prefer DLNA for a 4K LOCAL file when the SAME TV also exposes DLNA: the native route
      // plays it at full 4K/HDR/Dolby-Vision with no Mac-side transcode, where Chromecast downscales.
      const dref = dlnaRefForHost(d.host);
      if (dref && is4kSource() && currentLocalPath) {
        toast('4K → using DLNA for full quality (no downscale)', 3000);
        soda.dlna.load(dref);
      } else soda.cast.load(d.ref);
    });
    castList.appendChild(li);
  });
  if (!allDevices().length) {
    const li = document.createElement('li'); li.className = 'cast-empty'; li.textContent = 'Searching for TVs…';
    castList.appendChild(li);
  }
  if (pickerShown) requestAnimationFrame(placePicker); // keep the picker over the AirPlay row after a rebuild
}
function enterChromecast(eng, name) {
  engine = eng; document.body.classList.add('casting');
  castOverlay.querySelector('.cast-text').textContent = 'Casting to ' + (name || 'TV');
  castStop.textContent = 'Stop Casting'; // DLNA/Chromecast — not AirPlay (the button text is otherwise stale)
  castOverlay.classList.remove('hidden'); hideSpinner();
  castBtn.classList.add('hidden'); pickerShown = false; soda.airplay.hideButton(); closeMenus();
  btnAudio.classList.add('hidden'); btnSubs.classList.add('hidden'); // until the receiver reports tracks
  showIcon('pause'); seek.disabled = false;
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  // HLS-embedded audio/subtitle renditions can surface late and asymmetrically on the receiver →
  // poll on a ladder and keep re-polling on status events for a bounded window (see cast onEvent).
  if (eng === 'chromecast') { castPollUntil = Date.now() + 12000; [0, 800, 1800, 3500, 6000, 9000].forEach((ms) => setTimeout(populateCastTracks, ms)); }
}
let castPollUntil = 0;
// Single-MKV Chromecast transport: the receiver only sees the ONE muxed audio track, so the
// language menu comes from the SOURCE's track list (sent in the 'started' event) and switching
// re-casts a fresh stream. Subtitles still come from the receiver (sideloaded WebVTT TEXT tracks).
let castSrcAudio = [], castSrcAudioActive = 0, castIsMkv = false;
// Sideloaded subtitle tracks (id + name) sent by main for the MKV transport. The LG receiver doesn't
// reliably ECHO sideloaded TEXT tracks back in its status, so we drive the menu from this known list
// and toggle by the deterministic trackId; castSrcSubActive (-1 = off) tracks the local selection.
let castSrcSubs = [], castSrcSubActive = -1, castBurnActive = null;
// Build the audio/subtitle menus from the Chromecast receiver's reported tracks,
// wired to soda.cast.select* (Chromecast EDIT_TRACKS_INFO uses absolute trackIds).
async function populateCastTracks() {
  if (engine !== 'chromecast') return;
  let t = null; try { t = await soda.cast.mediaTracks(); } catch (e) {}
  const audio = (t && t.audio) || [], subs = (t && t.subs) || [];
  audioList.innerHTML = '';
  if (castIsMkv && castSrcAudio.length) {
    // language menu = source tracks; selecting re-casts at the current position (main: cast:setSourceAudio)
    castSrcAudio.forEach((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.name || ('Audio ' + (i + 1));
      li.classList.toggle('active', i === castSrcAudioActive);
      li.addEventListener('click', () => { castSrcAudioActive = i; soda.cast.selectSourceAudio(i); closeMenus(); showSpinner(); });
      audioList.appendChild(li);
    });
    btnAudio.classList.toggle('hidden', castSrcAudio.length < 2);
  } else {
  audio.forEach((o) => {
    const li = document.createElement('li');
    li.textContent = o.name;
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { soda.cast.selectAudio(o.id); closeMenus(); setTimeout(populateCastTracks, 500); });
    audioList.appendChild(li);
  });
  btnAudio.classList.toggle('hidden', audio.length < 2);
  }
  // Subtitles. For the MKV transport drive the menu from the KNOWN sideloaded list (the receiver may
  // not echo the TEXT tracks) and track selection locally; otherwise use the receiver-reported subs.
  subList.querySelectorAll('li[data-track], li.cast-subsync').forEach((n) => n.remove());
  const mkvSubs = castIsMkv && castSrcSubs.length;
  const subItems = mkvSubs ? castSrcSubs : subs;
  const offLi = subList.querySelector('li[data-sid="off"]');
  offLi.classList.toggle('active', mkvSubs ? (castSrcSubActive < 0) : !subs.some((o) => o.selected));
  offLi.onclick = () => {
    closeMenus();
    if (mkvSubs) {
      castSrcSubActive = -1;
      if (castBurnActive != null) { soda.cast.selectBurnSub(-1); showSpinner(); } // un-burn = re-cast
      else { soda.cast.selectSubtitle(-1); setTimeout(populateCastTracks, 200); }
    } else { soda.cast.selectSubtitle(-1); setTimeout(populateCastTracks, 200); }
  };
  subItems.forEach((o, i) => {
    const li = document.createElement('li');
    li.dataset.track = o.id != null ? o.id : ('b' + o.subIdx);
    li.textContent = o.name + (o.burn ? '  ·  burn-in' : ''); // bitmap subs are composited onto the video
    li.classList.toggle('active', mkvSubs ? (i === castSrcSubActive) : !!o.selected);
    li.addEventListener('click', () => {
      closeMenus();
      if (mkvSubs) {
        castSrcSubActive = i;
        if (o.burn) { soda.cast.selectBurnSub(o.subIdx); showSpinner(); } // bitmap → burn-in re-cast (~2s)
        else { soda.cast.selectSubtitle(o.id); setTimeout(populateCastTracks, 200); } // text → instant toggle (main un-burns if needed)
      } else { soda.cast.selectSubtitle(o.id); setTimeout(populateCastTracks, 200); }
    });
    subList.appendChild(li);
  });
  // MKV cast: subtitle sync nudge (re-casts with the sideloaded VTT cues shifted). Only meaningful when
  // an active TEXT sub is showing — burn-in subs are baked into the frames and can't be re-timed live.
  if (mkvSubs && castSrcSubActive >= 0 && castSrcSubs[castSrcSubActive] && !castSrcSubs[castSrcSubActive].burn) {
    [['Subtitles earlier  −0.5s', -0.5], ['Subtitles later  +0.5s', 0.5]].forEach(([label, d]) => {
      const li = document.createElement('li'); li.className = 'cast-subsync';
      li.textContent = label;
      li.addEventListener('click', () => { closeMenus(); showSpinner(); soda.cast.setSubDelay(d); });
      subList.appendChild(li);
    });
  }
  btnSubs.classList.toggle('hidden', subItems.length === 0);
}
function exitChromecast() {
  if (engine !== 'chromecast' && engine !== 'dlna') return;
  engine = 'mpv'; document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
  castOverlay.querySelector('.cast-text').textContent = 'Playing on AirPlay'; // restore default label
  refreshAir();
}
castBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = menuCast.classList.contains('hidden');
  closeMenus();
  if (willOpen) { renderCastMenu(); menuCast.classList.remove('hidden'); showPicker(true); } // overlay the native AirPlay picker on its row
});
soda.cast.onEvent((ev) => {
  switch (ev.type) {
    case 'devices': castDevices = ev.devices || []; renderCastMenu(); refreshCast(); break;
    case 'started':
      castHost = ev.host || castHost; // remember the TV so a finished item can auto-advance to it
      castSrcAudio = ev.audioTracks || []; castSrcAudioActive = ev.audioActive || 0; castIsMkv = !!ev.isMkv;
      castSrcSubs = ev.subTracks || [];
      castBurnActive = (ev.burnActive != null) ? ev.burnActive : null;
      // Active subtitle: a burned-in bitmap sub matches burnActive; a fresh cast starts OFF; a re-cast
      // with no burn keeps the locally-tracked text selection.
      if (castBurnActive != null) { const bi = castSrcSubs.findIndex((s) => s.burn && s.subIdx === castBurnActive); castSrcSubActive = bi >= 0 ? bi : -1; }
      else if (engine !== 'chromecast') castSrcSubActive = -1;
      // A re-cast (seek / audio / burn-in change) re-fires 'started' while already chromecast → just
      // refresh the menus + drop the spinner, don't re-run the whole enter-cast sequence (no flicker).
      // The fresh receiver session loads with subtitles OFF, but the menu still tracks the prior
      // selection — re-apply the active text sub so it doesn't silently vanish on the TV after a
      // seek/audio change. (Burn-in subs are re-composited by main's recast; only re-select text tracks.)
      if (engine === 'chromecast') {
        hideSpinner(); populateCastTracks();
        if (castIsMkv && castSrcSubActive >= 0) {
          const s = castSrcSubs[castSrcSubActive];
          if (s && !s.burn && s.id != null) soda.cast.selectSubtitle(s.id);
        }
      }
      else enterChromecast('chromecast', (castDevices.find((d) => d.host === ev.host) || {}).name);
      break;
    case 'stopped': exitChromecast(); break;
    case 'ended': // receiver finished the media → clear resume. (main already tore the session down, so
      // exitChromecast FIRST → stop() won't re-send cast:stop / reload mpv.) (Audit M5)
      if (engine === 'chromecast') {
        if (currentKey) soda.history.remove(currentKey);
        const host = castHost;
        exitChromecast();
        // Continue the binge ON THE TV: route to the next queue item / next episode and re-cast to the
        // same host once it resolves (the 'castable' handler consumes castAdvanceHost). Nothing next → home.
        if (host) { castAdvanceHost = host; if (playNext()) break; castAdvanceHost = null; }
        stop();
      }
      break;
    case 'status':
      // Re-poll for a bounded window (not just while BOTH buttons hidden) so a late audio OR
      // subtitle group that arrives after the other is still picked up.
      if (engine === 'chromecast') { updateRemoteTime(ev.cur, ev.dur); if (Date.now() < castPollUntil) populateCastTracks(); }
      break;
    case 'error':
      console.warn('[cast]', ev.message);
      hideSpinner(); // a connect-timeout error fires before 'started' → spinner would hang
      if (engine === 'chromecast') exitChromecast();
      torrentStatus.classList.remove('hidden'); torrentStatus.textContent = 'Cast: ' + ev.message;
      setTimeout(() => torrentStatus.classList.add('hidden'), 2600);
      break;
  }
});
soda.dlna.onEvent((ev) => {
  switch (ev.type) {
    case 'devices': dlnaDevices = ev.devices || []; renderCastMenu(); refreshCast(); break;
    case 'started':
      enterChromecast('dlna', (dlnaDevices.find((d) => d.location === ev.location) || {}).name);
      // DLNA serves the ORIGINAL file untouched → the TV decodes it natively (full quality) and
      // exposes its OWN on-screen audio-language & subtitle menus (incl. bitmap/PGS subs). Point the
      // user there instead of the in-app track menu, which only drives the local/AirPlay/Cast engines.
      toast(ev.withSub
        ? 'DLNA: original quality + your subtitle sent — enable it in the TV’s subtitle menu'
        : 'DLNA: playing original quality — switch audio/subtitles from your TV’s own menu', 4600);
      break;
    case 'stopped': exitChromecast(); break;
    case 'status': if (engine === 'dlna') updateRemoteTime(ev.cur, ev.dur); break;
    case 'error':
      console.warn('[dlna]', ev.message);
      hideSpinner(); // resolve/remux failure fires before 'started' → spinner would hang
      if (engine === 'dlna') exitChromecast();
      torrentStatus.classList.remove('hidden'); torrentStatus.textContent = 'DLNA: ' + ev.message;
      setTimeout(() => torrentStatus.classList.add('hidden'), 2600);
      break;
  }
});
window.addEventListener('resize', repositionPicker);

// ---- manual window drag (mousedown on the top strip or welcome screen → IPC move) ----
const dragbar = $('#dragbar');
let dragAnchor = null;
function startWinDrag(e) {
  if (e.button !== 0) return;
  dragAnchor = { x: e.screenX, y: e.screenY };
  soda.window.beginDrag();
}
dragbar.addEventListener('mousedown', startWinDrag);
home.addEventListener('mousedown', (e) => { if (!e.target.closest('button') && !e.target.closest('.btn') && !e.target.closest('#winctl')) startWinDrag(e); });

// ---- custom window controls (close / minimize / fullscreen) ----
$('#wc-close').addEventListener('click', (e) => { e.stopPropagation(); soda.window.close(); });
$('#wc-min').addEventListener('click', (e) => { e.stopPropagation(); soda.window.minimize(); });
$('#wc-full').addEventListener('click', (e) => { e.stopPropagation(); soda.fullscreen.toggle(); });
// don't let a click on the controls start a window drag
$('#winctl').addEventListener('mousedown', (e) => e.stopPropagation());
window.addEventListener('mousemove', (e) => { if (dragAnchor) soda.window.dragTo(e.screenX - dragAnchor.x, e.screenY - dragAnchor.y); });
window.addEventListener('mouseup', () => { dragAnchor = null; });

// ---- init ----
soda.player.onEvent(dispatch);
soda.onToast((m) => toast(m));
soda.onOpenSource((src) => routeSource(src)); // "open with Spritz" / magnet / CLI (also signals renderer-ready)
paint(volSlider, 100); updateVolIcon(); armIdle(); renderContinueWatching(); applySettings();
// Pre-warm device discovery at launch (AirPlay route detection is already always-on natively) so
// Chromecast/DLNA devices are already found by the time a file/torrent loads — the cast button
// then appears the instant the source becomes castable instead of waiting on a cold /24 sweep.
soda.cast.discover(); soda.dlna.discover(); castDiscovering = true;
