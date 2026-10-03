'use strict';

// Torrent/magnet streaming (main process). webtorrent 3.x is pure ESM, so it's
// loaded via dynamic import() from this CommonJS module. The torrent layer's only
// job is to expose a localhost HTTP URL (range-supported, served by webtorrent's
// own server) and hand it to the existing player-load path; mpv streams it.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { bufferHealth } = require('./buffer-plan');                 // runway, in seconds (the window itself is critical-aim's)
const { findMoov, isMp4Name } = require('./mp4-index');             // where the MP4 index actually lives
const { seekWindow, seekReadiness } = require('./seek-window');       // serving a range that has not arrived yet
const { createCriticalAim } = require('./critical-aim');              // who the critical window follows

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
// Fetching a trailing index is a handful of pieces, but they come from wherever the swarm has them,
// which can be slow. Give it real time — the alternative is a receiver stuck on a grey screen — then
// cast regardless rather than trapping the user in a wait with no way out.
const INDEX_TIMEOUT = 90000;
const HEADER_READ_TIMEOUT = 30000; // one box header; only slow when its piece is not on disk yet
// A receiver seeking into a part of the film that has not downloaded yet. The window is sized in
// seconds of playback for the same reason the readahead is (see buffer-plan.js), and the timeout is
// short on purpose: this runs while a television is holding an open request with nothing arriving
// on it, so failing to a plain blocking read is better than making it wait two minutes.
const SEEK_AHEAD_SECONDS = 20;
const SEEK_TIMEOUT = 25000;
const SEEK_POLL_MS = 200;

module.exports = function createTorrent(send, opts = {}) {
  let WT = null, client = null, active = null, server = null, progressTimer = null;
  let metaTimer = null, stallTimer = null, activeFile = null;
  let generation = 0, fileGeneration = 0, disposed = false, prebufferTimer = null, bindingListener = null;
  const loadWebTorrent = opts.loadWebTorrent || (() => import('webtorrent'));
  const sessionPaths = new WeakMap(), retiring = new Set();
  const pendingReads = new Set();
  const pollTimers = new Set();
  let cleanupFailed = false;

  // Never sweep a shared root: another instance or a retiring store may still own it.
  const root = path.join(app.getPath('temp'), 'spritz', 'torrents');
  let instanceDir = null;
  function ensureInstance() {
    if (instanceDir) return instanceDir;
    fs.mkdirSync(root, { recursive: true });
    instanceDir = fs.mkdtempSync(path.join(root, 'instance-'));
    return instanceDir;
  }
  function cleanInstance() {
    if (instanceDir && disposed && retiring.size === 0 && !cleanupFailed) {
      try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch (e) { console.warn('[torrent] cleanup', msg(e)); }
    }
  }
  function retire(torrent) {
    if (!torrent || retiring.has(torrent)) return;
    retiring.add(torrent);
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      retiring.delete(torrent);
      const dir = sessionPaths.get(torrent);
      if (!err && dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn('[torrent] cleanup', msg(e)); } }
      if (err) { cleanupFailed = true; console.warn('[torrent] retirement', msg(err)); }
      // A failed close can leave live file handles; retain that instance's files.
      if (!err) cleanInstance();
    };
    try { torrent.destroy({ destroyStore: true }, done); }
    catch (e) { try { torrent.destroy(done); } catch (other) { done(other); } }
  }
  function clearPrebuffer() {
    clearTimeout(prebufferTimer); prebufferTimer = null;
    if (bindingListener && server) server.server.removeListener('listening', bindingListener);
    bindingListener = null;
  }
  function cancelReads() { for (const cancelRead of [...pendingReads]) cancelRead(); }
  function cancelPolls() { for (const id of pollTimers) clearTimeout(id); pollTimers.clear(); }
  function schedulePoll(fn, ms) {
    const id = setTimeout(() => { pollTimers.delete(id); fn(); }, ms);
    pollTimers.add(id);
  }

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

  async function getClient(gen) {
    // Lazy module memo. Concurrent callers may both import, but import() is module-cached, so
    // both assign the identical namespace object — the second write is a no-op in effect.
    // eslint-disable-next-line require-atomic-updates
    if (!WT) WT = (await loadWebTorrent()).default; // ESM → dynamic import; .default export
    if (disposed || gen !== generation) return null;
    if (!client) {
      // Higher peer caps than the default (55) — a 4K/HDR release is ~25 Mbps, which needs many
      // peers to sustain so streaming playback can actually START and not buffer forever. (The old
      // player also had uTP via utp-native; we're TCP-only, so wider TCP fan-out matters more.)
      client = new WT({ maxConns: 200, dht: true });
      const owner = client;
      client.on('error', (e) => { if (!disposed && client === owner && active) send('torrent:error', { message: msg(e) }); });
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

  // Where the critical window is aimed and by whom — the viewer's playhead, or the packager's
  // source-read demand while a packaging run is active. The two positions, the authority rule and
  // the marking all live in critical-aim.js so they can be tested against a fake torrent; this
  // module feeds it facts (setPlayhead from the players, noteSourceRead from the source proxy,
  // setProducerActive from the packaging run) and hands it the live torrent on every progress tick.
  //
  // History, so the shape is not undone: the window used to be marked ONCE over the file head at
  // handoff and never moved, so past the prebuffer nothing was urgent and a marginal swarm
  // underran mpv. Then it followed playFrac every tick. Now it follows whoever criticalAuthority
  // says — which for plain playback is still the viewer, exactly as before.
  const aim = createCriticalAim({ tlog });
  function setPlayhead(frac, durationSec) { aim.setPlayhead(frac, durationSec); }
  function refreshCritical() { aim.refresh(active, activeFile); }

  // Contiguous downloaded bytes ahead of the play head: the runway before playback starves.
  // Reuses bufferedRanges(), which already merges contiguous pieces — a gap ends the runway, since
  // playback stops at the first missing piece no matter how much sits beyond it.
  function bytesAheadOfPlayhead() {
    const f = activeFile;
    if (!f || !f.length) return null;
    const playFrac = aim.viewerFrac();
    const seg = bufferedRanges().find(([a, b]) => playFrac >= a - 1e-9 && playFrac < b);
    return seg ? (seg[1] - playFrac) * f.length : 0;
  }

  // Where the swarm's effort is actually going. webtorrent's piece picker rotates between equal
  // priority selections, so two selections at the same priority split the peer request slots between
  // them — and a cast reading from the middle of a file while a stale selection still points at the
  // front would starve the half that matters, at a healthy-looking aggregate speed. Reading the
  // private _selections is deliberate: there is no public view of this, and inferring it from
  // download speed is exactly the guesswork that has cost this project days.
  function logSelections() {
    if (!DBG || !active) return;
    try {
      const items = (active._selections && active._selections._items) || active._selections || [];
      const desc = (Array.isArray(items) ? items : []).map((x) =>
        ((x.from + (x.offset || 0)) + '-' + x.to + '/p' + x.priority + (x.isStreamSelection ? 's' : ''))).join(' ');
      if (desc && desc !== lastSelDesc) { tlog('selections: ' + desc); lastSelDesc = desc; }
    } catch (e) {}
  }
  let lastSelDesc = null;

  function emitProgress() {
    if (!active) return;
    refreshCritical();
    logSelections();
    const ahead = bytesAheadOfPlayhead();
    // Reported, not acted on. Knowing "this stalls in about 20 seconds" is worth telling the user;
    // reacting by widening the urgent set would add contention exactly when the swarm is short of
    // it, which is the wrong direction.
    const health = bufferHealth({
      bufferedBytesAhead: ahead,
      downloadBps: active.downloadSpeed,
      fileBytes: activeFile && activeFile.length,
      durationSec: aim.duration()
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
    clearPrebuffer();
    cancelReads();
    cancelPolls();
    const torrent = active, selection = ++fileGeneration;
    if (!torrent || !torrent.files.includes(file)) return;
    activeFile = null;
    const current = () => !disposed && active === torrent && selection === fileGeneration;
    // Bind 0.0.0.0 (not 127.0.0.1) so the same server is reachable both at localhost
    // (for mpv on this Mac) AND at the Mac's LAN IP (for the Apple TV during AirPlay).
    const fresh = !server;
    if (!server) {
      server = client.createServer();
      if (DBG) require('./torrent-read-diagnostics').observeTorrentReads(server.server, { log: facts => tlog('source-http ' + JSON.stringify(facts)) });
      server.server.listen(0, '0.0.0.0');
    } // once, reused
    const go = () => {
      bindingListener = null;
      if (!current()) return;
      try { active.files.forEach((f) => f.deselect()); } catch (e) {}
      try { file.select(); } catch (e) {} // stream this file; webtorrent's sequential strategy downloads in order
      activeFile = file; // remember for the buffered-ranges viz
      aim.reset();       // new file — the old play position and any producer demand mean nothing now
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
      // them mpv cannot build a seek index. The dependency can merge this selection
      // with the whole-file range; effective request order still needs T1 qualification.
      const wantTail = () => {
        try {
          const tail = Math.max(file._startPiece, file._endPiece - 3);
          active.select(tail, file._endPiece, 1);
        } catch (e) {}
      };
      const ready = (why) => { if (readied) return; readied = true; wantTail(); tlog('READY after ' + (Date.now() - t0) + 'ms (' + why + ') peers=' + active.numPeers + ' speed=' + Math.round(active.downloadSpeed / 1024) + 'KB/s -> ' + url); send('torrent:ready', { url }); };
      const check = () => {
        if (readied || !current() || activeFile !== file) return; // superseded (file switch / cancel)
        let have = 0; const total = headEnd - file._startPiece;
        for (let p = file._startPiece; p < headEnd; p++) { let h = false; try { h = active.bitfield.get(p); } catch (e) {} if (h) have++; }
        send('torrent:progress', { peers: active.numPeers, senders: activeSenders(), speed: active.downloadSpeed,
          downloaded: active.downloaded, length: active.length, progress: active.progress, buffered: bufferedRanges(), buffering: total ? have / total : 1 });
        if (have >= total) return ready('head ready');
        if (Date.now() - t0 > PREBUFFER_TIMEOUT) return ready('timeout, head ' + have + '/' + total);
        prebufferTimer = setTimeout(check, 300);
      };
      check();
    };
    if (server.server.listening) go();
    else { tlog('server not listening yet — waiting for bind'); bindingListener = go; server.server.once('listening', go); }
  }

  async function add(src) {
    if (disposed) return;
    cancel();
    const gen = generation;
    let sessionDir = null;
    try {
      tlog('add ' + String(src).slice(0, 70) + (active ? ' (replacing an active torrent)' : ''));
      const c = await getClient(gen);
      if (!c || disposed || gen !== generation) return;
      sessionDir = fs.mkdtempSync(path.join(ensureInstance(), 'session-'));
      // No metadata in META_TIMEOUT → dead magnet (no reachable peers/trackers). Without
      // this the renderer just sits on "connecting…" forever with no feedback.
      metaTimer = setTimeout(() => {
        if (gen !== generation || disposed) return;
        console.error('[torrent] metadata timeout');
        send('torrent:error', { message: 'No peers found — could not fetch torrent info. The magnet may be dead or your network is blocking it.' });
        cancel();
      }, META_TIMEOUT);
      let metadataReady = false;
      // Pieces are already stored on disk. A twenty-piece read cache can duplicate
      // hundreds of MiB for large-piece 4K torrents alongside the player caches.
      const t = c.add(src, { path: sessionDir, announce: BEST_TRACKERS, storeCacheSlots: 0 }, (torrent) => {
        if (gen !== generation || disposed || metadataReady) return;
        metadataReady = true;
        if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
        const playable = torrent.files.filter(isPlayable).slice().sort(natSort);
        tlog('metadata "' + torrent.name + '" files=' + torrent.files.length + ' playable=' + playable.length + ' peers=' + torrent.numPeers);
        send('torrent:metadata', {
          name: torrent.name,
          files: torrent.files.map((f, i) => ({ index: i, name: f.name, length: f.length, playable: isPlayable(f) }))
        });
        progressTimer = setInterval(() => { if (gen === generation && active === torrent) emitProgress(); }, 1000);
        // Metadata arrived but if no bytes ever download, there are no data peers — warn.
        stallTimer = setTimeout(() => {
          if (gen === generation && active === torrent && active.downloaded === 0) {
            console.error('[torrent] stalled — 0 bytes');
            send('torrent:error', { message: 'Connected but no data is downloading — no seeders available for this torrent.' });
          }
        }, STALL_TIMEOUT);
        if (playable.length === 1) startServerAndPlay(playable[0]);
        else if (playable.length === 0) send('torrent:error', { message: 'No playable video found in this torrent.' });
        // >1 → wait for selectFile from the renderer's file picker
      });
      t.on('error', (e) => { if (gen !== generation || active !== t || disposed) return; tlog('ERROR ' + msg(e)); send('torrent:error', { message: msg(e) }); });
      t.on('warning', (e) => { if (gen === generation && active === t) console.warn('[torrent] warn', msg(e)); });
      // Additive diagnostics only (the timeout-driven error path above is unchanged): webtorrent fires
      // noPeers per announce source (dht/tracker/lsd) when that source returns nobody — logs help tell a
      // dead magnet apart from a slow-tracker/healthy-DHT start without waiting the full 40-45s timers.
      t.on('noPeers', (announceType) => { if (gen === generation && active === t) tlog('noPeers via ' + announceType); });
      // Last-add-wins is the intended behaviour: adding a second torrent replaces the first,
      // which is what cancel()/teardown() rely on.
      // eslint-disable-next-line require-atomic-updates
      active = t;
      sessionPaths.set(t, sessionDir);
    } catch (e) {
      if (sessionDir) { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {} }
      if (disposed || gen !== generation) return;
      clearTimeout(metaTimer); metaTimer = null;
      console.error('[torrent] add err', msg(e));
      send('torrent:error', { message: msg(e) });
    }
  }

  function selectFile(index) {
    if (active && active.files[index]) startServerAndPlay(active.files[index]);
  }

  // Read a byte range out of the active file. Small reads only — this exists to fetch box headers.
  function readRange(file, start, length) {
    return new Promise((resolve, reject) => {
      let s;
      try { s = file.createReadStream({ start, end: start + length - 1 }); } catch (e) { return reject(e); }
      const bufs = [];
      let settled = false, to = null;
      const finish = (err) => {
        if (settled) return;
        settled = true; clearTimeout(to); pendingReads.delete(cancelRead);
        if (err) { try { s.destroy(); } catch (_) {} reject(err); }
        else resolve(Buffer.concat(bufs));
      };
      const cancelRead = () => finish(new Error('source read cancelled'));
      pendingReads.add(cancelRead);
      to = setTimeout(() => finish(new Error('read timed out')), HEADER_READ_TIMEOUT);
      s.on('data', (b) => { if (!settled) bufs.push(b); });
      s.on('error', finish);
      s.on('end', () => finish());
      s.on('close', () => finish(new Error('source read closed before completion')));
    });
  }

  // Make sure a cast can actually start.
  //
  // Playing locally hides this problem: mpv seeks to wherever the index is and waits. A receiver
  // cannot, and neither can the transcoder feeding it — without the index nothing demuxes, so not a
  // single byte reaches the TV and it sits on its idle screen looking like a hang. When the index is
  // at the end of the file (see mp4-index.js) and the torrent has only downloaded the front, that is
  // exactly what happens.
  //
  // So before casting, find the index and fetch it. Deliberately NOT a blanket "download the tail":
  // that was tried in June and reverted, because making every first play wait on distant pieces
  // stalled startup over a cold swarm. This runs only on the cast path, only for MP4-family files,
  // and only fetches when the index is genuinely out of reach — a front-loaded file returns
  // immediately, having read two box headers.
  function ensureIndexForCast(cb) {
    const file = activeFile, t = active;
    const selection = fileGeneration;
    const current = () => !disposed && active === t && activeFile === file && selection === fileGeneration;
    const done = (why) => { if (!current()) return; tlog('cast index: ' + why); try { cb(); } catch (e) {} };
    if (!t || !file) return done('no active torrent — nothing to do');
    if (!isMp4Name(file.name)) return done('not an MP4 container — skipped');
    findMoov((off, len) => current() ? readRange(file, off, len) : Promise.reject(new Error('source changed')), file.length).then((moov) => {
      if (!current()) return;
      if (!moov) return done('index not located — casting anyway');
      if (moov.atFront) return done('index is at the front — nothing to fetch');
      const pl = t.pieceLength, base = file.offset || 0;
      const from = Math.floor((base + moov.offset) / pl);
      const to = Math.floor((base + moov.offset + moov.size - 1) / pl);
      const have = () => { let n = 0; for (let p = from; p <= to; p++) { let h = false; try { h = t.bitfield.get(p); } catch (e) {} if (h) n++; } return n; };
      const total = to - from + 1;
      if (have() >= total) return done('index already downloaded (' + total + ' pieces)');
      tlog('cast index: at byte ' + moov.offset + ' (' + Math.round(moov.size / 1048576) + 'MB, pieces ' + from + '-' + to + ') — fetching before cast');
      send('toast', { message: 'Fetching the file index before casting…' });
      // Mark the needed range, but critical flags govern reservation recovery;
      // they do not alone guarantee that a distant index is requested next.
      try { t.select(from, to, 1); } catch (e) {}
      try { t.critical(from, to); } catch (e) {}
      const t0 = Date.now();
      const poll = () => {
        if (!current()) return;
        const n = have();
        if (n >= total) return done('index ready after ' + (Date.now() - t0) + 'ms');
        if (Date.now() - t0 > INDEX_TIMEOUT) return done('index fetch timed out at ' + n + '/' + total + ' pieces — casting anyway');
        schedulePoll(poll, 400);
      };
      poll();
    }).catch((e) => done('index lookup failed (' + e.message + ') — casting anyway'));
  }

  // Make a byte range the receiver just asked for actually arrive.
  //
  // This is ensureIndexForCast aimed at a seek target instead of at the moov box, and it is the one
  // thing standing between a still-downloading torrent and a working scrubber. webtorrent would
  // eventually serve the read on its own — it selects the pieces and blocks — but unprioritised it
  // queues behind the sequential readahead, and a television gives up long before the bytes land.
  //
  // byteStart — an offset within the FILE, which is what a Range header carries.
  // Calls back with true once the read can proceed, or false on timeout. False is not fatal: the
  // caller forwards the request anyway and lets webtorrent block, which is exactly what happens
  // today. This only ever makes the wait shorter.
  function ensureBytes(byteStart, cb) {
    const file = activeFile, t = active;
    const selection = fileGeneration;
    const current = () => !disposed && active === t && activeFile === file && selection === fileGeneration;
    const done = (ok, why) => { if (!current()) return; tlog('seek: ' + why); try { cb(ok); } catch (e) {} };
    if (!t || !file) return done(false, 'no active torrent');
    const mediaDuration = aim.duration();
    const bps = mediaDuration > 0 ? file.length / mediaDuration : 0;
    const win = seekWindow({
      byteStart,
      fileOffset: file.offset || 0,
      fileLength: file.length,
      pieceLength: t.pieceLength,
      aheadBytes: bps > 0 ? bps * SEEK_AHEAD_SECONDS : t.pieceLength * 4
    });
    if (!win) return done(false, 'byte ' + byteStart + ' is not a seekable offset in this file');
    const have = (p) => { try { return t.bitfield.get(p); } catch (e) { return false; } };
    const ready = () => seekReadiness({ at: win.at, end: win.end, have });

    if (ready().ready) return done(true, 'byte ' + byteStart + ' already downloaded (pieces ' + win.at + '-' + win.end + ')');

    // Move the VIEWER's play head, because this IS the viewer: the only caller is the DLNA proxy
    // relaying a television's ranged GET (main.js onSeekBytes), and the proxy fires it for viewer
    // reads only — a packager's reads arrive as producer demand through noteSourceRead and never
    // come here. So moving the playhead is the honest record of a viewer seek, not an
    // impersonation; and it is still what keeps the tick from re-aiming at where the receiver used
    // to be, since with no active producer the tick follows the viewer.
    setPlayhead(byteStart / file.length, mediaDuration);

    tlog('seek: byte ' + byteStart + ' needs pieces ' + win.at + '-' + win.end + ' — prioritising');
    try { t.select(win.at, win.end, 1); } catch (e) {}
    try { if (Array.isArray(t._critical)) t._critical.length = 0; } catch (e) {}
    try { t.critical(win.at, win.end); } catch (e) {}

    const t0 = Date.now();
    const poll = () => {
      if (!current()) return;
      const r = ready();
      if (r.ready) return done(true, 'ready after ' + (Date.now() - t0) + 'ms (' + r.contiguous + '/' + r.total + ' pieces)');
      if (Date.now() - t0 > SEEK_TIMEOUT) return done(false, 'timed out at ' + r.contiguous + '/' + r.total + ' pieces — forwarding anyway');
      schedulePoll(poll, SEEK_POLL_MS);
    };
    poll();
  }

  function cancel() {
    generation++; fileGeneration++;
    clearPrebuffer();
    cancelReads();
    cancelPolls();
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    const old = active;
    active = null; // invalidate callbacks before destruction can emit events
    retire(old);
    activeFile = null;
    aim.reset();
  }

  function teardown() {
    disposed = true;
    cancel();
    try { if (server) server.close(); } catch (e) {} // close server BEFORE client.destroy (avoid EADDRINUSE)
    try { if (client) client.destroy(); } catch (e) {}
    server = null; client = null;
    cleanInstance();
  }

  // The packager's side of the critical window. noteSourceRead takes the source proxy's
  // observations (only reader:'producer' ones count; see critical-aim.js); setProducerActive is
  // the packaging run's lifecycle, to be called by the transport epoch that owns the ffmpeg.
  // aimState is for the log: who is in charge, where everyone is, what was marked.
  return { add, selectFile, cancel, teardown, setPlayhead, ensureIndexForCast, ensureBytes,
    registerProducer: () => {
      const lease = aim.registerProducer();
      let lastLog = 0;
      const logPriority = force => {
        if (!DBG || !force && Date.now() - lastLog < 1000) return;
        lastLog = Date.now();
        tlog('owned-source-priority ' + JSON.stringify(aim.state()));
      };
      return {
        noteSourceRead: o => { lease.noteSourceRead(o); refreshCritical(); logPriority(false); },
        setActive: active => { lease.setActive(active); refreshCritical(); logPriority(true); },
        dispose: () => { lease.dispose(); refreshCritical(); logPriority(true); }
      };
    },
    noteSourceRead: (o) => aim.noteSourceRead(o), setProducerActive: (a) => aim.setProducerActive(a),
    aimState: () => aim.state() };
};
