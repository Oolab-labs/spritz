'use strict';

// Google Cast (Chromecast / Chromecast-built-in TVs) — main process.
// Implements the standard mDNS/eureka discovery + castv2 launch handshake.
//
// Discovery is two-pronged because LG webOS TVs (the target here) have Chromecast
// built-in but DO NOT run a _googlecast._tcp mDNS responder:
//   1. mDNS (_googlecast._tcp) — finds normal Chromecasts / Android TV / etc.
//   2. eureka HTTP probe on :8008/setup/eureka_info — the ONLY way an LG webOS TV
//      registers as a cast device. We sweep the local /24 (LG also ignores multicast
//      when asleep / behind a VPN that hijacks 224.0.0.251).
//
// Casting itself uses castv2-client → DefaultMediaReceiver, loading a LAN-reachable
// media URL (the same 0.0.0.0 LAN server used by AirPlay Slice 2). The TV streams it.

const EventEmitter = require('events');
const os = require('os');
const http = require('http');
const multicastDns = require('multicast-dns');
const dnsTxt = require('dns-txt')();
const { Client, DefaultMediaReceiver } = require('castv2-client');

// Physical-LAN private IPv4s only (skip loopback + VPN/tunnel interfaces).
function lanSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (!/^(en|eth)/i.test(name)) continue; // physical NICs only
    for (const a of ifaces[name] || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

module.exports = function createCast() {
  const ev = new EventEmitter();
  const devices = new Map(); // host → { host, name }
  let mdns = null, timer = null, discovering = false;
  let client = null, player = null, connectedHost = null, lastStatus = null, reconnectTries = 0;
  let castGen = 0; // bumped on every load()/stop() — a superseded client's events/reconnect are ignored (Audit H3)

  function emitDevices() {
    ev.emit('devices', [...devices.values()].map((d) => ({ id: 'cast-' + d.host, type: 'chromecast', host: d.host, name: d.name })));
  }
  function addDevice(host, name, caps) {
    if (!host || !name) return;
    const prev = devices.get(host);
    if (prev) { prev.seen = Date.now(); if (caps) prev.caps = caps; if (prev.name === name) return; } // refresh liveness/caps
    devices.set(host, { host, name, seen: Date.now(), caps: caps || (prev && prev.caps) || null });
    emitDevices();
  }
  // Receiver capability profile (for the LAN server's copy-vs-transcode decision). The Google Cast
  // media spec says 2015+ receivers decode HEVC Main10 (4K on 4K-capable units) and pass AC3/EAC3
  // through; webOS/Android-TV/Apple-TV-class TVs (e.g. the LG NANO80T6A) do the full set. Old 1080p
  // dongles (3rd-gen Chromecast) do H.264 only → conservative (transcode HEVC, AAC audio).
  const isTvLike = (s) => /\bTV\b|webos|nanocell|oled|qled|neo|bravia|google ?tv|android ?tv|\blg\b|samsung|sony|vizio|hisense|tcl|philips/i.test(s || '');
  function capsProfile(isTv, fourK) {
    const passthrough = isTv || fourK; // Dolby passthrough is safe on TVs / 4K receivers
    return {
      hevc: isTv || fourK, hevc4k: fourK, h264_4k: fourK, hdr10: true, dovi: false,
      audioCopy: passthrough ? ['aac', 'mp3', 'alac', 'ac3', 'eac3'] : ['aac', 'mp3', 'alac'],
      maxHeight: fourK ? 2160 : 1080
    };
  }
  function capsFromMdns(name, model) { const tv = isTvLike((model || '') + ' ' + (name || '')); return capsProfile(tv, tv); }
  function capsFromEureka(j) {
    const di = j.device_info || {};
    const tv = isTvLike([j.name, di.model_name, di.manufacturer, di.product_name].join(' '));
    const blocked = di['4k_blocked']; // 0 → 4K allowed; 1 → 1080p-capped; absent → infer from class
    const fourK = blocked === 0 || blocked === '0' || (tv && blocked == null);
    return capsProfile(tv, fourK);
  }
  // Drop devices not seen for a while (powered off / left the network) — Chromecast/LG emit no
  // reliable goodbye, so evict by staleness on each sweep instead of lingering until app restart.
  function reapDevices() {
    const now = Date.now(); let changed = false;
    for (const [host, d] of devices) if (now - d.seen > 180000) { devices.delete(host); changed = true; }
    if (changed) emitDevices();
  }
  // Audio-only endpoints (Chromecast Audio, Nest/Home speakers, cast groups) can't show video —
  // don't offer them as a "TV". Match on the mDNS model (md) and friendly name.
  // (Nest Hub / Hub Max have screens → keep them.)
  const isAudioOnly = (name, model) => /chromecast audio|google home(?! hub)|nest (mini|audio)|cast group|soundbar/i.test((model || '') + ' ' + (name || ''));

  // --- discovery ---
  function startDiscovery() {
    if (discovering) { emitDevices(); return; }
    discovering = true;
    try {
      mdns = multicastDns();
      mdns.on('error', () => {});
      mdns.on('response', onMdns);
    } catch (e) { /* mDNS optional; eureka sweep still runs */ }
    sweep();
    timer = setInterval(sweep, 60000);
  }

  function onMdns(pkt) {
    // This runs synchronously inside the UDP datagram handler, so ANY throw here becomes an uncaught
    // exception that crashes the whole main process. Some LAN devices send malformed/non-Buffer TXT
    // records; dns-txt's buffer-indexof then throws "buffer is not a buffer". Guard everything.
    try {
      const answers = (pkt.answers || []).concat(pkt.additionals || []);
      if (!answers.some((r) => r.type === 'PTR' && r.name === '_googlecast._tcp.local')) return;
      let host = null, name = null, model = null;
      for (const r of answers) {
        if (r.type === 'A' && r.data) host = r.data;
        if (r.type === 'TXT' && r.data != null) {
          // r.data may be a Buffer, an array of Buffers, or junk. dns-txt only accepts a Buffer.
          let buf = r.data;
          if (Array.isArray(buf)) { try { buf = Buffer.concat(buf.filter(Buffer.isBuffer)); } catch (e) { buf = null; } }
          if (Buffer.isBuffer(buf)) {
            try { const t = dnsTxt.decode(buf); if (t) { if (t.fn) name = t.fn; if (t.md) model = t.md; } } catch (e) {}
          }
        }
      }
      if (isAudioOnly(name, model)) return; // skip speakers / cast groups — they can't show video
      addDevice(host, name, capsFromMdns(name, model));
    } catch (e) { /* malformed mDNS packet — ignore, never crash discovery */ }
  }

  // Manually-specified hosts (comma-separated) for TVs that never auto-discover —
  // the old app exposed this as 'manual-cast-hosts'. Useful when the TV is on another
  // subnet or a VPN hijacks multicast.
  function manualHosts() {
    return String(process.env.SPRITZ_CAST_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function sweep() {
    // mDNS query (catches standard Chromecasts)
    try { if (mdns) mdns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (e) {}
    // eureka /24 sweep (catches LG webOS + Chromecast-built-in TVs) + any manual hosts
    const hosts = manualHosts();
    for (const ip of lanSubnets()) {
      const base = ip.replace(/\.\d+$/, '.');
      for (let n = 1; n <= 254; n++) { const h = base + n; if (h !== ip) hosts.push(h); }
    }
    let idx = 0;
    const MAXC = 16;
    const pump = () => { if (idx < hosts.length) probeEureka(hosts[idx++], pump); };
    for (let c = 0; c < MAXC && c < hosts.length; c++) pump();
    reapDevices(); // evict TVs that have gone away
  }

  function probeEureka(host, done) {
    let fired = false;
    let guard = null;
    const next = () => { if (fired) return; fired = true; if (guard) { clearTimeout(guard); guard = null; } done(); }; // advance the pump exactly once
    // The socket `timeout` is an INACTIVITY timer (reset on each byte); a host that trickles bytes under
    // the 1 MiB cap would never fire it and would leak a pump slot forever. Cap total wall-clock instead.
    const req = http.get({ host, port: 8008, path: '/setup/eureka_info?options=detail', timeout: 2000 }, (res) => {
      let body = '', len = 0, over = false;
      res.on('data', (d) => {
        if (over) return;
        len += d.length;
        if (len > 1024 * 1024) { over = true; res.destroy(); next(); return; } // cap eureka JSON at 1 MiB (untrusted LAN host)
        body += d;
      });
      res.on('end', () => {
        next();
        if (over) return;
        try { const j = JSON.parse(body); if (j && j.name) addDevice(host, String(j.name), capsFromEureka(j)); } catch (e) {}
      });
    });
    req.on('error', () => next());
    req.on('timeout', () => { req.destroy(); next(); });
    guard = setTimeout(() => { try { req.destroy(); } catch (e) {} next(); }, 4000); // overall deadline (defeats slow-trickle)
  }

  function stopDiscovery() {
    discovering = false;
    if (timer) { clearInterval(timer); timer = null; }
    try { if (mdns) mdns.destroy(); } catch (e) {} mdns = null;
  }

  // --- casting (castv2-client → DefaultMediaReceiver) ---
  // Last NON-EMPTY track list. The receiver emits frequent currentTime-only status frames with no
  // `media` block; reading tracks straight from those momentarily empties the menus and can make
  // setTrack send an empty activeTrackIds. Cache the list; keep reading activeTrackIds live.
  let lastTracks = [];
  function noteTracks(s) { if (s && s.media && Array.isArray(s.media.tracks) && s.media.tracks.length) lastTracks = s.media.tracks; }
  function teardownClient() {
    try { if (player) player.removeAllListeners(); } catch (e) {}
    try { if (client) { client.removeAllListeners(); client.close(); } } catch (e) {} // detach so a closed client's late events can't fire
    client = null; player = null; connectedHost = null; lastStatus = null; lastTracks = [];
  }

  // load(host, media, cb) — media = { url, title, contentType, currentTime, subs:[{url,lang,name}] }
  // subs are sideloaded WebVTT text tracks (extracted by the LAN server) → selectable on the TV.
  // _isReconnect: internal — a silent live-drop retry (don't reset the retry budget).
  function load(host, media, cb, _isReconnect) {
    teardownClient();
    const myGen = ++castGen;            // this attempt's identity; anything newer supersedes it
    if (!_isReconnect) reconnectTries = 0; // a fresh user cast gets a fresh retry budget (Audit H3)
    const hls = /vnd\.apple\.mpegurl|m3u8/i.test(media.contentType || '') || /\.m3u8(\?|#|$)/i.test(media.url || '');
    let settled = false;
    const done = (e, s) => { if (settled) return; settled = true; clearTimeout(to); cb && cb(e, s); };
    const c = client = new Client();
    // Connect timeout: castv2's connect callback never fires for an unreachable TV — without
    // this the UI hangs in "connecting" forever and chromecasting state is never reset.
    const to = setTimeout(() => { if (myGen !== castGen) return; ev.emit('error', { message: 'Chromecast connect timed out' }); teardownClient(); done(new Error('connect timeout')); }, 12000);
    c.on('error', (e) => {
      if (myGen !== castGen) { clearTimeout(to); try { c.removeAllListeners(); c.close(); } catch (x) {} return; } // superseded client — ignore
      // If a LIVE session drops (Wi-Fi blip, TV screensaver killing the socket), silently
      // reconnect at the last known position before surfacing an error and bouncing to local.
      if (settled && reconnectTries < 2) {
        reconnectTries++;
        const at = (lastStatus && lastStatus.currentTime) || media.currentTime || 0;
        teardownClient();
        // A non-seekable MKV pipe can't be resumed by re-GETting the same URL — that restarts the ffmpeg
        // from the ORIGINAL start (the receiver can't seek a live pipe) and 404s if the token was
        // superseded. Ask the orchestrator to re-cast a fresh stream from the live position; seekable
        // (direct MP4) and HLS sources can re-load their URL directly.
        if (/x-matroska/i.test(media.contentType || '')) { ev.emit('reconnect', { at }); return; }
        setTimeout(() => { if (myGen === castGen) load(host, Object.assign({}, media, { currentTime: at }), () => {}, true); }, 1500); // skip if superseded/stopped
        return;
      }
      ev.emit('error', { message: String(e && e.message || e) }); teardownClient(); done(e);
    });
    c.connect(host, () => {
      if (myGen !== castGen) { clearTimeout(to); try { c.removeAllListeners(); c.close(); } catch (x) {} return; } // a newer load/stop won — abandon
      connectedHost = host;
      c.launch(DefaultMediaReceiver, (err, p) => {
        if (myGen !== castGen) { clearTimeout(to); try { c.removeAllListeners(); c.close(); } catch (x) {} return; }
        if (err) { ev.emit('error', { message: err.message }); return done(err); }
        player = p;
        let endedEmitted = false;
        p.on('status', (s) => {
          if (myGen !== castGen) return;
          if (s) { lastStatus = s; noteTracks(s); }
          ev.emit('status', s);
          // Media played to the end: the receiver reports IDLE with idleReason FINISHED. Surface it once
          // so the app can clear the resume marker + leave the wedged last frame. (Audit M5)
          if (s && s.playerState === 'IDLE' && s.idleReason === 'FINISHED' && !endedEmitted) { endedEmitted = true; ev.emit('ended'); }
        });
        const info = {
          contentId: media.url,
          contentType: media.contentType || 'video/mp4',
          // A live HLS EVENT playlist (omit_endlist, grows as ffmpeg encodes) is not a finite
          // buffered stream — BUFFERED + a non-zero currentTime makes the receiver seek past
          // available media and the load fails. LIVE starting at 0 is correct for our HLS.
          streamType: hls ? 'LIVE' : 'BUFFERED',
          metadata: { type: 0, metadataType: 0, title: media.title || '' }
        };
        // For HLS the master playlist already carries the subtitle renditions (the receiver
        // exposes them as TEXT tracks itself) — sideloading would duplicate them. Only sideload
        // for non-HLS (direct MP4) casts, where there's no playlist to carry subtitle tracks.
        const subs = !hls && Array.isArray(media.subs) ? media.subs : [];
        if (subs.length) {
          info.tracks = subs.map((s, i) => ({
            trackId: 1000 + i, type: 'TEXT', subtype: 'SUBTITLES',
            trackContentId: s.url, trackContentType: 'text/vtt',
            language: s.lang || 'und', name: s.name || s.lang || ('Subtitle ' + (i + 1))
          }));
          info.textTrackStyle = { backgroundColor: '#00000000', foregroundColor: '#FFFFFFFF', edgeType: 'OUTLINE', edgeColor: '#000000FF' };
        }
        p.load(info, { autoplay: true, currentTime: hls ? 0 : (media.currentTime || 0) }, (e2, status) => {
          if (myGen !== castGen) return; // superseded during load → don't emit/settle for a dead session
          if (e2) {
            // Surface the CAF detailedErrorCode so the orchestrator can branch: 104 MEDIA_SRC_NOT_SUPPORTED
            // / 102 MEDIA_DECODE / 110 SOURCE_BUFFER_FAILURE → container/codec escalation; 103 MEDIA_NETWORK
            // → LAN URL problem, not the codec. (A real Chromecast rejects raw MKV with 104.)
            const code = (status && status.detailedErrorCode) || null;
            if (code != null) e2.detailedErrorCode = code;
            ev.emit('error', { message: e2.message, code });
          }
          if (status) { lastStatus = status; noteTracks(status); reconnectTries = 0; ev.emit('status', status); } // fresh session → reset retries
          done(e2, status);
        });
      });
    });
  }

  // --- track selection (Chromecast EDIT_TRACKS_INFO) ---
  // The receiver reports embedded tracks in status.media.tracks; activeTrackIds is a
  // single list holding BOTH the active audio and the active text track id.
  function trackName(t) { return t.name || t.language || (t.type === 'TEXT' ? 'Subtitle ' : 'Audio ') + t.trackId; }
  function tracks() {
    const all = lastTracks || []; // cached list (survives currentTime-only frames)
    const active = (lastStatus && lastStatus.activeTrackIds) || [];
    const pick = (type) => all.filter((t) => t.type === type)
      .map((t) => ({ id: t.trackId, name: trackName(t), selected: active.indexOf(t.trackId) >= 0 }));
    return { audio: pick('AUDIO'), subs: pick('TEXT') };
  }
  // setTrack('audio'|'subs', trackId) — trackId -1 = subtitles off
  function setTrack(kind, id) {
    if (!player) return;
    const all = lastTracks || [];
    if (!all.length) {
      // Receiver never echoed a track list (sideloaded-only — e.g. the single-MKV transport's subs).
      // Drive activeTrackIds directly: one sub track on, or [] = off. The MKV transport has no separate
      // cast audio track (audio is muxed), so there's no other active id to preserve. (Subtitle fix.)
      const next = id >= 0 ? [id] : [];
      try { player.media.sessionRequest({ type: 'EDIT_TRACKS_INFO', activeTrackIds: next }, () => {}); } catch (e) {}
      return;
    }
    const groupType = kind === 'subs' ? 'TEXT' : 'AUDIO';
    const groupIds = all.filter((t) => t.type === groupType).map((t) => t.trackId);
    let next = ((lastStatus && lastStatus.activeTrackIds) || []).filter((x) => groupIds.indexOf(x) < 0);
    if (id >= 0) next.push(id);
    try { player.media.sessionRequest({ type: 'EDIT_TRACKS_INFO', activeTrackIds: next }, () => {}); } catch (e) {}
  }

  const withPlayer = (fn) => { try { if (player) fn(player); } catch (e) {} };
  function play()  { withPlayer((p) => p.play(() => {})); }
  function pause() { withPlayer((p) => p.pause(() => {})); }
  function seek(t) { withPlayer((p) => p.seek(t, () => {})); }
  function stop()  { castGen++; withPlayer((p) => p.stop(() => {})); teardownClient(); } // invalidate any pending reconnect
  function setVolume(f) { try { if (client) client.setVolume({ level: f }, () => {}); } catch (e) {} }

  function teardown() { castGen++; stopDiscovery(); teardownClient(); } // invalidate any pending reconnect

  return {
    on: (e, fn) => ev.on(e, fn),
    startDiscovery, stopDiscovery, load, play, pause, seek, stop, setVolume, teardown,
    tracks, setTrack, connectedHost: () => connectedHost,
    capsFor: (host) => { const d = devices.get(host); return d ? d.caps : null; }
  };
};
