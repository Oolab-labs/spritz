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
let engine = 'mpv', routesAvailable = false, castable = false, pickerShown = false, torrentActive = false;
let playbackTargetIntent = 0;
function setPlaybackEngine(value) { clearErrorStop(); ++playbackTargetIntent; engine = value; applyRouteHints(); }
function subtitleOwner() { return { source: sourceIntent, target: playbackTargetIntent }; }
function ownsSubtitle(owner) { return owner.source === sourceIntent && owner.target === playbackTargetIntent; }
let currentKey = null, currentTitle = '', lastSaveT = 0, resumeTimer = null, resumeReady = false; // watch-history / resume
let sourceIntent = 0, folderIntent = 0;
let errorStopTimer = null, errorStopSerial = 0;
function clearErrorStop() {
  ++errorStopSerial;
  if (errorStopTimer !== null) clearTimeout(errorStopTimer);
  errorStopTimer = null;
}
function scheduleErrorStop(delay) {
  clearErrorStop();
  const source = sourceIntent, target = playbackTargetIntent, serial = errorStopSerial;
  errorStopTimer = setTimeout(() => {
    if (serial !== errorStopSerial) return;
    errorStopTimer = null;
    if (source === sourceIntent && target === playbackTargetIntent) stop();
  }, delay);
}
let detachedQueueSource = null;
let playQueue = [], qIndex = -1, currentLocalPath = null, advancing = false; // playlist / queue / next-episode
let torrentQueue = [], torrentIdx = -1; // multi-file torrent (episodes) — playlist switches via selectFile
let sponsorSegments = [], skipSponsors = true, sponsorToastT = null; // SponsorBlock (YouTube)

const showSpinner = () => spinner.classList.remove('hidden');
// Cast/DLNA handoff watchdog. Picking a device shows the spinner and fires a one-way IPC; every
// path that resolves it depends on the main process emitting an event back. A device that accepts
// the TCP connection but never answers (an LG renderer wedged in TRANSITIONING/701 does exactly
// this — even Stop times out) produces no event at all, so the spinner spins forever with no way
// out. Arm a timer on the click; any hideSpinner() disarms it, since that means we stopped waiting.
let castWatchdog = null;
function clearCastWatchdog() { if (castWatchdog) { clearTimeout(castWatchdog); castWatchdog = null; } }
function armCastWatchdog(what) {
  clearCastWatchdog();
  castWatchdog = setTimeout(() => {
    castWatchdog = null;
    spinner.classList.add('hidden');
    toast(what + ' isn’t responding — it may be busy or asleep. Try again, or restart the TV.', 6000);
  }, 45000); // > the 12s cast connect timeout + transcode startup, so it only fires on a real hang
}
const hideSpinner = () => { clearCastWatchdog(); spinner.classList.add('hidden'); };
function showIcon(which) { // 'pause' | 'play' | 'replay'
  icPause.classList.toggle('hidden', which !== 'pause');
  icPlay.classList.toggle('hidden', which !== 'play');
  icReplay.classList.toggle('hidden', which !== 'replay');
}

// ---- buffering watchdog: if time-pos stalls while playing, show the spinner ----
let bufTimer = null;
let lastSeekPaint = 0; // throttles the scrubber/clock repaint away from mpv's frame-rate time-pos
let posSeq = 0;        // bumped on every time-pos event — lets the async check below notice that
                       // fresh events arrived while it was awaiting (see the race note there)
function armBufferWatchdog() {
  hideSpinner();
  clearTimeout(bufTimer);
  // Snapshot what this check is reasoning about. st.currentTime is mutated by incoming events, so
  // reading it again after an await compares the present against itself and always looks stalled.
  const posAtArm = st.currentTime, seqAtArm = posSeq;
  bufTimer = setTimeout(async () => {
    if (st.paused || st.ended || !st.loaded) return;
    // "No time-pos for 800ms" is not the same as "playback stalled". Delivery of these events
    // pauses periodically while mpv plays on perfectly, so ask the player where it really is.
    if (engine === 'mpv') {
      let stat = null;
      try { stat = await soda.player.stat(); } catch (e) {}
      // THE RACE: that await gives the event loop a turn, and the backlog of time-pos events that
      // built up during the stall flushes first. They advance st.currentTime and hide the ring;
      // then this resumes, sees mpv's position equal to the position it just caught up to, and
      // concludes "stalled" — drawing a ring that the next event erases ~40ms later. That flicker
      // WAS the reported bug. Comparing against the snapshot, and bailing out if any event
      // arrived, makes the decision immune to what happened while awaiting.
      if (posSeq !== seqAtArm) return;                            // caught up → never stalled
      if (stat && typeof stat.timePos === 'number') {
        if (stat.paused) return;                                  // paused behind our back
        if (stat.timePos - posAtArm > 0.25) return;               // it moved: we were the slow one
      }
      if (st.paused || st.ended || !st.loaded) return;            // state may have moved meanwhile
    }
    if (posSeq !== seqAtArm) return;
    showSpinner();
  }, 800);
}

// ---- the single event dispatcher (addon → here) ----
function dispatch(ev) {
  if (engine === 'receiver') return; // local clock must not overwrite the TV remote
  if (ev.type === 'file-loaded') {
    st.loaded = true; st.ended = false; advancing = false; // next item is up; re-enable auto-advance
    // loadfile starts PLAYING, so playback is active by definition here. This used to pass
    // !st.paused, but st.paused starts true and is only ever written by mpv's `pause`
    // property-change — which fires solely on a CHANGE. On the normal autoplay path pause is
    // already false, so no event ever arrived to correct it, and this announced "not playing" for
    // the whole file, leaving the renderer eligible for background throttling while playing.
    // (Found while chasing the spurious buffering ring. Measurement later pinned that symptom on
    // the race in armBufferWatchdog, not on this — but announcing the wrong state is still wrong.)
    st.paused = false;
    try { soda.player.playbackActive(true); } catch (e) {}
    home.classList.add('hidden'); player.classList.remove('hidden');
    btnSubs.classList.remove('hidden');
    // Keep the peers/speed pill alive while a torrent is STILL DOWNLOADING — that's exactly when
    // you want to know whether the swarm can sustain playback. armIdle() already fades it in and
    // out with the control bar, so it only shows on hover and never sits over a clean picture.
    // (It used to be hidden here "for good", which made that whole hover path dead code.)
    if (torrentActive) torrentStatus.classList.remove('hidden', 'controls-hidden');
    else torrentStatus.classList.add('hidden'); // plain local file → no pill
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
      posSeq++; // see armBufferWatchdog: proves an event landed, even if the value is unchanged
      if (typeof value === 'number' && !st.seeking) {
        st.currentTime = value; // exact, every event — history/resume/cast handoff read this
        // mpv observes time-pos UNTHROTTLED, so this arrives at frame rate. Writing the slider,
        // its --p custom property and the time label on every frame means 24-60 style/layout/paint
        // cycles per second stacked on top of video compositing, which is felt as UI lag. The
        // display only needs to look smooth: repaint at ~10Hz and let st.currentTime stay exact.
        const nowMs = performance.now();
        if (!st.dragging && (nowMs - lastSeekPaint >= 100)) {
          lastSeekPaint = nowMs;
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
      // Keep the renderer un-throttled only while something is actually playing (see
      // player:playbackActive in main). Paused or stopped, a backgrounded window can throttle.
      try { soda.player.playbackActive(!st.paused && st.loaded); } catch (e) {}
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
  // NOT updateDebug() here. This runs on every property-change, so with the overlay open it fired
  // an async soda.diag() IPC round-trip per time-pos — ~60 a second, each one snapshotting the cast
  // list, DLNA list and torrent stats in the main process. The overlay for diagnosing stutter was
  // itself loading the main thread that playback renders on. It refreshes on its own 1s interval
  // while visible, and Ctrl+D paints it immediately; per-event refresh bought nothing.
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
  const owner = subtitleOwner(), key = currentKey;
  if (!currentKey || engine !== 'mpv') { resumeReady = true; return; }
  let e = null; try { e = await soda.history.get(key); } catch (err) {}
  if (!ownsSubtitle(owner) || currentKey !== key || engine !== 'mpv') return;
  resumeReady = true; // saving may now resume (we've read the old position)
  if (!e || !e.pos) return;
  const dur = st.duration || e.dur || 0;
  if (e.pos < 30 || (dur && e.pos > dur - 20)) return; // skip if near the start or the end
  showResume(e.pos);
}
let resumeOwner = null;
function showResume(pos) {
  resumeOwner = subtitleOwner();
  resumeTime.textContent = toPlayerTime(pos);
  resumeBtn.dataset.pos = pos;
  resumeBtn.classList.remove('hidden');
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(hideResume, 8000); // dismiss after a few seconds if ignored
}
function hideResume() { clearTimeout(resumeTimer); resumeOwner = null; resumeBtn.classList.add('hidden'); }
resumeBtn.addEventListener('click', () => {
  const p = parseFloat(resumeBtn.dataset.pos);
  if (p > 0 && resumeOwner && ownsSubtitle(resumeOwner) && engine === 'mpv') { soda.player.seek(p); st.currentTime = p; }
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
  clearTorrentNotice();
  clearErrorStop(); hideResume();
  if (engine === 'receiver') leaveReceiver(false);
  ++sourceIntent; ++folderIntent;
  if (engine === 'airplay') { soda.airplay.stop(); soda.airplay.hideButton(); setPlaybackEngine('mpv'); document.body.classList.remove('casting'); castOverlay.classList.add('hidden'); pickerShown = false; }
  if (engine === 'chromecast') { soda.cast.stop(); exitChromecast(); }
  if (engine === 'dlna') { soda.dlna.stop(); exitChromecast(); }
  soda.player.stop();
  soda.power.unblock();
  soda.media.clear(); // drop the Control Center Now Playing entry
  castDiscovering = false; // re-trigger discovery on the next load (cast.startDiscovery is idempotent)
  castAdvanceHost = null;  // returning home cancels any pending auto-next re-cast
  // reset UI back to the welcome screen
  st.loaded = st.ended = st.seeking = st.dragging = false;
  // Also reset paused. mpv emits `pause` only when it CHANGES, so a stale true here survives into
  // the next file and makes file-loaded below announce "not playing" — see the note there.
  st.paused = true;
  try { soda.player.playbackActive(false); } catch (e) {} // stopped → let a backgrounded renderer throttle
  st.duration = st.currentTime = st.vw = st.vh = 0;
  seek.value = 0; seek.max = 100; seek.disabled = true; paint(seek, 0);
  curEl.textContent = '0:00'; totEl.textContent = '0:00';
  showIcon('pause'); hideSpinner();
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; statsPanel.classList.add('hidden'); } // was polling mediaStats() forever after Stop (Audit leak)
  btnAudio.classList.add('hidden'); btnSubs.classList.add('hidden');
  qualityEl.classList.add('hidden'); closeMenus();
  soda.torrent.cancel();
  torrentActive = false; applyRouteHints();
  torrentStatus.classList.add('hidden'); torrentModal.classList.add('hidden');
  btnPrev.classList.add('hidden'); btnNext.classList.add('hidden'); playerTitle.textContent = '';
  soda.window.setTitle('Spritz');
  player.classList.add('hidden'); home.classList.remove('hidden');
  renderContinueWatching();
}

// ---- bindings ----
playpause.addEventListener('click', () => {
  if (engine === 'receiver') { receiverControl(st.paused ? 'play' : 'pause'); return; }
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
  if (engine === 'receiver') { receiverControl('seek', v); return; }
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
  thumbImg.style.visibility = 'hidden';
  thumbTime.textContent = toPlayerTime(t);
  thumbPreview.style.left = e.clientX + 'px';
  thumbPreview.classList.remove('hidden');
  clearTimeout(thumbDebounce);
  const req = ++thumbReq, owner = subtitleOwner(), file = currentLocalPath;
  const ownsPreview = () => req === thumbReq && ownsSubtitle(owner) && engine === 'mpv' && file === currentLocalPath;
  thumbDebounce = setTimeout(async () => {
    if (!ownsPreview()) return;
    let url = null; try { url = await soda.thumbAt(file, t); } catch (e) {}
    if (url && ownsPreview()) {
      thumbImg.src = url; thumbImg.style.visibility = '';
    } // ignore out-of-order responses
  }, 130);
});
seek.addEventListener('mouseleave', () => { ++thumbReq; thumbPreview.classList.add('hidden'); clearTimeout(thumbDebounce); });
seek.addEventListener('mousedown', () => { st.dragging = true; });
document.addEventListener('mouseup', () => { st.dragging = false; });
seek.addEventListener('keydown', (e) => { if ([37, 38, 39, 40].includes(e.keyCode)) e.preventDefault(); });

volSlider.addEventListener('input', () => {
  if (engine === 'receiver') return;
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
  if (engine === 'receiver') return;
  st.muted = !st.muted;
  const restoreGain = !st.muted && st.volume === 0;
  if (restoreGain) { st.volume = 0.2; volSlider.value = 20; }
  if (engine !== 'mpv') {
    // Cast engines have no mute command — emulate via volume (0 ↔ last level) on the TV.
    const r = engine === 'airplay' ? soda.airplay : engine === 'chromecast' ? soda.cast : soda.dlna;
    r.setVolume(st.muted ? 0 : (st.volume || 0.2));
  } else {
    if (restoreGain) soda.player.setVolume(st.volume);
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
  remoteSeek(t);
}
document.addEventListener('keydown', (e) => {
  // A focused button or role=button handles Space/Enter itself; the global shortcuts must not ALSO fire
  // (Space on a focused "Stop" would otherwise toggle play/pause and press Stop).
  if ((e.keyCode === 32 || e.keyCode === 13) && e.target.closest && e.target.closest('button, [role="button"]')) return;
  const tag = (e.target.tagName || '').toUpperCase();
  const typing = tag === 'TEXTAREA' || (tag === 'INPUT' &&
    !['range', 'button', 'checkbox', 'radio'].includes((e.target.type || '').toLowerCase()));
  switch (e.keyCode) {
    case 32: if (typing || !st.loaded) return; e.preventDefault(); playpause.click(); break;        // Space
    case 37: if (typing || !st.loaded) return; e.preventDefault(); seekBy(-10); break;               // ←
    case 39: if (typing || !st.loaded) return; e.preventDefault(); seekBy(10); break;                // →
    case 38: if (typing || !st.loaded) return; e.preventDefault(); volSlider.value = Math.min(100, (+volSlider.value || 0) + 5); volSlider.dispatchEvent(new Event('input')); break; // ↑ volume +5%
    case 40: if (typing || !st.loaded) return; e.preventDefault(); volSlider.value = Math.max(0, (+volSlider.value || 0) - 5); volSlider.dispatchEvent(new Event('input')); break; // ↓ volume −5%
    case 77: if (!typing && st.loaded) muteBtn.click(); break;                                        // m → mute
    case 86: if (!typing && st.loaded && engine === 'mpv') soda.player.command('cycle', 'sub-visibility'); break; // v → subtitles on/off
    case 190: if (!typing && st.loaded && engine === 'mpv') soda.player.command('frame-step'); break; // . → step one frame forward
    case 27: if (!settingsModal.classList.contains('hidden')) closeSettings(); else if ([menuAudio, menuSubs, menuCast, menuPlayback, menuPlaylist].some((m) => !m.classList.contains('hidden'))) closeMenus(); else if (st.fs) soda.fullscreen.toggle(); break; // Esc
    case 70: if (e.metaKey || !typing) { e.preventDefault(); soda.fullscreen.toggle(); } break;       // f / Cmd+F → fullscreen
    case 72: if (e.ctrlKey && engine === 'mpv') { const m = st.hwdec === 'no' ? 'auto-copy' : 'no'; soda.player.setHwdec(m); st.hwdec = m; } break; // Ctrl+H
    case 68: if (e.ctrlKey) { debug.classList.toggle('hidden'); updateDebug(); } break;              // Ctrl+D
    case 221: if (!typing && st.loaded && engine === 'mpv') setSubDelay(st.subDelay + 0.1); break;   // ]
    case 219: if (!typing && st.loaded && engine === 'mpv') setSubDelay(st.subDelay - 0.1); break;   // [
    case 220: if (!typing && st.loaded && engine === 'mpv') setSubDelay(0); break;                   // \
    // PgUp / PgDn → next / previous chapter. mpv resolves 'add chapter ±1' itself, so this needs no
    // chapter list on our side; on media without chapters it is simply a no-op.
    case 33: if (!typing && st.loaded && engine === 'mpv') soda.player.command('add', 'chapter', 1); break;   // PgUp → next chapter
    case 34: if (!typing && st.loaded && engine === 'mpv') soda.player.command('add', 'chapter', -1); break;  // PgDn → previous chapter
    case 73: if (!typing) toggleStats(); break;                                                      // i → stats overlay
    case 48: case 49: case 50: case 51: // Ctrl+0/1/2/3 → Anime4K off / A / B / C (local engine only)
      if (e.ctrlKey && st.loaded && engine === 'mpv') setAnime4k(['', 'A', 'B', 'C'][e.keyCode - 48]);
      break;
    case 188: if (e.metaKey) { e.preventDefault(); openSettings(); } else if (!typing && st.loaded && engine === 'mpv') soda.player.command('frame-back-step'); break; // Cmd+, Settings / , step one frame back
  }
});

// ---- stats overlay (codecs / bitrate / fps / dropped frames) ----
const statsPanel = $('#stats-panel');
let statsTimer = null, statsRevision = 0, statsRequest = 0;
function toggleStats() {
  ++statsRevision;
  if (statsPanel.classList.contains('hidden')) {
    statsPanel.classList.remove('hidden'); refreshStats();
    statsTimer = setInterval(refreshStats, 1000);
  } else { statsPanel.classList.add('hidden'); clearInterval(statsTimer); statsTimer = null; }
}
async function refreshStats() {
  if (statsPanel.classList.contains('hidden')) return;
  const owner = subtitleOwner(), revision = statsRevision, request = ++statsRequest;
  let s = null; try { s = await soda.player.mediaStats(); } catch (e) {}
  if (statsPanel.classList.contains('hidden') || revision !== statsRevision || request !== statsRequest || !ownsSubtitle(owner)) return;
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
  // Bound to mousemove, so this runs at pointer rate (60-120Hz while the mouse is moving) — which
  // is precisely when UI lag is felt. Only the timer needs re-arming that often; the class/cursor
  // writes and refreshAir() are only meaningful when actually LEAVING the idle state. contains()
  // is a cheap read and doesn't force layout. (Other call sites clear 'idle' directly, so the DOM
  // is the source of truth here rather than a flag that could desync from them.)
  if (controls.classList.contains('idle')) {
    controls.classList.remove('idle'); document.body.style.cursor = 'default';
    torrentStatus.classList.remove('controls-hidden'); // fade the peers/speed pill back in with the controls
    refreshAir();
  }
  clearTimeout(idleTimer);
  const owner = subtitleOwner();
  idleTimer = setTimeout(() => {
    if (!ownsSubtitle(owner)) return;
    if (!st.paused && st.loaded && engine === 'mpv') { // never auto-hide the cast remote
      controls.classList.add('idle'); document.body.style.cursor = 'none';
      torrentStatus.classList.add('controls-hidden'); // auto-hide the torrent pill alongside the controls
      refreshAir();
    }
  }, 2600);
}
document.addEventListener('mousemove', armIdle);

// The debug overlay used to show playback state only, which told you nothing when the interesting
// failures are all in the network subsystems. It now also reports what main is actually doing —
// LAN server address, what discovery has found, torrent health, and the recent errors that the
// catch-blocks swallow. This is the view that would have made a silent Local Network denial
// obvious in seconds instead of hours.
let diagTimer = null, diagBusy = false, diagRevision = 0;
const fmtAgo = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; };
async function updateDebug() {
  if (debug.classList.contains('hidden')) { ++diagRevision; if (diagTimer) { clearInterval(diagTimer); diagTimer = null; } return; }
  if (!diagTimer) diagTimer = setInterval(updateDebug, 1000); // refresh only while visible
  // One refresh in flight at a time. The 1s interval and the Ctrl+D keypress can both land here,
  // and two overlapping awaits can resolve out of order — painting older data over newer.
  if (diagBusy) return;
  diagBusy = true;
  const revision = diagRevision;
  // eslint-disable-next-line require-atomic-updates -- released by the single owner of the guard
  let d = null; try { d = await soda.diag(); } catch (e) {} finally { diagBusy = false; }
  if (revision !== diagRevision || debug.classList.contains('hidden')) return;
  const lines = [
    `pos ${toPlayerTime(st.currentTime)} / ${toPlayerTime(st.duration)}`,
    `${st.vw}x${st.vh}  hwdec=${st.hwdec}`,
    `paused=${st.paused} ended=${st.ended} seeking=${st.seeking}`
  ];
  if (d) {
    lines.push('');
    lines.push(`engine   ${d.engine || 'mpv'}`);
    if (d.runtime) {
      const r = d.runtime, versions = r.versions || {};
      lines.push(`runtime  ${r.kind || 'unknown'} ${r.platform || '?'} ${r.architecture || '?'}`);
      lines.push(`versions app=${r.appVersion || '?'} Electron=${versions.electron || 'none'} Node=${versions.node || '?'} ABI=${versions.modules || '?'}`);
      if (r.appPath) lines.push(`app      ${r.appPath}`);
      if (r.executable) lines.push(`binary   ${r.executable}`);
    }
    if (d.playbackOwner) {
      const owner = d.playbackOwner;
      lines.push(`owner    source=${owner.sourceGeneration} receiverIntent=${owner.receiverIntent}`);
      if (owner.pendingReceiver) lines.push(`pending  ${owner.pendingReceiver}`);
      if (owner.receiver) lines.push(`receiver ${owner.receiver.receiverId} epoch=${owner.receiver.epoch || 'direct'} autoplay=${owner.receiver.autoplay}`);
    }
    lines.push(`lan      ${d.lan && d.lan.address ? d.lan.address + (d.lan.port ? ':' + d.lan.port : '') : '(not serving)'}`);
    lines.push(`cast     ${d.cast.count} device(s)${d.cast.names.length ? ' — ' + d.cast.names.join(', ') : ''}`);
    lines.push(`dlna     ${d.dlna.count} renderer(s)${d.dlna.names.length ? ' — ' + d.dlna.names.join(', ') : ''}`);
    if (d.torrent) lines.push(`torrent  ${d.torrent.peers} peers, ${prettyBytes(d.torrent.speed || 0)}/s, ${Math.floor((d.torrent.progress || 0) * 100)}%`);
    if (d.engineLog && d.engineLog.length) {
      lines.push('');
      lines.push('engine changes:');
      d.engineLog.forEach((e) => lines.push(`  ${fmtAgo(e.t)} ago ${e.from} -> ${e.to}${e.reason ? ' (' + e.reason + ')' : ''}`));
    }
    if (d.errors && d.errors.length) {
      lines.push('');
      lines.push('recent errors:');
      d.errors.forEach((e) => lines.push(`  ${fmtAgo(e.t)} ago [${e.where}]${e.sourceGeneration != null ? ' source=' + e.sourceGeneration + ' intent=' + e.receiverIntent : ''} ${e.message}`));
    }
  }
  // Safe now that diagBusy makes this single-flight: only one refresh can reach this write.
  debug.textContent = lines.join('\n');
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
    li.textContent = trackLabel(t, 'Subtitle') + (t.selected && t.readyState === 1 ? ' — Loading' : t.selected && t.readyState === 3 ? ' — Unavailable' : '');
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
let prefAppliedFor = null; // owned preference lookup and per-kind reconciliation
let manualLangChoice = { audio: false, sub: false };
function recordLangPref(kind, lang) {
  manualLangChoice[kind] = true;
  const key = showKeyOf(); if (!key) return;
  const v = (kind === 'sub' && lang === 'off') ? 'off' : (lang ? String(lang).toLowerCase() : null);
  if (v == null) return; // a track with no language tag carries no reusable preference
  soda.prefs.save(key, kind === 'audio' ? { audioLang: v } : { subLang: v });
}
async function applyLangPref(audio, subs) {
  const key = showKeyOf(); if (!key) return;
  if (!prefAppliedFor || prefAppliedFor.intent !== sourceIntent || prefAppliedFor.target !== playbackTargetIntent || prefAppliedFor.key !== key) {
    prefAppliedFor = { key, intent: sourceIntent, target: playbackTargetIntent, audioDone: false, subDone: false, tuningDone: false,
      lookup: Promise.resolve().then(() => soda.prefs.get(key)).catch(() => null) };
  }
  const state = prefAppliedFor;
  state.audio = audio; state.subs = subs;
  const pref = await state.lookup;
  if (state !== prefAppliedFor || state.intent !== sourceIntent || state.target !== playbackTargetIntent || showKeyOf() !== key || engine !== 'mpv' || !pref) return;
  audio = state.audio; subs = state.subs;
  if (!state.audioDone && !manualLangChoice.audio && pref.audioLang) {
    const m = audio.find((t) => (t.lang || '').toLowerCase() === pref.audioLang);
    if (m) { state.audioDone = true; if (!m.selected) soda.player.setProperty('aid', String(m.id)); }
  }
  if (!state.subDone && !manualLangChoice.sub && pref.subLang) {
    if (pref.subLang === 'off' && subs.length) {
      state.subDone = true;
      if (subs.some((t) => t.selected)) soda.player.setProperty('sid', 'no');
    } else {
      const m = subs.find((t) => (t.lang || '').toLowerCase() === pref.subLang);
      if (m) { state.subDone = true; if (!m.selected) soda.player.setProperty('sid', String(m.id)); }
    }
  }
  if (state.tuningDone) return;
  state.tuningDone = true;
  // Restore the remembered tuning. Guarded per field so an older pref record (language only)
  // doesn't clobber the current session with zeros/defaults it never stored.
  if (typeof pref.subDelay === 'number' && pref.subDelay !== st.subDelay) setSubDelay(pref.subDelay);
  if (typeof pref.audioDelay === 'number' && pref.audioDelay !== st.audioDelay) setAudioDelay(pref.audioDelay);
  if (typeof pref.speed === 'number' && pref.speed > 0 && pref.speed !== playbackSpeed) { setSpeed(pref.speed); renderPlaybackMenu(); }
  if (typeof pref.zoom === 'number' && pref.zoom !== videoZoom) setZoom(pref.zoom);
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
  document.querySelectorAll('[data-menu][aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
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
  btn.setAttribute('aria-expanded', String(willOpen));
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('[data-menu]')) closeMenus();
});
subAddBtn.addEventListener('click', async () => {
  const owner = subtitleOwner();
  closeMenus();
  const r = await soda.dialog.openFile({
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'sub', 'smi', 'vtt'] }]
  });
  if (ownsSubtitle(owner) && r && !r.canceled && r.filePaths && r.filePaths[0]) soda.player.addSubtitleFile(r.filePaths[0]);
});
$('#sub-online').addEventListener('click', async () => {
  const owner = subtitleOwner();
  closeMenus();
  if (!currentLocalPath) { toast('Online subtitles need a local file', 3000); return; }
  toast('Searching OpenSubtitles…', 2500);
  const res = await soda.player.onlineSubtitles(currentLocalPath);
  if (!ownsSubtitle(owner)) return;
  if (res && res.ok) { soda.player.addSubtitleFile(res.srt); toast('Subtitles added: ' + (res.name || 'OpenSubtitles') + ' ✓', 3000); }
  else toast((res && res.error) || 'No subtitles found — try Whisper', 4000);
});
// Whisper is shelved (see index.html): it works, but it is too slow and too inaccurate on a
// feature-length film to sit in the menu next to two subtitle sources that are neither.
if (soda.experimental) $('#sub-generate').classList.remove('hidden');
$('#sub-generate').addEventListener('click', async () => {
  const owner = subtitleOwner();
  closeMenus();
  if (!currentLocalPath) { showSponsorToast('AI subs need a local file'); return; }
  const res = await soda.player.generateSubtitles(currentLocalPath); // Whisper (async; main posts progress notices)
  if (!ownsSubtitle(owner)) return;
  if (res && res.ok) soda.player.addSubtitleFile(res.srt);
  else toast((res && res.error) || 'Subtitle generation failed', 4000);
});
const clampDelay = (v) => Math.round(Math.max(-30, Math.min(30, v)) * 10) / 10;
const fmtDelay = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + 's';
// Tuning that should survive re-opening the same title, alongside the language prefs. mpv resets
// delays per file, and re-dialling a 300ms subtitle offset (or the speed/zoom you always use for a
// given source) on every visit is exactly the kind of thing a player should remember for you.
function savePlaybackPref(partial) { const key = showKeyOf(); if (key) soda.prefs.save(key, partial); }
function setSubDelay(v) { st.subDelay = clampDelay(v); soda.player.setSubDelay(st.subDelay); $('#sub-delay-val').textContent = fmtDelay(st.subDelay); savePlaybackPref({ subDelay: st.subDelay }); }
function setAudioDelay(v) { st.audioDelay = clampDelay(v); soda.player.setProperty('audio-delay', st.audioDelay); $('#audio-delay-val').textContent = fmtDelay(st.audioDelay); savePlaybackPref({ audioDelay: st.audioDelay }); }
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
// True while a torrent stream is still downloading. Gates the peers/speed pill so it stays
// available (on hover, via armIdle's controls-hidden) during playback of a torrent, but never
// appears for a plain local file.
const torrentStatus = $('#torrent-status'), torrentModal = $('#torrent-modal'),
  torrentFileList = $('#torrent-file-list'), torrentCancel = $('#torrent-cancel');

function clearTorrentNotice() { $('#torrent-notice').classList.add('hidden'); }
function showTorrentNotice(message, error = false) {
  $('#torrent-notice-text').textContent = (error ? 'Torrent error: ' : '') + message;
  $('#torrent-notice').classList.toggle('error', error);
  $('#torrent-notice').classList.remove('hidden');
}
$('#torrent-notice-dismiss').addEventListener('click', clearTorrentNotice);

// route an opened source: torrents go through webtorrent, everything else to mpv
// ---- playback tune menu (speed / aspect / zoom) ----
let playbackSpeed = 1, videoZoom = 0;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [['Default', '-1'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '64:27'], ['2.35:1', '2.35'], ['Stretch', '0']];
let currentAspect = '-1';
function setSpeed(v) { playbackSpeed = v; soda.player.setProperty('speed', v); savePlaybackPref({ speed: v }); }
function setAspect(v) { currentAspect = v; soda.player.setProperty('video-aspect-override', v); }
function setZoom(z) { videoZoom = Math.max(-0.5, Math.min(1, Math.round(z * 10) / 10)); soda.player.setProperty('video-zoom', videoZoom); const el = $('#zoom-val'); if (el) el.textContent = Math.round(videoZoom * 100) + '%'; savePlaybackPref({ zoom: videoZoom }); }
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
    li.classList.toggle('active', detachedQueueSource === null && i === qIndex);
    li.appendChild(name);
    const x = document.createElement('span'); x.textContent = '✕'; x.className = 'pl-remove'; x.title = 'Remove';
    x.addEventListener('click', (e) => { e.stopPropagation(); removeQueueItem(i); renderPlaylistMenu(); syncNavButtons(); });
    li.appendChild(x);
    li.addEventListener('click', () => { activateQueueItem(i); closeMenus(); });
    list.appendChild(li);
  });
  $('#pl-repeat').textContent = '↻ Repeat: ' + ({ off: 'Off', all: 'All', one: 'One' }[settings.repeat] || 'Off');
  $('#pl-shuffle').textContent = '🔀 Shuffle: ' + (settings.shuffle ? 'On' : 'Off');
}
$('#pl-repeat').addEventListener('click', (e) => { e.stopPropagation(); settings.repeat = { off: 'all', all: 'one', one: 'off' }[settings.repeat]; saveSettings(); renderPlaylistMenu(); });
$('#pl-shuffle').addEventListener('click', (e) => { e.stopPropagation(); settings.shuffle = !settings.shuffle; saveSettings(); renderPlaylistMenu(); });
$('#pl-add').addEventListener('click', async () => {
  const intent = sourceIntent, queue = playQueue;
  closeMenus();
  const r = await soda.dialog.openFile({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Media', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'ts', 'mp3', 'm4a', 'flac', 'wav'] }] });
  if (intent === sourceIntent && queue === playQueue && r && !r.canceled && r.filePaths && r.filePaths.length) { playQueue.push(...r.filePaths); syncNavButtons(); renderPlaylistMenu(); }
});

// queue helpers — a user open resets the queue; playNext walks it then auto-next-episode
const isPlaylistFile = (s) => /\.(m3u|pls)(\?|#|$)/i.test(String(s).split('?')[0]) && !/\.m3u8/i.test(s);
function removeQueueItem(index) {
  ++folderIntent;
  if (index < 0 || index >= playQueue.length) return;
  if (detachedQueueSource === null && index === qIndex) {
    detachedQueueSource = playQueue[index];
    qIndex = index - 1; // cursor preceding the next queued item; playback stays with the removed source
  } else if (index <= qIndex) qIndex--;
  playQueue.splice(index, 1);
}
function activateQueueItem(index) {
  detachedQueueSource = null;
  qIndex = index;
  routeSource(playQueue[index], true);
}
function enqueue(list, start = 0) { castAdvanceHost = null; playQueue = list.slice(); detachedQueueSource = null; qIndex = start; if (playQueue[qIndex]) routeSource(playQueue[qIndex], true); }
function playNext() {
  // Multi-file torrent: advance to the next episode via selectFile (honoring repeat/shuffle).
  if (torrentQueue.length > 1 && torrentIdx >= 0) {
    if (settings.repeat === 'one') { selectTorrentFile(torrentQueue[torrentIdx].index); return true; }
    let n = settings.shuffle ? Math.floor(Math.random() * torrentQueue.length)
      : (torrentIdx < torrentQueue.length - 1 ? torrentIdx + 1 : (settings.repeat === 'all' ? 0 : -1));
    if (n >= 0) { showSpinner(); selectTorrentFile(torrentQueue[n].index); return true; }
    return false;
  }
  if (settings.repeat === 'one' && (detachedQueueSource !== null || qIndex >= 0)) { routeSource(detachedQueueSource !== null ? detachedQueueSource : playQueue[qIndex], true); return true; } // loop current
  if (settings.shuffle && playQueue.length > 1) { // random other item
    let n = -1; while (n < 0 || detachedQueueSource === null && n === qIndex) n = Math.floor(Math.random() * playQueue.length); activateQueueItem(n); return true;
  }
  if (qIndex < playQueue.length - 1) { activateQueueItem(qIndex + 1); return true; }
  if (settings.repeat === 'all' && (playQueue.length > 1 || detachedQueueSource !== null && playQueue.length > 0)) { activateQueueItem(0); return true; } // wrap to start
  if (currentLocalPath) { // no queue left → try the next episode in the folder
    const intent = sourceIntent, request = ++folderIntent, source = currentLocalPath;
    soda.fsSiblings(source).then((info) => {
      if (intent !== sourceIntent || request !== folderIntent || currentLocalPath !== source) return;
      if (info && info.next) routeSource(info.next, false);
    }).catch(() => {});
    return true;
  }
  return false;
}
function playPrev() {
  // Multi-file torrent: step back an episode (mirror playNext's torrent branch).
  if (torrentQueue.length > 1 && torrentIdx > 0) { showSpinner(); selectTorrentFile(torrentQueue[torrentIdx - 1].index); return; }
  if (detachedQueueSource !== null && qIndex >= 0) activateQueueItem(qIndex);
  else if (qIndex > 0) activateQueueItem(qIndex - 1);
}
// Prev/Next + playlist buttons appear together whenever there's a real queue or a multi-file torrent to
// walk (function declaration → safely callable from the toggle sites above it). Episode-skip was already
// wired to the OS media keys (playNext/playPrev); these just surface it in the control bar.
function syncNavButtons() {
  const show = playQueue.length >= 2 || detachedQueueSource !== null && playQueue.length > 0 || torrentQueue.length >= 2;
  btnPrev.classList.toggle('hidden', !show);
  btnNext.classList.toggle('hidden', !show);
  btnPlaylist.classList.toggle('hidden', !show);
}
btnPrev.addEventListener('click', () => playPrev());
btnNext.addEventListener('click', () => playNext());

// ---- Continue Watching wall (home screen, from watch history) ----
const continueWatching = $('#continue-watching'), cwRow = $('#cw-row');
let continueWatchingRevision = 0;
async function renderContinueWatching() {
  const revision = ++continueWatchingRevision;
  let items = []; try { items = await soda.history.recents(12); } catch (e) {}
  if (revision !== continueWatchingRevision) return;
  items = (items || []).slice(0, 12).filter((e) => e && e.pos > 5 && e.dur && e.pos < e.dur - 20); // in-progress only
  if (!items.length) { continueWatching.classList.add('hidden'); return; }
  cwRow.innerHTML = '';
  let posterQueue = Promise.resolve();
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
    // Operable without a pointer: focusable, announced as a button with the title and progress.
    card.setAttribute('role', 'button'); card.tabIndex = 0;
    card.setAttribute('aria-label', (e.title || titleFromSrc(e.src)) + ', ' + Math.min(100, Math.round(e.pos / e.dur * 100)) + '% watched. Resume');
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); routeSource(e.src); } });
    cwRow.appendChild(card);
    if (/^\//.test(e.src)) posterQueue = posterQueue.then(async () => {
      if (revision !== continueWatchingRevision || !card.isConnected) return;
      const url = await soda.thumbAt(e.src, Math.max(1, e.pos), 'poster'); // poster = frame at resume point
      if (!url || revision !== continueWatchingRevision || !card.isConnected) return;
      const img = document.createElement('img'); img.src = url; thumb.replaceChild(img, glyph);
    }).catch(() => {});
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
  const owner = subtitleOwner(), text = torrentStatus.textContent;
  clearTimeout(sponsorToastT); sponsorToastT = setTimeout(() => {
    if (ownsSubtitle(owner) && torrentStatus.textContent === text) torrentStatus.classList.add('hidden');
  }, ms || 2200);
}
function showSponsorToast(cat) { toast('⏭ Skipped ' + (SPONSOR_LABEL[cat] || cat), 1600); }

// ---- Settings (persisted in localStorage; the single source of truth for video toggles) ----
const settingsModal = $('#settings-modal');
const settings = (() => {
  const def = { interpolation: false, anime4k: '', skipSponsors: true, subSize: 46, subBg: false, requireVpn: false, repeat: 'off', shuffle: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem('spritz-settings') || '{}')); } catch (e) { return def; }
})();
function saveSettings() { try { localStorage.setItem('spritz-settings', JSON.stringify(settings)); } catch (e) {} }
// Manual TV addresses. Discovery is best-effort by nature — multicast can be filtered, a TV's
// discovery service can be asleep, and macOS can deny local-network access without saying so. This
// is the escape hatch: probe these hosts directly, in addition to (never instead of) normal
// discovery, so a TV that never announces itself is still reachable.
function applyCastHosts() {
  const el = $('#set-cast-hosts'); if (!el) return;
  settings.castHosts = el.value || '';
  saveSettings();
  try { soda.cast.setManualHosts(settings.castHosts); } catch (e) {}
}
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
  try { soda.cast.setManualHosts(settings.castHosts || ''); } catch (e) {} // manual TV addresses active from launch
}
function openSettings() {
  $('#set-interp').checked = settings.interpolation; $('#set-anime4k').value = settings.anime4k; $('#set-sponsors').checked = settings.skipSponsors;
  $('#set-subsize').value = String(settings.subSize); $('#set-subbg').checked = settings.subBg; $('#set-requirevpn').checked = settings.requireVpn;
  $('#set-cast-hosts').value = settings.castHosts || '';
  refreshVpnState();
  settingsModal.classList.remove('hidden');
}
function closeSettings() { settingsModal.classList.add('hidden'); }
$('#set-cast-hosts').addEventListener('change', applyCastHosts);
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
  if (engine === 'receiver') { receiverControl('seek', t); return; }
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
  torrentActive = true; applyRouteHints();
  torrentStatus.classList.remove('hidden', 'controls-hidden'); torrentStatus.textContent = 'connecting…';
  soda.torrent.add(s);
}
function routeSource(src, fromQueue, opts) {
  clearTorrentNotice();
  if (engine === 'receiver') leaveReceiver(false);
  clearErrorStop();
  const intent = ++sourceIntent;
  ++folderIntent;
  const s = String(src).trim();
  paintBuffered([]); // clear any stale torrent-buffered overlay from the previous source
  // Drop the previous file's decoded dimensions so the cast-routing 4K check (is4kSource) and the
  // quality badge don't read stale values when switching files WITHOUT a stop() (queue / next-episode
  // / Continue-Watching / drag-drop). They repopulate from the new file's dwidth/dheight. (Audit H6)
  st.vw = 0; st.vh = 0; updateQuality();
  manualLangChoice = { audio: false, sub: false };
  prefAppliedFor = null; // re-apply the show's saved language to this newly-loaded episode
  if (!fromQueue) { // user-initiated open
    if (isPlaylistFile(s)) { soda.parsePlaylist(s).then((items) => { if (intent === sourceIntent && items && items.length) enqueue(items.map((i) => i.url)); }).catch(() => {}); return; }
    playQueue = [s]; detachedQueueSource = null; qIndex = 0; advancing = false; // single-item queue
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
        if (intent !== sourceIntent) return;
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
  scheduleErrorStop(2400);
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
  clearTorrentNotice();
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
soda.torrent.onProgress((p) => {
  if (!torrentActive) return; // a queued tick must not resurrect a failed/stopped stream
  paintBuffered(p.buffered);
  const model = SpritzTorrentStatus.model(p, { loaded: st.loaded, paused: st.paused, prettyBytes });
  if (model.complete) { torrentStatus.classList.add('hidden'); return; }
  torrentStatus.classList.remove('hidden', 'controls-hidden');
  const dot = document.createElement('span'); dot.className = 'dot ' + model.dot;
  torrentStatus.replaceChildren(dot, document.createTextNode(model.text));
  torrentStatus.title = 'Torrent stream: ' + model.text;
});
soda.torrent.onReady(({ url }) => { if (torrentActive) soda.player.load(url); });
soda.torrent.onWarning(({ message }) => { if (torrentActive) showTorrentNotice(message); });
soda.torrent.onError(({ message }) => {
  if (!torrentActive) return;
  console.error('[torrent]', message);
  stop();
  showTorrentNotice(message, true); // home-screen explanation survives progress ticks until dismissed
});
torrentCancel.addEventListener('click', () => { torrentModal.classList.add('hidden'); stop(); });

// ---- Cast / AirPlay — ONE button, unified menu (AirPlay + Chromecast + DLNA) ----
// AirPlay can't be opened programmatically (you must click the native AVRoutePickerView), so the
// picker is overlaid on the "AirPlay" row of the cast menu and shown only while that menu is open.
$('#cast-airplay-detail').textContent = SpritzRouteHints.routeDetail('airplay');
$('#cast-airplay-row').title = SpritzRouteHints.routeTooltip('airplay');
const airRow = $('#cast-airplay-row'), castOverlay = $('#casting-overlay'), castStop = $('#cast-stop');
// The native picker centres its glyph in the rectangle it is given, so give it only the strip the row pads for it.
const PICKER_STRIP = 44;
function airRect() { const r = airRow.getBoundingClientRect(); return { x: r.left, y: r.top, w: Math.min(r.width, PICKER_STRIP), h: r.height }; }
// The picker is a native view laid over the AirPlay row, and it is not clipped by the menu. When the menu scrolls
// (it is height-capped) the row can leave the visible part, and the picker must go with it, not hover over
// whatever scrolled underneath.
function airRowVisible() {
  const r = airRow.getBoundingClientRect();
  if (!r.width) return false;
  const m = document.getElementById('menu-cast').getBoundingClientRect();
  return r.top >= m.top - 1 && r.bottom <= m.bottom + 1;
}
function placePicker() {
  if (!pickerShown) return;
  if (airRowVisible()) soda.airplay.showButton(airRect()); else soda.airplay.hideButton();
}
function showPicker(show) {
  pickerShown = show;
  if (show) requestAnimationFrame(placePicker); else soda.airplay.hideButton();
}
function refreshAir() { refreshCast(); } // the single button + picker are driven by refreshCast/the menu
function repositionPicker() { placePicker(); }
function enterCasting() {
  setPlaybackEngine('airplay'); document.body.classList.add('casting');
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
let airTrackRequest = 0;
async function populateAirTracks() {
  if (engine !== 'airplay') return;
  const owner = subtitleOwner(), request = ++airTrackRequest;
  let t = null; try { t = await soda.airplay.mediaTracks(); } catch (e) {}
  if (engine !== 'airplay' || !ownsSubtitle(owner) || request !== airTrackRequest) return;
  const ownsMenu = () => engine === 'airplay' && ownsSubtitle(owner) && request === airTrackRequest;
  const refreshOwned = () => { if (ownsMenu()) populateAirTracks(); };
  const audio = (t && t.audio) || [], subs = (t && t.subs) || [];
  audioList.innerHTML = '';
  audio.forEach((o, i) => {
    const li = document.createElement('li');
    li.textContent = o.name || ('Audio ' + (i + 1));
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { if (!ownsMenu()) return; soda.airplay.selectAudio(i); closeMenus(); setTimeout(refreshOwned, 350); });
    audioList.appendChild(li);
  });
  btnAudio.classList.toggle('hidden', audio.length < 2);
  subList.querySelectorAll('li[data-track], li.cast-subsync').forEach((n) => n.remove());
  const offLi = subList.querySelector('li[data-sid="off"]');
  offLi.classList.toggle('active', !subs.some((o) => o.selected));
  offLi.onclick = () => { if (!ownsMenu()) return; soda.airplay.selectSubtitle(-1); closeMenus(); setTimeout(refreshOwned, 350); };
  subs.forEach((o, i) => {
    const li = document.createElement('li');
    li.dataset.track = i;
    li.textContent = o.name || ('Subtitle ' + (i + 1));
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { if (!ownsMenu()) return; soda.airplay.selectSubtitle(i); closeMenus(); setTimeout(refreshOwned, 350); });
    subList.appendChild(li);
  });
  btnSubs.classList.toggle('hidden', subs.length === 0);
  // Keep polling while the groups still haven't arrived (≤30s) — they load asynchronously.
  if (engine === 'airplay' && btnAudio.classList.contains('hidden') && btnSubs.classList.contains('hidden')
      && Date.now() - airTracksStart < 30000) {
    clearTimeout(airPollTimer); airPollTimer = setTimeout(refreshOwned, 1000);
  }
}
function exitCasting() {
  if (engine !== 'airplay') return;
  setPlaybackEngine('mpv'); document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
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
  if (engine === 'receiver') { leaveReceiver(true); return; }
  if (engine === 'chromecast') { soda.cast.stop(); exitChromecast(); }
  else if (engine === 'dlna') { soda.dlna.stop(); exitChromecast(); } // was falling through to airplay → DLNA never stopped (Audit H4)
  else { soda.airplay.stop(); exitCasting(); }
});

// ---- Google Cast (Chromecast / LG webOS) ----
const castBtn = $('#cast'), menuCast = $('#menu-cast'), castList = menuCast.querySelector('.list');
// The menu is anchored to the bottom, so a row appearing above the AirPlay row (a TV asking to pair, a
// device found late) moves it. The picker is a native view laid over that row and has to follow.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => { if (pickerShown) requestAnimationFrame(placePicker); }).observe(menuCast);
}
menuCast.addEventListener('scroll', () => { if (pickerShown) requestAnimationFrame(placePicker); }, { passive: true });

let castDevices = [], dlnaDevices = [], castDiscovering = false;
// Discovery can fail for reasons the app cannot see — most painfully, macOS silently denying the
// Local Network grant, which makes every LAN probe fail instantly with EHOSTUNREACH. The menu used
// to say "Searching for TVs…" forever in that case, giving the user nothing to act on. After a
// grace period with nothing found, say what to check instead.
let castSearchTimedOut = false, castSearchTimer = null;
function armCastSearchTimeout() {
  clearTimeout(castSearchTimer);
  castSearchTimedOut = false;
  castSearchTimer = setTimeout(() => {
    if (!allDevices().length) { castSearchTimedOut = true; renderCastMenu(); }
  }, 20000);
}
let castHost = null;        // host of the active Chromecast session (for auto-next re-cast)
let castAdvanceHost = null; // set when a cast finished and we're routing the next item to re-cast to this host
// Eligibility: a TV-fetchable source + at least one discovered device (Chromecast OR DLNA).
// The SAME TV often shows up as both a Cast target and a DLNA renderer. The DLNA route plays the ORIGINAL
// file natively — full 4K HEVC / HDR / Dolby Vision, surround audio, the TV's own subtitle/language menus,
// no transcode — so it is listed first for that TV. cast-routes.js decides the order and what each row says
// (DLNA vs Google Cast), and demotes a Cast route that recently failed to connect.
const castFailures = {};       // host -> when a Google Cast connect last failed (this session only)
let lastCastAttempt = null;    // { name, host, hasDlna } of the Cast route the person last chose
function allDevices() {
  return SpritzCastRoutes.describeRoutes({ casts: castDevices, dlnas: dlnaDevices, failures: castFailures, now: Date.now() });
}
function refreshCast() {
  // Start discovery as soon as ANY media loads — NOT gated on castable. The eureka /24 sweep
  // (the only way LG webOS is found) then runs concurrently with the slow HLS probe+remux, so
  // devices are already warm when castable flips, instead of starting a fresh sweep only after.
  const loaded = engine === 'mpv' && st.loaded;
  if (loaded && !castDiscovering) { castDiscovering = true; soda.cast.discover(); soda.dlna.discover(); armCastSearchTimeout(); }
  // ONE Cast/AirPlay button: show whenever the source is castable + playing. AirPlay is ALWAYS
  // offered (first menu row, backed by the native picker); Chromecast/DLNA rows are added as
  // discovery finds them — so the button no longer waits on a device being discovered first.
  // The cast button also appears when a Spritz Receiver needs attention, even with nothing playing:
  // a television waiting to be paired has to be reachable, and pairing is not a thing you do halfway
  // through a film. Found on hardware — with no media open there was no menu, and therefore no way
  // to pair from the real application at all.
  const receiverNeedsUi = (typeof receiverPending !== 'undefined' && receiverPending.length > 0)
    || (typeof receiverTargets !== 'undefined' && receiverTargets.length > 0);
  castBtn.classList.toggle('hidden', !((castable && loaded) || receiverNeedsUi));
}
// 4K source? (mpv reports the decoded size; 2160/3840 ≫ 1080p so a midpoint threshold is safe.)
function is4kSource() { return st.vh >= 1500 || st.vw >= 2600; }
// The DLNA endpoint for the SAME TV as a Chromecast host, if discovered (so we can prefer it).
function dlnaRefForHost(host) {
  const d = dlnaDevices.find((x) => { try { return new URL(x.location).hostname === host; } catch (e) { return false; } });
  return d ? d.location : null;
}
// ---- Spritz Receivers --------------------------------------------------------------------------
//
// A receiver is another row in the same cast menu: to the viewer, choosing the LG in the living room
// is the same kind of choice whether it speaks AirPlay, Chromecast or Spritz's own protocol.
//
// The renderer holds IDS and status only. It never sees a credential and never sees a pairing code —
// the code is on the television's screen, and the human types it here. Everything that could grant
// authority happens in the main process.
let receiverSelection = 0, activeReceiver = null;
function enterReceiver(target, mediaId) {
  activeReceiver = { id: target.id, mediaId, source: sourceIntent, position: st.currentTime };
  setPlaybackEngine('receiver');
  soda.player.pause();
  document.body.classList.add('casting');
  castOverlay.querySelector('.cast-text').textContent = 'Playing on ' + (target.name || 'TV');
  castStop.textContent = 'Return to Mac';
  castOverlay.classList.remove('hidden'); hideSpinner();
  showPicker(false); castBtn.classList.add('hidden');
  btnAudio.classList.remove('hidden'); btnSubs.classList.remove('hidden');
  if (typeof receiverTrackMenus === 'function') receiverTrackMenus({ epoch: null, tracks: { audio: [], subtitles: [] } });
  volSlider.disabled = muteBtn.disabled = true;
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  syncReceiverPlayback();
}
async function receiverControl(command, arg) {
  const owner = activeReceiver;
  if (engine !== 'receiver' || !owner || owner.source !== sourceIntent) return;
  try {
    const result = await soda.receiver.command(owner.id, command, arg);
    if (activeReceiver !== owner || engine !== 'receiver') return;
    if (!result || !result.ok) toast((result && result.why) || 'Receiver command failed', 3500);
  } catch (e) { if (activeReceiver === owner) toast('Receiver command failed', 3500); }
}
function receiverTrackMenus(p) {
  if (!p.tracks || !activeReceiver) return;
  const signature = JSON.stringify(p.tracks);
  if (activeReceiver.trackSignature === signature) return;
  activeReceiver.trackSignature = signature;
  const owner = activeReceiver, epoch = p.epoch;
  const choose = (kind, id) => {
    if (activeReceiver !== owner || engine !== 'receiver') return;
    receiverControl('select-track', { mediaId: owner.mediaId, epoch, kind, trackId: id }); closeMenus();
  };
  audioList.innerHTML = '';
  p.tracks.audio.forEach(t => {
    const li = document.createElement('li'); li.textContent = trackLabel(t, 'Audio');
    li.classList.toggle('active', t.selected); li.onclick = () => choose('audio', t.id); audioList.appendChild(li);
  });
  btnAudio.classList.remove('hidden');
  if (!p.tracks.audio.length) { const li = document.createElement('li'); li.textContent = 'No audio tracks reported by TV'; audioList.appendChild(li); }
  subList.querySelectorAll('li[data-track], li.cast-subsync').forEach(n => n.remove());
  const off = subList.querySelector('li[data-sid="off"]');
  off.classList.toggle('active', !p.tracks.subtitles.some(t => t.selected)); off.onclick = () => choose('subtitle', 'off');
  p.tracks.subtitles.forEach(t => {
    const li = document.createElement('li'); li.dataset.track = t.id; li.textContent = trackLabel(t, 'Subtitle');
    li.classList.toggle('active', t.selected); li.onclick = () => choose('subtitle', t.id); subList.appendChild(li);
  });
  btnSubs.classList.remove('hidden');
  if (!p.tracks.subtitles.length) { const li = document.createElement('li'); li.dataset.track = 'unavailable'; li.textContent = 'No subtitles reported by TV'; subList.appendChild(li); }
}
function syncReceiverPlayback() {
  if (engine !== 'receiver' || !activeReceiver || activeReceiver.source !== sourceIntent) return;
  const target = receiverTargets.find(r => r.id === activeReceiver.id), p = target && target.playback;
  seek.disabled = !target || target.status !== 'online';
  if (!p || p.mediaId !== activeReceiver.mediaId) return;
  if (typeof receiverTrackMenus === 'function') receiverTrackMenus(p);
  if (p.state === 'playing' || p.state === 'paused') st.paused = p.state === 'paused';
  else if (typeof p.paused === 'boolean') st.paused = p.paused;
  if (Number.isFinite(p.currentTime) && p.currentTime >= 0) { st.currentTime = p.currentTime; activeReceiver.position = p.currentTime; }
  if (Number.isFinite(p.durationSec) && p.durationSec > 0) st.duration = p.durationSec;
  showIcon(st.paused ? 'play' : 'pause');
  seek.disabled = target.status !== 'online';
  updateRemoteTime(st.currentTime, st.duration);
}
async function leaveReceiver(resumeLocal) {
  const owner = activeReceiver, position = owner && owner.position;
  if (!owner) return;
  const request = ++receiverSelection;
  if (!resumeLocal) {
    activeReceiver = null;
    setPlaybackEngine('mpv'); document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
    volSlider.disabled = muteBtn.disabled = false;
    soda.receiver.command(owner.id, 'stop').catch(() => {});
    return;
  }
  let result;
  try { result = await soda.receiver.command(owner.id, 'stop'); } catch (e) { result = { ok: false }; }
  if (activeReceiver !== owner || request !== receiverSelection) return;
  if (resumeLocal && (!result || !result.ok)) { toast('Could not stop receiver; retry Return to Mac', 3500); return; }
  activeReceiver = null;
  setPlaybackEngine('mpv'); document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
  volSlider.disabled = muteBtn.disabled = false;
  refreshCast();
  if (resumeLocal && owner.source === sourceIntent) {
    restoreReceiverPosition(position);
  }
}
function restoreReceiverPosition(position) {
  soda.player.pause(); soda.player.seek(position); st.paused = true; showIcon('play');
}
let receiverTargets = [];
let receiverPending = [];
let receiverTargetRevision = 0, receiverPairingRevision = 0;
let receiverTargetRequest = 0, receiverPairingRequest = 0;
async function refreshReceiverState(includePending = true) {
  const targetRequest = ++receiverTargetRequest, targetsAt = receiverTargetRevision;
  const pairingRequest = includePending ? ++receiverPairingRequest : receiverPairingRequest;
  const pairingAt = receiverPairingRevision;
  const targets = await soda.receiver.list();
  if (targetRequest === receiverTargetRequest && targetsAt === receiverTargetRevision) receiverTargets = targets;
  if (includePending) {
    const pending = await soda.receiver.pending();
    if (pairingRequest === receiverPairingRequest && pairingAt === receiverPairingRevision) receiverPending = pending;
  }
}

function renderReceivers() {
  const section = document.getElementById('receiver-section');
  const list = document.getElementById('receiver-list');
  const pair = document.getElementById('receiver-pair');
  if (!section || !list || !pair) return;

  list.innerHTML = '';
  section.classList.toggle('hidden', receiverTargets.length === 0);
  // A Spritz Receiver that is online supports everything (audio and subtitles from the Mac or the TV), so it leads.
  document.getElementById('menu-cast').classList.toggle('receiver-first', receiverTargets.some((r) => r.status === 'online'));
  receiverTargets.forEach((r) => {
    const li = document.createElement('li');
    li.className = 'cast-dev receiver-dev';
    const name = document.createElement('span');
    name.textContent = r.name;
    const right = document.createElement('span');
    const status = document.createElement('span');
    status.className = 'receiver-status' + (r.status === 'online' ? ' online' : '');
    // What the television is actually doing, from its own clock. `stalled` is deliberately not
    // shown: measured on this hardware it fires at every segment boundary while playback is perfect,
    // and surfacing it would invent a problem the viewer does not have.
    status.textContent = r.status === 'online'
      ? (r.playback && r.playback.state && r.playback.state !== 'idle'
        ? r.playback.state + (Number.isFinite(r.playback.currentTime) ? ' · ' + fmtTime(r.playback.currentTime) : '')
        : 'ready')
      : 'offline';
    const forget = document.createElement('span');
    forget.className = 'receiver-forget';
    forget.textContent = 'Forget';
    forget.title = 'Revoke this television\u2019s credential. It will have to be paired again.';
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      await soda.receiver.forget(r.id);
      await refreshReceiverState(false);
      renderReceivers();
    });
    right.appendChild(status);
    right.appendChild(forget);
    li.appendChild(name);
    li.appendChild(right);
    const detail = document.createElement('div'); detail.className = 'cast-detail receiver-detail';
    detail.textContent = SpritzRouteHints.routeDetail('receiver');
    li.appendChild(detail);
    li.title = SpritzRouteHints.routeTooltip('receiver');
    if (r.status === 'online') {
      li.addEventListener('click', async () => {
        closeMenus();
        const owner = subtitleOwner(), request = ++receiverSelection;
        const res = await soda.receiver.play(r.id);
        if (!ownsSubtitle(owner) || request !== receiverSelection) return;
        if (!res || !res.ok) toast((res && res.why) || 'Could not send to that receiver', 3500);
        else enterReceiver(r, res.mediaId);
      });
    } else {
      li.style.opacity = '.5';
      li.title = 'This television is not connected to Spritz right now.';
    }
    list.appendChild(li);
  });

  // A television asking to be paired. Only one prompt at a time — pairing is a deliberate act, and a
  // queue of them would be a way to trick someone into approving the wrong screen.
  const p = receiverPending[0] || null;
  pair.classList.toggle('hidden', !p);
  if (p) {
    const nameEl = document.getElementById('receiver-pair-name');
    if (nameEl) nameEl.textContent = p.name || 'Spritz Receiver';
  }
}

// The home-screen Devices block. The cast menu is for CHOOSING where to play; this is for pairing,
// status and forgetting — which must work with nothing open, because a television asking to pair
// does not wait for you to start a film.
function renderHomeDevices() {
  const box = document.getElementById('devices');
  const list = document.getElementById('devices-list');
  const pair = document.getElementById('home-pair');
  if (!box || !list || !pair) return;

  const pending = receiverPending[0] || null;
  // Always visible. It used to hide until a TV was paired or asking to pair, which left a first-time
  // user whose TV could not find this Mac with nowhere to read the address to type on the TV.
  box.classList.remove('hidden');
  box.classList.toggle('compact', receiverTargets.length === 0 && !pending);
  const empty = document.getElementById('devices-empty');
  if (empty) empty.classList.toggle('hidden', receiverTargets.length > 0 || !!pending);
  const installer = document.getElementById('devices-installer');
  if (installer && !installer.dataset.wired) {
    installer.dataset.wired = '1';
    installer.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = await soda.receiver.revealInstaller().catch(() => ({ ok: false, why: 'Could not show the installer.' }));
      toast(r.ok ? 'Revealed ' + r.name : r.why, 3200);
    });
  }
  const addr = document.getElementById('devices-address');
  if (addr && window.soda && soda.receiver && soda.receiver.macAddress) {
    soda.receiver.macAddress().then((ip) => {
      addr.textContent = ip ? 'If your TV can\u2019t find this Mac, type this address on the TV: ' + ip : '';
    }).catch(() => {});
  }

  list.innerHTML = '';
  receiverTargets.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = r.name;
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    meta.textContent = 'Spritz Receiver' + (r.version ? ' ' + r.version : '') + ' · ' + (r.status === 'online' ? 'Paired • Online' : 'Paired • Offline') +
      (r.status !== 'online' && Number.isFinite(r.lastSeen) && r.lastSeen > 0
        ? ' · last seen ' + new Date(r.lastSeen).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '') +
      (r.versionStatus === 'update' ? ' · older than this Spritz — reinstall the receiver from the same release' : '');
    left.appendChild(name); left.appendChild(meta);
    const forget = document.createElement('span');
    forget.className = 'receiver-forget';
    forget.textContent = 'Forget';
    forget.title = 'Revoke this television\u2019s credential. It will have to be paired again.';
    forget.addEventListener('click', async () => {
      await soda.receiver.forget(r.id);
      await refreshReceiverState(false);
      renderHomeDevices(); renderReceivers();
    });
    row.appendChild(left); row.appendChild(forget);
    list.appendChild(row);
  });

  pair.classList.toggle('hidden', !pending);
  if (pending) {
    const n = document.getElementById('home-pair-name');
    if (n) n.textContent = pending.name || 'Spritz Receiver';
  }
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}

async function initReceivers() {
  if (!window.soda || !soda.receiver) return;
  soda.receiver.onEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'targets') { ++receiverTargetRevision; receiverTargets = ev.targets || []; renderReceivers(); renderHomeDevices(); refreshCast(); if (typeof syncReceiverPlayback === 'function') syncReceiverPlayback(); }
    else if (ev.type === 'track-load' && activeReceiver && activeReceiver.id === ev.receiverId && activeReceiver.mediaId === ev.previousMediaId) {
      activeReceiver.mediaId = ev.mediaId; activeReceiver.trackSignature = null;
    } else if (ev.type === 'track-pending' && activeReceiver && activeReceiver.id === ev.receiverId && ev.pending) toast('Preparing audio track…', 2500);
    else if (ev.type === 'track-error') toast(ev.why || 'Track selection failed', 3500);
    else if (ev.type === 'pairing') { ++receiverPairingRevision; receiverPending = ev.pending || []; renderReceivers(); renderHomeDevices(); refreshCast(); }
    else if (ev.type === 'position') {
      if (!ev.position || !Number.isFinite(ev.position.currentTime) || ev.position.currentTime < 0) return;
      const t = receiverTargets.find((r) => r.id === ev.position.receiverId);
      if (t && t.playback && ((ev.position.mediaId != null && ev.position.mediaId !== t.playback.mediaId) ||
          (ev.position.epoch != null && ev.position.epoch !== t.playback.epoch))) return;
      if (t && t.playback) { ++receiverTargetRevision; t.playback.currentTime = ev.position.currentTime;
        if (typeof ev.position.paused === 'boolean') t.playback.paused = ev.position.paused;
        renderReceivers(); if (typeof syncReceiverPlayback === 'function') syncReceiverPlayback(); }
    } else if (ev.type === 'error' && ev.error && ev.error.fatal) {
      const target = receiverTargets.find((r) => r.id === ev.error.receiverId), playback = target && target.playback;
      if (playback && playback.mediaId != null && ev.error.mediaId != null && playback.mediaId !== ev.error.mediaId) return;
      if (playback && playback.epoch != null && ev.error.epoch != null && playback.epoch !== ev.error.epoch) return;
      toast('Receiver playback error: ' + (ev.error.message || ev.error.code || 'unknown'), 4000);
    }
  });
  wirePairForm('receiver-pair-go', 'receiver-code', 'receiver-pair-error');
  wirePairForm('home-pair-go', 'home-code', 'home-pair-error');
  try {
    await refreshReceiverState();
    renderReceivers();
    renderHomeDevices();
  } catch (e) { /* the receiver service may not be up yet; events will fill it in */ }
}

// One pairing form, used from both the home screen and the cast menu. Written once so the two
// cannot drift into behaving differently.
function wirePairForm(goId, inputId, errId) {
  const go = document.getElementById(goId); // an older layout had a button; the field now submits itself
  const input = document.getElementById(inputId);
  const err = document.getElementById(errId);
  const submit = async () => {
    if (!input) return;
    // Read and clear BEFORE the await. Assigning input.value after it would race a viewer who has
    // started typing the next code, and eslint is right to refuse it.
    const code = input.value.trim();
    if (code.length !== 4) return;
    input.value = '';
    const res = await soda.receiver.pair(code);
    if (res && res.ok) {
      if (err) err.classList.add('hidden');
      await refreshReceiverState();
      renderReceivers();
      renderHomeDevices();
      toast('Paired', 2000);
    } else if (err) {
      // Codes expire and repeated wrong guesses cancel the pairing on purpose, so the honest advice is
      // to look at the television again.
      err.textContent = 'Code didn\u2019t match. Check the TV for the current one.';
      err.classList.remove('hidden');
    }
  };
  if (go) go.addEventListener('click', submit);
  if (input) {
    // Digits only, and the fourth one sends it: there is nothing else to press.
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 4);
      if (digits !== input.value) input.value = digits;
      if (err) err.classList.add('hidden');
      if (digits.length === 4) submit();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
}

function renderCastMenu() {
  // Keep the static AirPlay row (the native picker overlays it); rebuild only the device rows.
  castList.querySelectorAll('li.cast-dev, li.cast-empty').forEach((n) => n.remove());
  allDevices().forEach((d) => {
    const li = document.createElement('li'); li.className = 'cast-dev' + (d.failed ? ' failed' : '');
    const nm = document.createElement('div'); nm.className = 'cast-name'; nm.textContent = d.name;
    const dt = document.createElement('div'); dt.className = 'cast-detail'; dt.textContent = d.detail;
    li.appendChild(nm); li.appendChild(dt);
    if (d.tooltip) li.title = d.tooltip;
    li.addEventListener('click', () => {
      closeMenus(); showSpinner(); armCastWatchdog(d.name);
      if (d.kind === 'dlna') { soda.dlna.load(d.ref); return; }
      lastCastAttempt = { name: d.name, host: d.host, hasDlna: !!dlnaRefForHost(d.host) };
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
    const li = document.createElement('li'); li.className = 'cast-empty';
    if (castSearchTimedOut) {
      li.classList.add('cast-empty-warn');
      li.textContent = 'No TVs found';
      const hint = document.createElement('div'); hint.className = 'cast-empty-hint';
      hint.textContent = 'Check the TV is on, and that Spritz is enabled under System Settings → Privacy & Security → Local Network.';
      li.appendChild(hint);
      li.title = 'Spritz probes the local network directly. If macOS has denied Local Network access, every probe fails instantly and no device can ever be found.';
    } else li.textContent = 'Searching for TVs…';
    castList.appendChild(li);
  }
  if (pickerShown) requestAnimationFrame(placePicker); // keep the picker over the AirPlay row after a rebuild
}
// A line under each track menu saying who changes the choice (this Mac or the TV), what a change costs,
// and what a torrent that is still downloading cannot do. The wording is in route-hints.js. DLNA hands the
// TV the original file, so there the Mac's own list is hidden and the note is all there is — hiding the
// buttons instead read as "this film has no other tracks".
function applyRouteHints() {
  const notes = SpritzRouteHints.trackNotes({ engine, torrent: torrentActive });
  [[menuAudio, btnAudio, notes.audio], [menuSubs, btnSubs, notes.subs]].forEach(([menu, btn, note]) => {
    const el = menu.querySelector('.menu-note');
    if (!el) return;
    el.textContent = note ? note.text : '';
    el.classList.toggle('hidden', !note);
    menu.classList.toggle('note-only', !!(note && note.only));
    if (note && note.only) btn.classList.remove('hidden'); // the button is how the person finds the note
  });
}
function enterChromecast(eng, name) {
  setPlaybackEngine(eng); document.body.classList.add('casting');
  castOverlay.querySelector('.cast-text').textContent = 'Casting to ' + (name || 'TV');
  castStop.textContent = 'Stop Casting'; // DLNA/Chromecast — not AirPlay (the button text is otherwise stale)
  castOverlay.classList.remove('hidden'); hideSpinner();
  castBtn.classList.add('hidden'); pickerShown = false; soda.airplay.hideButton(); closeMenus();
  btnAudio.classList.add('hidden'); btnSubs.classList.add('hidden'); // until the receiver reports tracks
  applyRouteHints();
  showIcon('pause'); seek.disabled = false;
  controls.classList.remove('idle'); document.body.style.cursor = 'default';
  // HLS-embedded audio/subtitle renditions can surface late and asymmetrically on the receiver →
  // poll on a ladder and keep re-polling on status events for a bounded window (see cast onEvent).
  if (eng === 'chromecast') {
    castPollUntil = Date.now() + 12000;
    const owner = subtitleOwner();
    [0, 800, 1800, 3500, 6000, 9000].forEach((ms) => setTimeout(() => {
      if (engine === 'chromecast' && ownsSubtitle(owner)) populateCastTracks();
    }, ms));
  }
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
let castTrackRequest = 0;
async function populateCastTracks() {
  if (engine !== 'chromecast') return;
  const request = ++castTrackRequest;
  const owner = subtitleOwner();
  let t = null; try { t = await soda.cast.mediaTracks(); } catch (e) {}
  if (request !== castTrackRequest || !ownsSubtitle(owner) || engine !== 'chromecast') return;
  const ownsMenu = () => engine === 'chromecast' && ownsSubtitle(owner) && request === castTrackRequest;
  const refreshOwned = () => { if (ownsMenu()) populateCastTracks(); };
  const audio = (t && t.audio) || [], subs = (t && t.subs) || [];
  audioList.innerHTML = '';
  if (castIsMkv && castSrcAudio.length) {
    // language menu = source tracks; selecting re-casts at the current position (main: cast:setSourceAudio)
    castSrcAudio.forEach((o, i) => {
      const li = document.createElement('li');
      li.textContent = o.name || ('Audio ' + (i + 1));
      li.classList.toggle('active', i === castSrcAudioActive);
      li.addEventListener('click', () => { if (!ownsMenu()) return; castSrcAudioActive = i; soda.cast.selectSourceAudio(i); closeMenus(); showSpinner(); });
      audioList.appendChild(li);
    });
    btnAudio.classList.toggle('hidden', castSrcAudio.length < 2);
  } else {
  audio.forEach((o) => {
    const li = document.createElement('li');
    li.textContent = o.name;
    li.classList.toggle('active', !!o.selected);
    li.addEventListener('click', () => { if (!ownsMenu()) return; soda.cast.selectAudio(o.id); closeMenus(); setTimeout(refreshOwned, 500); });
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
    if (!ownsMenu()) return;
    closeMenus();
    if (mkvSubs) {
      castSrcSubActive = -1;
      if (castBurnActive != null) { soda.cast.selectBurnSub(-1); showSpinner(); } // un-burn = re-cast
      else { soda.cast.selectSubtitle(-1); setTimeout(refreshOwned, 200); }
    } else { soda.cast.selectSubtitle(-1); setTimeout(refreshOwned, 200); }
  };
  subItems.forEach((o, i) => {
    const li = document.createElement('li');
    li.dataset.track = o.id != null ? o.id : ('b' + o.subIdx);
    li.textContent = o.name + (o.burn ? '  ·  burn-in' : ''); // bitmap subs are composited onto the video
    li.classList.toggle('active', mkvSubs ? (i === castSrcSubActive) : !!o.selected);
    li.addEventListener('click', () => {
      if (!ownsMenu()) return;
      closeMenus();
      if (mkvSubs) {
        castSrcSubActive = i;
        if (o.burn) { soda.cast.selectBurnSub(o.subIdx); showSpinner(); } // bitmap → burn-in re-cast (~2s)
        else { soda.cast.selectSubtitle(o.id); setTimeout(refreshOwned, 200); } // text → instant toggle (main un-burns if needed)
      } else { soda.cast.selectSubtitle(o.id); setTimeout(refreshOwned, 200); }
    });
    subList.appendChild(li);
  });
  // MKV cast: subtitle sync nudge (re-casts with the sideloaded VTT cues shifted). Only meaningful when
  // an active TEXT sub is showing — burn-in subs are baked into the frames and can't be re-timed live.
  if (mkvSubs && castSrcSubActive >= 0 && castSrcSubs[castSrcSubActive] && !castSrcSubs[castSrcSubActive].burn) {
    [['Subtitles earlier  −0.5s', -0.5], ['Subtitles later  +0.5s', 0.5]].forEach(([label, d]) => {
      const li = document.createElement('li'); li.className = 'cast-subsync';
      li.textContent = label;
      li.addEventListener('click', () => { if (!ownsMenu()) return; closeMenus(); showSpinner(); soda.cast.setSubDelay(d); });
      subList.appendChild(li);
    });
  }
  btnSubs.classList.toggle('hidden', subItems.length === 0);
}
function exitChromecast() {
  if (engine !== 'chromecast' && engine !== 'dlna') return;
  applyRouteHints();
  setPlaybackEngine('mpv'); document.body.classList.remove('casting'); castOverlay.classList.add('hidden');
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
      if (ev.host) delete castFailures[ev.host];   // it connected: stop treating it as broken
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
      if (SpritzCastRoutes.isConnectFailure(ev.message) && lastCastAttempt) {
        // Say what to try instead, and remember it so the menu stops offering this route first.
        castFailures[lastCastAttempt.host] = Date.now();
        renderCastMenu();
        toast(SpritzCastRoutes.failureNote(ev.message, lastCastAttempt), 7000);
      } else toast('Cast: ' + ev.message, 2600);
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
      toast('DLNA: ' + ev.message, 2600);
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
soda.cast.discover(); soda.dlna.discover(); castDiscovering = true; armCastSearchTimeout();
// Spritz Receivers are not discovered from here: the television connects OUT to us, so the list is
// whatever has paired and is currently authenticated. This just subscribes and paints what arrives.
initReceivers();
