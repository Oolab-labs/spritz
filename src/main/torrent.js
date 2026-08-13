'use strict';

// Torrent/magnet streaming (main process). webtorrent 3.x is pure ESM, so it's
// loaded via dynamic import() from this CommonJS module. The torrent layer's only
// job is to expose a localhost HTTP URL (range-supported, served by webtorrent's
// own server) and hand it to the existing player-load path; mpv streams it.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { criticalWindow, bufferHealth } = require('./buffer-plan'); // readahead sized in seconds

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
    // Lazy module memo. Concurrent callers may both import, but import() is module-cached, so
    // both assign the identical namespace object — the second write is a no-op in effect.
    // eslint-disable-next-line require-atomic-updates
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

  // Where mpv is in the file, as a 0..1 fraction (main pushes this from the time-pos property).
  // Used to keep the download's urgency travelling WITH the play head.
  let playFrac = 0, mediaDuration = 0;
  function setPlayhead(frac, durationSec) {
    if (typeof frac === 'number' && frac >= 0 && frac <= 1) playFrac = frac;
    // Duration turns the readahead window from a piece count into an amount of playback time.
    if (typeof durationSec === 'number' && durationSec > 0) mediaDuration = durationSec;
  }

  // Keep a CRITICAL window just ahead of the play head. webtorrent marks pieces critical only
  // reactively, for the bytes the HTTP server is being asked for right now — often a single piece —
  // and this module set a critical window ONCE over the file head at handoff and never moved it.
  // Past the prebuffer, nothing was urgent any more: pieces arrived in plain sequential order at
  // whatever rate the swarm felt like, so a marginal swarm underruns mpv's cache and playback
  // stalls with the spinner. Re-target the window every progress tick instead.
  // Seconds of playback to keep urgent. Wide enough to ride out a slow patch, narrow enough that
  // the critical set still means something. See buffer-plan.js for why this is time, not pieces.
  const READAHEAD_SECONDS = 30;
  function refreshCritical() {
    if (!active || !activeFile) return;
    try {
      const win = criticalWindow({
        startPiece: activeFile._startPiece,
        endPiece: activeFile._endPiece,
        pieceLength: active.pieceLength,
        fileBytes: activeFile.length,
        durationSec: mediaDuration,
        playFrac,
        targetSeconds: READAHEAD_SECONDS
      });
      if (!win) return;
      const { at, end } = win;
      // CLEAR the previous window first. webtorrent's critical() only ever SETS _critical[i] = true
      // (lib/torrent.js) and never unsets it, so re-marking a moving window every second makes the
      // critical set grow without bound. Once most of the file is flagged, `_critical[piece] ||
      // hotswap` is true for nearly every piece, the flag stops discriminating, and requests go out
      // effectively unordered — which stutters worse than having no window at all.
      if (Array.isArray(active._critical)) active._critical.length = 0;
      active.critical(at, end);
    } catch (e) {}
  }

  // Contiguous downloaded bytes ahead of the play head: the runway before playback starves.
  // Reuses bufferedRanges(), which already merges contiguous pieces — a gap ends the runway, since
  // playback stops at the first missing piece no matter how much sits beyond it.
  function bytesAheadOfPlayhead() {
    const f = activeFile;
    if (!f || !f.length) return null;
    const seg = bufferedRanges().find(([a, b]) => playFrac >= a - 1e-9 && playFrac < b);
    return seg ? (seg[1] - playFrac) * f.length : 0;
  }

  function emitProgress() {
    if (!active) return;
    refreshCritical();
    const ahead = bytesAheadOfPlayhead();
    // Reported, not acted on. Knowing "this stalls in about 20 seconds" is worth telling the user;
    // reacting by widening the urgent set would add contention exactly when the swarm is short of
    // it, which is the wrong direction.
    const health = bufferHealth({
      bufferedBytesAhead: ahead,
      downloadBps: active.downloadSpeed,
      fileBytes: activeFile && activeFile.length,
      durationSec: mediaDuration
    });
    send('torrent:progress', {
      peers: active.numPeers, senders: activeSenders(), speed: active.downloadSpeed,
      downloaded: active.downloaded, length: active.length, progress: active.progress,
      buffered: bufferedRanges(), // [[startFrac,endFrac],…] of the playing file — drawn on the scrubber
      health // {known, risk, secondsBuffered, sustainable, secondsToEmpty}
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
      playFrac = 0;      // new file/seek target — the old play position means nothing now
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
      // Once the head is in hand, ask for the file TAIL too. An MKV's Cues (seek index) and an
      // MP4's moov atom (when not front-loaded by faststart) live at the END of the file; without
      // them mpv cannot build a seek index, so scrubbing either fails or forces a blind read from
      // a swarm that is busy feeding playback. select() with priority rather than critical() so it
      // rides behind the play head's window instead of competing with it.
      const wantTail = () => {
        try {
          const tail = Math.max(file._startPiece, file._endPiece - 3);
          active.select(tail, file._endPiece, 1);
        } catch (e) {}
      };
      const ready = (why) => { if (readied) return; readied = true; wantTail(); tlog('READY after ' + (Date.now() - t0) + 'ms (' + why + ') peers=' + active.numPeers + ' speed=' + Math.round(active.downloadSpeed / 1024) + 'KB/s -> ' + url); send('torrent:ready', { url }); };
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
      // Last-add-wins is the intended behaviour: adding a second torrent replaces the first,
      // which is what cancel()/teardown() rely on.
      // eslint-disable-next-line require-atomic-updates
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

  return { add, selectFile, cancel, teardown, setPlayhead };
};
