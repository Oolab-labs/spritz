'use strict';

// Preload bridge (contextIsolation:true). The renderer reaches the main-process
// libmpv addon and window/dialog services only through window.soda.*

// NB: only sandbox-safe electron modules here (contextBridge, ipcRenderer, webUtils) so the
// renderer can run with sandbox:true. Clipboard reads go through a synchronous main IPC call.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('soda', {
  player: {
    // url = absolute path or http(s) URL; opts.start = resume seconds
    load: (url, opts) => ipcRenderer.send('player:load', { url, start: opts && opts.start, referer: opts && opts.referer }),
    openSite: (url) => ipcRenderer.send('player:openSite', { url }), // yt-dlp resolve in main
    onNotice: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('player:notice', h); return () => ipcRenderer.removeListener('player:notice', h); },
    setProperty: (name, value) => ipcRenderer.send('player:setProperty', { name, value }),
    command: (...args) => ipcRenderer.send('player:command', { args }),

    play: () => ipcRenderer.send('player:setProperty', { name: 'pause', value: false }),
    pause: () => ipcRenderer.send('player:setProperty', { name: 'pause', value: true }),
    seek: (t) => ipcRenderer.send('player:setProperty', { name: 'time-pos', value: t }),
    stop: () => ipcRenderer.send('player:command', { args: ['stop'] }),
    frameStep: () => ipcRenderer.send('player:command', { args: ['frame-step'] }),
    setVolume: (frac) => ipcRenderer.send('player:setProperty', { name: 'volume', value: frac * 100 }), // ×100
    setMuted: (b) => ipcRenderer.send('player:setProperty', { name: 'mute', value: !!b }),
    setAudioTrack: (i) => ipcRenderer.send('player:setProperty', { name: 'aid', value: i + 1 }),       // n+1
    setSubtitleTrack: (i) => ipcRenderer.send('player:setProperty', { name: 'sid', value: i === null ? 'no' : i + 1 }),
    addSubtitleFile: (p, opts) => { // select it immediately in mpv AND register it so casts carry it
      ipcRenderer.send('player:command', { args: ['sub-add', p, 'select'] });
      ipcRenderer.send('subtitle:external', { path: p, lang: opts && opts.lang, name: opts && opts.name });
    },
    generateSubtitles: (src) => ipcRenderer.invoke('subtitle:generate', { src }), // Whisper → {ok, srt|error}
    onlineSubtitles: (src, lang) => ipcRenderer.invoke('subtitle:online', { src, lang }), // OpenSubtitles → {ok, srt, name|error}
    setSubDelay: (n) => ipcRenderer.send('player:setProperty', { name: 'sub-delay', value: n }),
    setHwdec: (mode) => ipcRenderer.send('player:setProperty', { name: 'hwdec', value: mode }),
    setShaders: (mode) => ipcRenderer.send('player:setShaders', { mode }), // Anime4K: 'A'|'B'|'C'|null
    setInterpolation: (on) => ipcRenderer.send('player:setInterpolation', { on }), // motion interpolation
    stat: () => ipcRenderer.invoke('player:stat'),
    mediaStats: () => ipcRenderer.invoke('player:mediaStats'), // stats overlay: codecs/bitrate/fps/drops

    // single event channel: {type:'property-change',name,value} | 'file-loaded' | 'end-file'
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('player-event', h);
      return () => ipcRenderer.removeListener('player-event', h);
    }
  },

  fullscreen: {
    toggle: () => ipcRenderer.send('window:toggleFullScreen'),
    onChange: (cb) => {
      ipcRenderer.on('enter-full-screen', () => cb(true));
      ipcRenderer.on('leave-full-screen', () => cb(false));
    }
  },

  torrent: {
    add: (src) => ipcRenderer.send('torrent:add', { src }),
    selectFile: (i) => ipcRenderer.send('torrent:selectFile', { index: i }),
    cancel: () => ipcRenderer.send('torrent:cancel', {}),
    onMetadata: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('torrent:metadata', h); return () => ipcRenderer.removeListener('torrent:metadata', h); },
    onProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('torrent:progress', h); return () => ipcRenderer.removeListener('torrent:progress', h); },
    onReady: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('torrent:ready', h); return () => ipcRenderer.removeListener('torrent:ready', h); },
    onError: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('torrent:error', h); return () => ipcRenderer.removeListener('torrent:error', h); }
  },
  airplay: {
    showButton: (rect) => ipcRenderer.send('airplay:showButton', { rect }),
    hideButton: () => ipcRenderer.send('airplay:hideButton'),
    play: () => ipcRenderer.send('airplay:play'),
    pause: () => ipcRenderer.send('airplay:pause'),
    seek: (t) => ipcRenderer.send('airplay:seek', { t }),
    setVolume: (f) => ipcRenderer.send('airplay:setVolume', { f }),
    stop: () => ipcRenderer.send('airplay:stop'),
    stat: () => ipcRenderer.invoke('airplay:stat'),
    mediaTracks: () => ipcRenderer.invoke('airplay:mediaTracks'), // {audio:[{name,selected}], subs:[...]}
    selectAudio: (i) => ipcRenderer.send('airplay:selectMedia', { kind: 'audio', index: i }),
    selectSubtitle: (i) => ipcRenderer.send('airplay:selectMedia', { kind: 'subs', index: i }), // -1 = off
    onEvent: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('airplay-event', h); return () => ipcRenderer.removeListener('airplay-event', h); }
  },
  cast: { // Google Cast (Chromecast / LG webOS)
    discover: () => ipcRenderer.send('cast:discover'),
    load: (host) => ipcRenderer.send('cast:load', { host }),
    play: () => ipcRenderer.send('cast:play'),
    pause: () => ipcRenderer.send('cast:pause'),
    seek: (t) => ipcRenderer.send('cast:seek', { t }),
    setVolume: (f) => ipcRenderer.send('cast:setVolume', { f }),
    stop: () => ipcRenderer.send('cast:stop'),
    mediaTracks: () => ipcRenderer.invoke('cast:mediaTracks'), // {audio:[{id,name,selected}], subs:[...]}
    selectAudio: (id) => ipcRenderer.send('cast:selectTrack', { kind: 'audio', id }),
    selectSubtitle: (id) => ipcRenderer.send('cast:selectTrack', { kind: 'subs', id }), // -1 = off
    selectSourceAudio: (idx) => ipcRenderer.send('cast:setSourceAudio', { idx }), // MKV transport: re-cast with this audio language
    selectBurnSub: (subIdx) => ipcRenderer.send('cast:setBurnSub', { subIdx }), // bitmap sub: burn it in (subIdx>=0) or off (-1)
    setSubDelay: (delta) => ipcRenderer.send('cast:subDelay', { delta }), // MKV cast: shift sideloaded subtitle timing by ±delta seconds
    onEvent: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('cast-event', h); return () => ipcRenderer.removeListener('cast-event', h); }
  },
  // Now Playing / media keys (Control Center, hardware keys, AirPods)
  media: {
    onCommand: (cb) => ipcRenderer.on('media-command', (_e, ev) => cb(ev)),
    update: (info) => ipcRenderer.send('nowplaying:update', info),
    clear: () => ipcRenderer.send('nowplaying:clear')
  },
  onToast: (cb) => ipcRenderer.on('toast', (_e, p) => cb(p.message)), // non-disruptive status
  // "open with Spritz" / magnet / CLI → renderer
  onOpenSource: (cb) => { ipcRenderer.on('open-source', (_e, p) => cb(p.src)); ipcRenderer.send('renderer:ready'); },
  fsSiblings: (path) => ipcRenderer.invoke('fs:siblings', { path }), // play-next-episode
  thumbAt: (src, time) => ipcRenderer.invoke('thumb:at', { src, time }), // scrubber thumbnail
  sponsorSegments: (videoId) => ipcRenderer.invoke('sponsorblock:get', { videoId }), // SponsorBlock
  parsePlaylist: (path) => ipcRenderer.invoke('playlist:parse', { path }), // .m3u/.pls/IPTV
  history: { // resume positions / recents (keyed by original source)
    get: (src) => ipcRenderer.invoke('history:get', { src }),
    save: (src, pos, dur, title) => ipcRenderer.send('history:save', { src, pos, dur, title }),
    remove: (src) => ipcRenderer.send('history:remove', { src }),
    recents: (n) => ipcRenderer.invoke('history:recents', { n })
  },
  prefs: { // per-show audio/subtitle language memory (keyed by the show folder)
    get: (key) => ipcRenderer.invoke('pref:get', { key }),
    save: (key, pref) => ipcRenderer.send('pref:save', { key, pref })
  },
  dlna: { // DLNA / UPnP "play to"
    discover: () => ipcRenderer.send('dlna:discover'),
    load: (location) => ipcRenderer.send('dlna:load', { location }),
    play: () => ipcRenderer.send('dlna:play'),
    pause: () => ipcRenderer.send('dlna:pause'),
    seek: (t) => ipcRenderer.send('dlna:seek', { t }),
    setVolume: (f) => ipcRenderer.send('dlna:setVolume', { f }),
    stop: () => ipcRenderer.send('dlna:stop'),
    onEvent: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('dlna-event', h); return () => ipcRenderer.removeListener('dlna-event', h); }
  },
  menu: { onAction: (cb) => ipcRenderer.on('menu-action', (_e, a) => cb(a)) },
  dialog: { openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts) },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    setTitle: (title) => ipcRenderer.send('window:setTitle', { title }),
    beginDrag: () => ipcRenderer.send('window:beginDrag'),
    dragTo: (dx, dy) => ipcRenderer.send('window:dragTo', { dx, dy }),
    toggleFloat: () => ipcRenderer.send('window:toggleFloat'),
    toggleMini: () => ipcRenderer.send('window:toggleMini')
  },
  power: {
    block: () => ipcRenderer.send('power:block'),
    unblock: () => ipcRenderer.send('power:unblock')
  },

  pathForFile: (file) => webUtils.getPathForFile(file), // drag-drop → absolute path
  getVersions: () => ipcRenderer.invoke('app:getVersions'),
  readClipboard: () => { try { return ipcRenderer.sendSync('clipboard:read'); } catch (e) { return ''; } }, // magnet auto-paste (sync IPC; clipboard lives in main under sandbox)
  readClipboardAsync: () => ipcRenderer.invoke('clipboard:read').catch(() => ''), // non-blocking variant for hot paths (window focus)
  vpnStatus: () => ipcRenderer.invoke('vpn:status') // {active, name} — kill-switch check
});
