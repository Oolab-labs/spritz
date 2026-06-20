'use strict';

// Torrent/magnet streaming (main process). webtorrent 3.x is pure ESM, so it's
// loaded via dynamic import() from this CommonJS module. The torrent layer's only
// job is to expose a localhost HTTP URL (range-supported, served by webtorrent's
// own server) and hand it to the existing player-load path; mpv streams it.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Opt-in plain-file diagnostic log (set SPRITZ_DEBUG=1 to enable; open /tmp/spritz-torrent.log in Finder).
// Off by default so a public build never writes magnet links / filenames to world-readable /tmp.
const DBG = !!process.env.SPRITZ_DEBUG;
const TLOG = '/tmp/spritz-torrent.log';
if (DBG) { try { fs.writeFileSync(TLOG, '[torrent] log started ' + new Date().toISOString() + '\n'); } catch (e) {} }
function tlog(m) { if (!DBG) return; const s = '[' + new Date().toISOString().slice(11, 23) + '] ' + m; try { fs.appendFileSync(TLOG, s + '\n'); } catch (e) {} try { console.log('[torrent]', m); } catch (e) {} }

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi|m4v|flv|ts|wmv|mpg|mpeg|ogv|m2ts)$/i;
const IGNORE = /sample/i;
const MIN_LEN = 10 * 1024 * 1024; // 10MB — keep short clips/episodes visible (old app used 40MB)

const META_TIMEOUT = 45000;  // no torrent metadata in this long → dead magnet / no peers
const STALL_TIMEOUT = 40000; // metadata OK but zero bytes downloaded this long → no data peers

// Curated public-tracker announce list, merged into every magnet/.torrent (webtorrent concats + de-dupes,
// honoring `private`). A bare info-hash magnet with no trackers relies on DHT alone and often shows "no
// peers"; these UDP trackers widen the swarm enough to actually start + sustain a 4K stream.
// Snapshot of ngosang/trackerslist "best" (refresh occasionally from that repo's trackers_best.txt).
const BEST_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://tracker.bitsearch.to:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
  'udp://tracker.0x7c0.com:6969/announce'
];

// Buffer just enough of the file head (the container header lives in the first piece) before handing the
// URL to mpv, so mpv's first reads are served from disk instantly. We wait for ONE piece worth, not more —
// over a slow-ramping TCP-only swarm a single 8MB piece already takes ~10-15s, so a bigger prebuffer just
// delays start. The renderer shows the buffering % meanwhile. (Without this, mpv opens on 0 bytes and
// hangs on piece 0.) The timeout is generous so we never hand off a headless URL (that = "never starts").
const PREBUFFER_BYTES = 4 * 1024 * 1024;
const PREBUFFER_TIMEOUT = 50000; // last-resort handoff for a slow-but-alive torrent (STALL_TIMEOUT errors a dead one at 40s)

module.exports = function createTorrent(send) {
  let WT = null, client = null, active = null, server = null, progressTimer = null;
  let metaTimer = null, stallTimer = null, activeFile = null;

  // Where webtorrent writes downloaded pieces. Spritz is a STREAMING player, not a download
  // manager — these are full-movie files that must not pile up. We purge them when a torrent is
  // dropped (destroyStore), and sweep the whole dir at startup to clear anything a crash orphaned.
  const DL_DIR = path.join(app.getPath('temp'), 'spritz', 'torrents');
  try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch (e) {}

  // Which byte ranges of the CURRENTLY-PLAYING file are downloaded, as [start,end] fractions (0..1).
  // Maps the torrent's per-piece bitfield to positions within the file → the renderer paints these on
  // the scrubber so you can see what's safe to seek to. (file-fraction ≈ time-fraction; fine for a viz.)
  function bufferedRanges() {
    const f = activeFile;
    if (!active || !f || !active.bitfield || !active.pieceLength || !f.length) return [];
    const pl = active.pieceLength, fStart = f.offset || 0, fEnd = fStart + f.length;
    const p0 = Math.floor(fStart / pl), p1 = Math.floor((fEnd - 1) / pl);
    const segs = []; let cur = null;
    for (let p = p0; p <= p1; p++) {
      let have = false; try { have = active.bitfield.get(p); } catch (e) {}
      if (have) {
        const a = (Math.max(p * pl, fStart) - fStart) / f.length;
        const b = (Math.min((p + 1) * pl, fEnd) - fStart) / f.length;
        if (cur && b - cur[1] >= 0 && cur[1] >= a - 1e-9) cur[1] = Math.max(cur[1], b); // merge contiguous
        else { cur = [a, b]; segs.push(cur); }
      } else cur = null;
    }
    return segs;
  }

  async function getClient() {
    if (!WT) WT = (await import('webtorrent')).default; // ESM → dynamic import; .default export
    if (!client) {
      // Higher peer caps than the default (55) — a 4K/HDR release is ~25 Mbps, which needs many
      // peers to sustain so streaming playback can actually START and not buffer forever. (The old
      // player also had uTP via utp-native; we're TCP-only, so wider TCP fan-out matters more.)
      client = new WT({ maxConns: 200, dht: true });
      client.on('error', (e) => send('torrent:error', { message: msg(e) }));
    }
    return client;
  }

  const msg = (e) => String((e && e.message) || e);
  const isPlayable = (f) => VIDEO_EXT.test(f.name) && f.length >= MIN_LEN && !IGNORE.test(f.name);
  const natSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

  // Peers actually sending us data right now (vs idle/choked connections) — a truer "will this sustain" signal.
  function activeSenders() {
    try {
      return (active.wires || []).filter((w) => {
        if (!w) return false;
        const ds = typeof w.downloadSpeed === 'function' ? w.downloadSpeed() : w.downloadSpeed;
        return ds > 0;
      }).length;
    } catch (e) { return 0; }
  }

  function emitProgress() {
    if (!active) return;
    send('torrent:progress', {
      peers: active.numPeers, senders: activeSenders(), speed: active.downloadSpeed,
      downloaded: active.downloaded, length: active.length, progress: active.progress,
      buffered: bufferedRanges() // [[startFrac,endFrac],…] of the playing file — drawn on the scrubber
    });
    // Stall watch: once any bytes flow, the torrent is alive — cancel the stall timer.
    if (stallTimer && active.downloaded > 0) { clearTimeout(stallTimer); stallTimer = null; }
  }

  function startServerAndPlay(file) {
    // Bind 0.0.0.0 (not 127.0.0.1) so the same server is reachable both at localhost
    // (for mpv on this Mac) AND at the Mac's LAN IP (for the Apple TV during AirPlay).
    const fresh = !server;
    if (!server) { server = client.createServer(); server.server.listen(0, '0.0.0.0'); } // once, reused
    const go = () => {
      try { active.files.forEach((f) => f.deselect()); } catch (e) {}
      try { file.select(); } catch (e) {} // stream this file; webtorrent's sequential strategy downloads in order
      activeFile = file; // remember for the buffered-ranges viz
      // Mark the head CRITICAL so piece 0 is fetched with top urgency (deselect-all otherwise leaves it
      // competing) and mpv's header read is instant once we hand off.
      const headPieces = Math.max(1, Math.ceil(PREBUFFER_BYTES / active.pieceLength));
      const headEnd = Math.min(file._endPiece + 1, file._startPiece + headPieces);
      try { active.critical(file._startPiece, headEnd - 1); } catch (e) {}
      const port = server.server.address().port;
      const rel = file.streamURL ||
        ('/webtorrent/' + active.infoHash + '/' + file.path.split('/').map(encodeURIComponent).join('/'));
      const url = 'http://localhost:' + port + rel;
      tlog('prebuffer start: "' + file.name + '" head=' + (headEnd - file._startPiece) + 'pc pieceLen=' + active.pieceLength + ' freshServer=' + fresh + ' port=' + port);
      // Hand to mpv once the head is on disk (instant open), or after PREBUFFER_TIMEOUT regardless.
      const t0 = Date.now();
      let readied = false;
      const ready = (why) => { if (readied) return; readied = true; tlog('READY after ' + (Date.now() - t0) + 'ms (' + why + ') peers=' + active.numPeers + ' speed=' + Math.round(active.downloadSpeed / 1024) + 'KB/s -> ' + url); send('torrent:ready', { url }); };
      const check = () => {
        if (readied || !active || activeFile !== file) return; // superseded (file switch / cancel)
        let have = 0; const total = headEnd - file._startPiece;
        for (let p = file._startPiece; p < headEnd; p++) { let h = false; try { h = active.bitfield.get(p); } catch (e) {} if (h) have++; }
        send('torrent:progress', { peers: active.numPeers, senders: activeSenders(), speed: active.downloadSpeed,
          downloaded: active.downloaded, length: active.length, progress: active.progress, buffered: bufferedRanges(), buffering: total ? have / total : 1 });
        if (have >= total) return ready('head ready');
        if (Date.now() - t0 > PREBUFFER_TIMEOUT) return ready('timeout, head ' + have + '/' + total);
        setTimeout(check, 300);
      };
      check();
    };
    if (server.server.listening) go();
    else { tlog('server not listening yet — waiting for bind'); server.server.once('listening', go); }
  }

  async function add(src) {
    try {
      tlog('add ' + String(src).slice(0, 70) + (active ? ' (replacing an active torrent)' : ''));
      const c = await getClient();
      cancel(); // drop any previous active torrent (purges its data; keeps client+server for reuse)
      // No metadata in META_TIMEOUT → dead magnet (no reachable peers/trackers). Without
      // this the renderer just sits on "connecting…" forever with no feedback.
      metaTimer = setTimeout(() => {
        console.error('[torrent] metadata timeout');
        send('torrent:error', { message: 'No peers found — could not fetch torrent info. The magnet may be dead or your network is blocking it.' });
        cancel();
      }, META_TIMEOUT);
      const t = c.add(src, { path: DL_DIR, announce: BEST_TRACKERS }, (torrent) => {
        if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
        const playable = torrent.files.filter(isPlayable).slice().sort(natSort);
        tlog('metadata "' + torrent.name + '" files=' + torrent.files.length + ' playable=' + playable.length + ' peers=' + torrent.numPeers);
        send('torrent:metadata', {
          name: torrent.name,
          files: torrent.files.map((f, i) => ({ index: i, name: f.name, length: f.length, playable: isPlayable(f) }))
        });
        progressTimer = setInterval(emitProgress, 1000);
        // Metadata arrived but if no bytes ever download, there are no data peers — warn.
        stallTimer = setTimeout(() => {
          if (active && active.downloaded === 0) {
            console.error('[torrent] stalled — 0 bytes');
            send('torrent:error', { message: 'Connected but no data is downloading — no seeders available for this torrent.' });
          }
        }, STALL_TIMEOUT);
        if (playable.length === 1) startServerAndPlay(playable[0]);
        else if (playable.length === 0) send('torrent:error', { message: 'No playable video found in this torrent.' });
        // >1 → wait for selectFile from the renderer's file picker
      });
      t.on('error', (e) => { tlog('ERROR ' + msg(e)); send('torrent:error', { message: msg(e) }); });
      t.on('warning', (e) => console.warn('[torrent] warn', msg(e)));
      // Additive diagnostics only (the timeout-driven error path above is unchanged): webtorrent fires
      // noPeers per announce source (dht/tracker/lsd) when that source returns nobody — logs help tell a
      // dead magnet apart from a slow-tracker/healthy-DHT start without waiting the full 40-45s timers.
      t.on('noPeers', (announceType) => tlog('noPeers via ' + announceType));
      active = t;
    } catch (e) {
      console.error('[torrent] add err', msg(e));
      send('torrent:error', { message: msg(e) });
    }
  }

  function selectFile(index) {
    if (active && active.files[index]) startServerAndPlay(active.files[index]);
  }

  function cancel() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    // destroyStore deletes this torrent's downloaded files from DL_DIR (a streamed movie can be many
    // GB — we don't keep it). Fire-and-forget; the store removal runs async in webtorrent.
    if (active) { try { active.destroy({ destroyStore: true }); } catch (e) { try { active.destroy(); } catch (e2) {} } active = null; }
    activeFile = null;
  }

  function teardown() {
    cancel();
    try { if (server) server.close(); } catch (e) {} // close server BEFORE client.destroy (avoid EADDRINUSE)
    try { if (client) client.destroy(); } catch (e) {}
    server = null; client = null;
    // Belt-and-suspenders: remove the whole download dir on quit in case destroyStore missed anything.
    try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  return { add, selectFile, cancel, teardown };
};
