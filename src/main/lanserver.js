'use strict';

// LAN media server (main process) — lets a TV (AirPlay/Chromecast) fetch local files
// and torrent streams over the network. The receiver fetches the URL itself, so it must
// be the Mac's LAN IP (loopback is unreachable from the TV). Binds 0.0.0.0.
//
// Two roles:
//   /file/<token>   — serve a file with HTTP range support (seek/scrub). Used for both
//                     original local files AND remuxed temp files.
//
// Remux-on-demand: containers the receiver can't open (MKV/AVI/TS/WebM) whose VIDEO is
// already H.264/HEVC are repackaged to a temp MP4 with `-c:v copy` (lossless, ~no CPU);
// incompatible audio (AC3/DTS/Opus/FLAC/…) is transcoded to AAC. The temp file is then
// served via /file/ with range support — AVPlayer rejects a live non-seekable pipe
// (status: failed), so it must be a complete, range-seekable file. Video codecs the
// receiver can't decode (VP9/AV1/Xvid) are left un-castable here (needs full transcode).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function findBin(name) {
  const bundled = process.resourcesPath ? [path.join(process.resourcesPath, 'bin', name)] : []; // packaged → portable
  return bundled.concat(['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name])
    .find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || name;
}
const FFPROBE = findBin('ffprobe');
const FFMPEG = findBin('ffmpeg');

// The private-LAN IPv4 the TV can route to. Prefer physical NICs (en/eth) on a private
// subnet — a Mac with an active VPN exposes utun/ppp interfaces whose address the TV can't
// reach, and returning that breaks every LAN-served cast (AirPlay-HLS, DLNA, Chromecast).
function isPrivate(a) {
  const o = a.split('.').map(Number);
  return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
}
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const phys = []; // private IPv4 on a physical NIC: {name, addr}
  let fallback = null;
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal || !isPrivate(ni.address)) continue;
      if (/^(en|eth)/i.test(name)) phys.push({ name, addr: ni.address });
      else if (!fallback) fallback = ni.address; // bridge/other private, not VPN-public
    }
  }
  // Prefer the PRIMARY NIC (lowest en/eth index) — the TV is on the main Wi-Fi/Ethernet, not a
  // secondary en5/en7 (Thunderbolt-bridge / iPhone-USB) which is a different segment the TV can't
  // reach. Returning that address makes the receiver's HTTP GET fail → cast connects but no video.
  phys.sort((a, b) => (parseInt((a.name.match(/\d+/) || [99])[0], 10)) - (parseInt((b.name.match(/\d+/) || [99])[0], 10)));
  return phys.length ? phys[0].addr : fallback;
}

// Quick extension gate (https/direct path still uses this — no probe for remote URLs).
const AV_OK = /\.(mp4|m4v|mov|m3u8|mp3|m4a|aac)(\?|#|$)/i;
function avCompatible(p) { return AV_OK.test(String(p || '')); }

// Codecs the receivers (AVPlayer + Chromecast Default Media Receiver) reliably decode in an
// MP4/HLS container WITHOUT a capability hint. VP9/AV1 are decodable by modern receivers but NOT
// muxable into fMP4/HLS the way Apple/Cast want, so they still need a transcode on the cast path
// (the DLNA route serves the original WebM/MKV and the TV decodes them natively — preferred).
const VIDEO_OK = new Set(['h264', 'hevc']);
const AUDIO_OK = new Set(['aac', 'mp3', 'alac']);
// Audio codecs a capability-confirmed receiver can take as a lossless passthrough (surround intact).
// AC3/EAC3 are passthrough-supported by AirPlay/AVPlayer and the Google Cast receiver and decoded
// natively by webOS — copying them preserves 5.1/7.1 that a forced AAC stereo downmix would destroy.
const AUDIO_PASSTHROUGH = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3']);

// One-time probe of what the BUNDLED ffmpeg can actually do — gates burn-in / tonemap code paths so
// they light up automatically if the binary is ever rebuilt with libass / zscale, and stay disabled
// (graceful) otherwise. Synchronous, runs once at module load; failure → assume the feature is absent.
function ffmpegHasFilter(name) {
  try {
    const out = require('child_process').execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 8000 });
    return new RegExp('(^|\\n)\\s*[.TSC]{1,3}\\s+' + name + '\\s', 'm').test(out);
  } catch (e) { return false; }
}
// (Bundled ffmpeg has no `subtitles`/libass filter → no burn-in; PGS/VOBSUB bitmap subs are skipped
// and steered to the DLNA route, where the TV renders them. No `zscale` either → tonemap is gated.)
const CAN_TONEMAP = ffmpegHasFilter('tonemap') && ffmpegHasFilter('zscale'); // proper HDR→SDR needs both

// Sniff a subtitle file's text encoding so ffmpeg can decode it to clean UTF-8 WebVTT instead of
// mojibake (no charset-detector dependency in the app). BOM first, then a UTF-8 validity scan, then
// fall back to Windows-1252 (the overwhelmingly common legacy encoding for Western .srt files).
function sniffCharenc(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'UTF-8';
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'UTF-16LE';
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'UTF-16BE';
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b < 0x80) { i++; continue; }
      let n; // length of this UTF-8 sequence
      if ((b & 0xE0) === 0xC0) n = 1; else if ((b & 0xF0) === 0xE0) n = 2; else if ((b & 0xF8) === 0xF0) n = 3; else return 'WINDOWS-1252';
      for (let k = 1; k <= n; k++) { if (i + k >= buf.length || (buf[i + k] & 0xC0) !== 0x80) return 'WINDOWS-1252'; }
      i += n + 1;
    }
    return 'UTF-8';
  } catch (e) { return 'UTF-8'; }
}

// Receiver capability profile — drives copy-vs-transcode. A capability-confirmed TV (the LG
// NANO80T6A and any webOS-24 / Chromecast-built-in / Apple-TV class receiver) decodes 4K HEVC
// (incl. HDR10) and AC3/EAC3 passthrough, so we COPY instead of needlessly transcoding to 1080p
// AAC stereo. Unknown/legacy receivers get the conservative profile (downscale 4K, AAC audio).
// caps = { hevc, hevc4k, h264_4k, hdr10, dovi, audioCopy:Set, maxHeight }
//   • hevc    — receiver decodes HEVC at all (false → transcode HEVC to H.264, for old 1080p dongles)
//   • hevc4k  — decodes 4K HEVC (copy instead of downscaling to 1080p)
//   • hdr10   — displays HDR10 (else HDR is tonemapped to SDR)
// The DEFAULT (no caps) mirrors the historical conservative behaviour: copy ≤1080p H.264/HEVC incl.
// HDR10, downscale 4K to 1080p, AAC audio — safe for any AVPlayer/Cast receiver.
const CAPS_CONSERVATIVE = { hevc: true, hevc4k: false, h264_4k: false, hdr10: true, dovi: false, audioCopy: AUDIO_OK, maxHeight: 1080 };
const CAPS_FULL = { hevc: true, hevc4k: true, h264_4k: true, hdr10: true, dovi: false, audioCopy: AUDIO_PASSTHROUGH, maxHeight: 2160 };
function normCaps(caps) {
  if (!caps) return CAPS_CONSERVATIVE;
  return {
    hevc: caps.hevc !== false, hevc4k: !!caps.hevc4k, h264_4k: !!caps.h264_4k,
    hdr10: caps.hdr10 !== false, dovi: !!caps.dovi,
    audioCopy: caps.audioCopy instanceof Set ? caps.audioCopy : new Set(caps.audioCopy || AUDIO_OK),
    maxHeight: caps.maxHeight || 1080
  };
}

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  // original containers served untouched to a DLNA renderer (LG webOS decodes these natively →
  // full 4K HEVC/HDR, no transcode). Correct MIME matters so the TV knows how to play them.
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ogv': 'video/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.vtt': 'text/vtt',
  '.srt': 'text/srt', '.smi': 'application/smil'
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ffprobe the primary video + audio codec of an input (file path or http URL).
function probe(input, cb) {
  let out = '';
  const ps = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json', input], { timeout: 15000 });
  ps.stdout.on('data', (d) => { out += d; });
  ps.on('error', () => cb(null));
  ps.on('close', () => {
    try {
      const streams = (JSON.parse(out).streams) || [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      cb({ vcodec: v && v.codec_name, acodec: a && a.codec_name });
    } catch (e) { cb(null); }
  });
}

const REMUX_DIR = path.join(os.tmpdir(), 'spritz', 'remux');
const HLS_DIR = path.join(os.tmpdir(), 'spritz', 'hls');

module.exports = function createLanServer(opts) {
  const onWarn = (opts && opts.onWarn) || (() => {});
  // Sweep leftover transcode segments / remux temp MP4s from previous runs at startup. A long cast
  // keeps every fMP4 segment (a full transcoded copy) and remux makes a full temp MP4 — crashes can
  // orphan gigabytes here. Active sessions clean themselves (cancelHls/cancelRemux); this clears the
  // dead ones. Safe at construction: nothing is streaming yet.
  try { fs.rmSync(REMUX_DIR, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(HLS_DIR, { recursive: true, force: true }); } catch (e) {}
  let server = null, port = 0;
  let hlsWatch = null, hlsWarned = false; // disk watchdog for the live-HLS temp dir
  const files = new Map();  // token → absolute path  (/file/, originals + remuxed temp files)
  const dlnaProxies = new Map(); // token → { url, type }  (/dlna/ DLNA-compliant proxy → webtorrent)
  let remuxProc = null, remuxOut = null; // current ffmpeg remux + its temp file
  let hlsProc = null, hlsDir = null, hlsToken = null; // current live HLS remux
  let subProcs = []; // background WebVTT sidecar-extraction ffmpegs (one per text sub track)
  let mkvProc = null, mkvEntry = null; // current single-stream Matroska cast (Chromecast transport)
  const newToken = () => crypto.randomBytes(16).toString('hex'); // unguessable (LAN-exposed)

  function ensure(cb) {
    if (server && server.listening) return cb();
    server = http.createServer(handle);
    server.on('error', (e) => console.error('[lan] server err', e.message));
    server.listen(0, '0.0.0.0', () => { port = server.address().port; cb(); });
  }

  function handle(req, res) {
    // CORS preflight — the Google Cast receiver sends one before GETting a sideloaded WebVTT track
    // (its Range header isn't CORS-safelisted). Answer it so the subtitle track loads.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    const hm = /^\/hls\/([^/]+)\/([^?]+)/.exec(req.url || '');
    if (hm) return serveHlsFile(req, res, hm[1], hm[2]);
    const km = /^\/mkv\/([^/?]+)/.exec(req.url || '');
    if (km) return serveMkvStream(req, res, km[1]);
    const sm = /^\/sub\/([^/]+)\/([^/?]+)/.exec(req.url || '');
    if (sm) return serveMkvSub(req, res, sm[1], decodeURIComponent(sm[2]));
    const dm = /^\/dlna\/([^/]+)/.exec(req.url || '');
    if (dm) return serveDlnaProxy(req, res, dm[1]);
    const fm = /^\/file\/([^/]+)/.exec(req.url || '');
    return serveFile(req, res, fm && files.get(fm[1]));
  }

  // ---- DLNA-aware proxy (for torrent streams) ----------------------------------------------------
  // webOS DLNA renderers are strict: before playing they send a HEAD and expect DLNA response
  // headers (contentFeatures.dlna.org / TransferMode) + range support. webtorrent's own HTTP server
  // emits none of that, so the TV reports "device is disconnected". This proxy sits in front of the
  // webtorrent localhost server, speaks DLNA to the TV, and forwards ranged GETs underneath — so the
  // LG connects, plays the original MKV/HEVC/HDR natively, and seeks via byte-range.
  // 4th protocolInfo field. MUST match the DIDL protocolInfo in dlna.js byte-for-byte (strict webOS
  // compares the HTTP contentFeatures.dlna.org header against the SOAP DIDL and rejects on mismatch).
  //   STATIC = complete, fully-seekable file: OP=01 (byte-range seek) + STREAMING|BACKGROUND|CONNECTION_STALL|DLNA_V15.
  //   LIVE   = still-downloading torrent proxy: OP=00 (NO seek — so the LG reads linearly and never
  //            byte-seeks onto not-yet-downloaded pieces, the cause of the mid-play drops) + S0_INCREASE|
  //            SN_INCREASE (a growing source with no fixed end) | STREAMING | CONNECTION_STALL (HOLD, don't
  //            drop, while buffering) | DLNA_V15. FLAGS 0x0D500000. (research-dlna; mirror in dlna.js didl.)
  const DLNA_FLAGS_STATIC = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  const DLNA_FLAGS_LIVE = 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=0D500000000000000000000000000000';
  // serveDlna(upstreamLocalhostUrl, contentType, cb) → cb(proxyLanUrl|null)
  function serveDlna(upstreamUrl, type, cb) {
    const lan = lanAddress();
    if (!lan || !upstreamUrl) return cb(null);
    ensure(() => {
      const token = newToken();
      dlnaProxies.set(token, { url: upstreamUrl, type: type || 'video/mp4' });
      const name = (String(upstreamUrl).split('?')[0].split('/').pop()) || 'video';
      cb(`http://${lan}:${port}/dlna/${token}/${name}`);
    });
  }
  function serveDlnaProxy(req, res, token) {
    const ent = dlnaProxies.get(token);
    if (!ent) { res.writeHead(404); res.end(); return; }
    let u; try { u = new URL(ent.url); } catch (e) { res.writeHead(404); res.end(); return; }
    const upReq = (method, headers, onRes) => {
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, onRes);
      r.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch (e) {} });
      return r;
    };
    const dlnaHdrs = (extra) => Object.assign({
      'Content-Type': ent.type,
      'Accept-Ranges': 'bytes',
      // The proxy only ever fronts a (possibly still-downloading) torrent → advertise the LIVE profile.
      'contentFeatures.dlna.org': DLNA_FLAGS_LIVE,
      'transferMode.dlna.org': req.headers['transfermode.dlna.org'] || 'Streaming'
    }, extra || {});
    // HEAD: webtorrent's server may not answer HEAD, so probe the total size with a 1-byte ranged
    // GET (→ 206 Content-Range: bytes 0-0/TOTAL) and reply with DLNA headers + the full length.
    if (req.method === 'HEAD') {
      const probe = upReq('GET', { Range: 'bytes=0-0' }, (ur) => {
        let total = 0;
        const cr = ur.headers['content-range'];
        if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) total = parseInt(m[1], 10); }
        else if (ur.headers['content-length']) total = parseInt(ur.headers['content-length'], 10);
        ur.destroy();
        res.writeHead(200, dlnaHdrs(total ? { 'Content-Length': String(total) } : {}));
        res.end();
      });
      probe.end();
      return;
    }
    // GET (ranged or whole): forward to webtorrent, relay its status + range headers, add DLNA ones.
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = upReq('GET', headers, (ur) => {
      const h = dlnaHdrs();
      if (ur.headers['content-range']) h['Content-Range'] = ur.headers['content-range'];
      if (ur.headers['content-length']) h['Content-Length'] = ur.headers['content-length'];
      res.writeHead(ur.statusCode || 200, h);
      // A mid-body upstream failure (a webtorrent read aborts, a peer is lost) must NOT be relayed as a
      // clean FIN: a DLNA renderer reads a clean end-of-body as "stream finished" and STOPS instead of
      // resuming. Reset the socket (RST) so the LG re-issues the ranged GET and reconnects. Fire only on
      // an INCOMPLETE body — ur.pipe() calls res.end() on normal completion (writableEnded → true).
      const fatal = () => { try { res.destroy(); } catch (e) {} try { ur.destroy(); } catch (e) {} };
      ur.on('error', fatal);
      ur.on('aborted', fatal);
      ur.on('close', () => { if (!res.writableEnded) fatal(); });
      ur.pipe(res);
    });
    req.on('close', () => { try { up.destroy(); } catch (e) {} }); // TV seeked/closed → drop upstream
    res.on('close', () => { try { up.destroy(); } catch (e) {} }); // downstream died → release the webtorrent reader
    up.end();
  }

  // Serve a file from the live-HLS temp dir (master/media .m3u8, fMP4 segments, .vtt subs).
  // Nested subdirs are allowed (multi-rendition output: stream_0/…, stream_1/…), but no `..`.
  function serveHlsFile(req, res, token, name) {
    name = decodeURIComponent(name);
    if (token !== hlsToken || !hlsDir || name.split('/').includes('..')) { res.writeHead(404); res.end(); return; }
    const f = path.join(hlsDir, name), stat = safeStat(f);
    if (!stat) { res.writeHead(404); res.end(); return; }
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : name.endsWith('.vtt') ? 'text/vtt' : 'video/mp4'; // fMP4 segments / WebVTT subs
    // Range support is REQUIRED: AVPlayer (AirPlay) byte-range-requests fMP4 segments + init.mp4 and
    // REJECTS the whole HLS stream (AVError -12939 "server not correctly configured" → "playback
    // failed") if the server answers a Range request with a plain 200. /file/ already does this.
    const range = req.headers.range;
    if (range) {
      const mr = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = mr[1] ? parseInt(mr[1], 10) : 0;
      let end = mr[2] ? parseInt(mr[2], 10) : stat.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f, { start, end }).on('error', () => res.end()).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f).on('error', () => res.end()).pipe(res);
    }
  }

  function serveFile(req, res, file) {
    let stat;
    if (!file || !(stat = safeStat(file))) { res.writeHead(404); res.end(); return; }
    const type = mimeFor(file);
    // DLNA headers so a strict webOS renderer accepts a LOCAL file served here too (a non-DLNA
    // AirPlay/cast client simply ignores them). OP=01 = byte-range seek; matches dlna.js protocolInfo.
    // CORS: the Google Cast receiver REQUIRES Access-Control-Allow-Origin to load a sideloaded WebVTT
    // subtitle track — without it the sub track silently fails to render. Harmless for other clients.
    const dlna = { 'contentFeatures.dlna.org': DLNA_FLAGS_STATIC, // complete, fully-seekable local file
      'transferMode.dlna.org': req.headers['transfermode.dlna.org'] || 'Streaming',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };
    const range = req.headers.range;
    if (range) {
      const mr = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = mr[1] ? parseInt(mr[1], 10) : 0;
      let end = mr[2] ? parseInt(mr[2], 10) : stat.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, Object.assign({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type }, dlna));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).on('error', () => res.end()).pipe(res);
    } else {
      res.writeHead(200, Object.assign({ 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Type': type }, dlna));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    }
  }

  function cancelRemux() {
    if (remuxProc) { try { remuxProc.kill('SIGKILL'); } catch (e) {} remuxProc = null; }
    if (remuxOut) { try { fs.unlinkSync(remuxOut); } catch (e) {} remuxOut = null; }
  }
  function cancelHls() {
    if (hlsProc) { try { hlsProc.kill('SIGKILL'); } catch (e) {} hlsProc = null; }
    for (const p of subProcs) { try { p.kill('SIGKILL'); } catch (e) {} }
    subProcs = [];
    if (hlsWatch) { clearInterval(hlsWatch); hlsWatch = null; } hlsWarned = false;
    if (hlsDir) { try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) {} hlsDir = null; }
    hlsToken = null;
  }
  // The HLS remux runs faster than playback and keeps every segment (a receiver may seek back),
  // so the temp dir grows to ~the whole movie. Warn once if it gets large rather than silently
  // filling the disk (it's reclaimed on cancelHls/teardown when the cast ends).
  function startHlsWatch(dir) {
    if (hlsWatch) clearInterval(hlsWatch);
    hlsWatch = setInterval(() => {
      let bytes = 0;
      try { (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { bytes += fs.statSync(f).size; } catch (x) {} } } })(dir); } catch (e) {}
      if (!hlsWarned && bytes > 6 * 1024 * 1024 * 1024) { hlsWarned = true; onWarn('Casting is using a lot of temp disk space (' + Math.round(bytes / 1e9) + ' GB). It frees up when you stop casting.'); }
    }, 30000);
  }

  // Extract each text subtitle track to a standalone WebVTT sidecar (no libass, no broken HLS
  // sub-muxing). Runs in the background. Also writes a single-segment subtitle MEDIA playlist
  // (sub_N.m3u8) wrapping the .vtt — that's what an HLS player (AVPlayer / the cast receiver) needs
  // to expose a selectable subtitle rendition (a raw .vtt URL is not an HLS subtitle track). The
  // playlist starts as an OPEN EVENT list pointing at an empty-but-valid stub and is finalized to
  // VOD (ENDLIST) once cues are extracted — at the SAME stable URI (no _v2 swap; see RC-1 below).
  // Returns entries used to build the master.
  function extractSubs(input, subs, lan, token, dur, dir) {
    // Every emitted WebVTT carries X-TIMESTAMP-MAP so cue 0 aligns to media PTS 0 (our fMP4 video
    // starts at 0). ffmpeg's webvtt muxer omits this and some players then render nothing — cheap,
    // spec-safe to always include. (Investigation RC-3.)
    const VTT_HEAD = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n';
    const span = dur > 0 ? Math.ceil(dur) : 36000; // single segment spans the whole track
    // The subtitle's segment URI is STABLE (always sub_N.vtt). Previously the stub was published
    // under one URI and the finalized cues under a NEW URI (sub_N_v2.vtt) with the playlist rewritten
    // to point at it — but mutating an existing segment's URI in an EVENT playlist violates RFC8216
    // §6.2.1, so AVPlayer (having cached the empty stub) would never pick up the cues. Instead we
    // overwrite the SAME .vtt in place and finalize the playlist as VOD; /hls/ sends Cache-Control:
    // no-cache so the player refetches the now-populated URL. (Investigation RC-1.)
    const writePl = (pl, vttName, ended) => {
      try {
        fs.writeFileSync(path.join(dir, pl),
          `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:${span}\n#EXT-X-MEDIA-SEQUENCE:0\n` +
          `#EXT-X-PLAYLIST-TYPE:${ended ? 'VOD' : 'EVENT'}\n#EXTINF:${span}.0,\n${vttName}\n` +
          (ended ? '#EXT-X-ENDLIST\n' : ''));
      } catch (e) {}
    };
    // Write every rendition's stub + open playlist up front (so the master/menu is complete), but
    // run the EXTRACTORS with bounded concurrency: each ffmpeg reads the whole (often multi-GB)
    // source to EOF, so a file with 20–30 sub tracks would otherwise spawn 20–30 full-file readers
    // at once — a disk-I/O storm that competes with the live video transcode and can stall the cast.
    const tasks = (subs || []).map((s, i) => {
      const baseN = `sub_${i}_${cleanName(s.lang)}`; // unique per rendition (idx OR external file)
      const vtt = `${baseN}.vtt`;       // stable URI — empty-but-valid stub now, real cues on close
      const work = `${baseN}.work.vtt`; // ffmpeg writes here, then we merge into `vtt` with the header
      const pl = `${baseN}.m3u8`;
      try { fs.writeFileSync(path.join(dir, vtt), VTT_HEAD); } catch (e) {} // valid empty rendition
      writePl(pl, vtt, false); // open EVENT playlist pointing at the stable URI
      return { idx: s.idx, path: s.path, vtt, work, pl, lang: s.lang, name: s.name };
    });
    let running = 0, qi = 0;
    const pump = () => {
      if (hlsToken !== token) return; // superseded → stop launching extractors
      while (running < 3 && qi < tasks.length) {
        const t = tasks[qi++]; running++;
        // Embedded track (-map 0:s:idx of the source) OR an external .srt/.ass file (charset-sniffed
        // so legacy Windows-1252 subs don't cast as mojibake). Both end up as clean UTF-8 WebVTT.
        const ffArgs = t.path
          ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(t.path), '-i', t.path, '-c:s', 'webvtt', '-f', 'webvtt', path.join(dir, t.work)]
          : ['-loglevel', 'error', '-y', '-i', input, '-map', '0:s:' + t.idx, '-c:s', 'webvtt', '-f', 'webvtt', path.join(dir, t.work)];
        const ff = spawn(FFMPEG, ffArgs);
        ff.stderr.on('data', () => {});
        ff.on('error', () => { running--; pump(); });
        ff.on('close', (code) => {
          running--;
          if (hlsToken === token) {
            let ok = false; try { ok = code === 0 && fs.statSync(path.join(dir, t.work)).size > 12; } catch (e) {}
            // Cues extracted → re-header with X-TIMESTAMP-MAP, publish into the SAME sub_N.vtt,
            // finalize the playlist as VOD. On failure leave the open stub (player keeps revalidating).
            if (ok) {
              try {
                const raw = fs.readFileSync(path.join(dir, t.work), 'utf8').replace(/^﻿/, '');
                const i = raw.indexOf('\n\n'); // strip ffmpeg's header block, keep cues
                const cues = i >= 0 ? raw.slice(i + 2) : raw.replace(/^WEBVTT[^\n]*\n?/, '');
                fs.writeFileSync(path.join(dir, t.vtt), VTT_HEAD + cues);
                try { fs.unlinkSync(path.join(dir, t.work)); } catch (e) {}
                writePl(t.pl, t.vtt, true); // same URI, now VOD + ENDLIST
              } catch (e) {}
            }
          }
          pump(); // free slot → start the next extractor
        });
        subProcs.push(ff);
      }
    };
    pump();
    return tasks.map((t) => ({ vtt: t.vtt, pl: t.pl, lang: t.lang, name: t.name, url: `http://${lan}:${port}/hls/${token}/${t.vtt}` }));
  }

  // Build/patch the master playlist so it carries the subtitle renditions, making them a
  // selectable Legible group in AVPlayer (AirPlay) and a TEXT track on the cast receiver.
  //   • multi-audio: ffmpeg already wrote master.m3u8 → inject EXT-X-MEDIA:SUBTITLES lines and
  //     tag every EXT-X-STREAM-INF with SUBTITLES="subs".
  //   • single-audio: ffmpeg only wrote the media playlist (index.m3u8) → wrap it in a fresh
  //     master that references it as the one variant plus the subtitle group.
  // Returns the master playlist filename to hand back to the caller.
  function buildMaster(dir, playlist, multi, subEntries) {
    // AUTOSELECT=NO (and DEFAULT=NO): AVPlayer must NOT auto-pick any subtitle rendition on load —
    // with many tracks (forced/SDH) it would otherwise auto-load one whose sidecar may still be a
    // slow stub and stall playback. The user explicitly selecting a track still works regardless.
    // NOTE: deliberately NO RESOLUTION/FRAME-RATE/VIDEO-RANGE attrs — adding them (A6) broke AirPlay (a
    // RESOLUTION that didn't match the scaled output, or VIDEO-RANGE=PQ without CODECS, made AVPlayer
    // reject the master). The proven master is just BANDWIDTH + SUBTITLES. (reverted A6)
    const media = subEntries.map((e) =>
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${(e.name || e.lang).replace(/"/g, '')}",` +
      `LANGUAGE="${e.lang}",AUTOSELECT=NO,DEFAULT=NO,URI="${e.pl}"`).join('\n');
    const masterPath = path.join(dir, 'master.m3u8');
    try {
      if (multi) {
        const lines = fs.readFileSync(masterPath, 'utf8').replace(/^﻿/, '').split('\n'); // strip BOM
        if (lines.some((l) => /GROUP-ID="subs"/.test(l))) return 'master.m3u8'; // already patched → idempotent
        const out = [];
        for (const ln of lines) {
          if (/^#EXT-X-STREAM-INF:/.test(ln) && !/SUBTITLES=/.test(ln)) out.push(ln + ',SUBTITLES="subs"');
          else out.push(ln);
        }
        // insert the subtitle renditions after the header (after #EXT-X-VERSION if present,
        // else after #EXTM3U) so strict parsers still see VERSION early.
        let hi = out.findIndex((l) => /^#EXT-X-VERSION/.test(l));
        if (hi < 0) hi = out.findIndex((l) => /^#EXTM3U/.test(l));
        out.splice(hi < 0 ? 0 : hi + 1, 0, media);
        fs.writeFileSync(masterPath, out.join('\n'));
        return 'master.m3u8';
      }
      fs.writeFileSync(masterPath,
        `#EXTM3U\n#EXT-X-VERSION:6\n${media}\n` +
        `#EXT-X-STREAM-INF:BANDWIDTH=4000000,SUBTITLES="subs"\n${playlist}\n`);
      return 'master.m3u8';
    } catch (e) { return playlist; } // patch failed → fall back to the plain playlist
  }

  // Probe audio + text-subtitle tracks (bounded read so a torrent's header is enough, no stall).
  function probeTracks(input, cb) {
    let out = '';
    // 4M/5s: a standard MKV front-loads all track headers, so this still sees every audio/sub
    // stream + the video codec, but resolves in ~1–3s instead of stalling toward a 12s timeout
    // (which delayed the cast button). Inconclusive probe → vcodec null → serveHls proceeds anyway.
    const ps = spawn(FFPROBE, ['-v', 'error', '-probesize', '4M', '-analyzeduration', '4M',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,color_transfer,channels,channel_layout:stream_tags=language,title:format=duration', '-of', 'json', input],
      { timeout: 5000 });
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => cb(null));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const streams = parsed.streams || [];
        const dur = parseFloat(parsed.format && parsed.format.duration) || 0;
        const audio = [], subs = []; let aN = 0, sN = 0, vcodec = null, width = 0, height = 0, hdr = false, fps = 0;
        const langCount = {}; // disambiguate duplicate languages in the menu (eng, eng → "English 2")
        for (const s of streams) {
          const tg = s.tags || {}, lang = tg.language || 'und';
          if (s.codec_type === 'video' && !vcodec) {
            vcodec = s.codec_name || null; width = +s.width || 0; height = +s.height || 0;
            const fr = /^(\d+)\/(\d+)$/.exec(s.r_frame_rate || ''); // "24000/1001" → 23.976
            fps = fr && +fr[2] ? (+fr[1] / +fr[2]) : (parseFloat(s.r_frame_rate) || 0);
            hdr = /smpte2084|arib-std-b67/i.test(s.color_transfer || ''); // HDR10/HLG (DoVi base layer reports PQ too)
          } else if (s.codec_type === 'audio') {
            langCount[lang] = (langCount[lang] || 0) + 1;
            const name = tg.title || (lang === 'und' ? 'Audio ' + (aN + 1) : lang.toUpperCase()) + (langCount[lang] > 1 ? ' ' + langCount[lang] : '');
            audio.push({ idx: aN, lang, name, codec: (s.codec_name || '').toLowerCase(), channels: +s.channels || 2 }); aN++;
          } else if (s.codec_type === 'subtitle') {
            const bitmap = /pgs|hdmv|dvd_sub|dvdsub|dvb_sub|xsub/i.test(s.codec_name || '');
            if (/subrip|srt|ass|ssa|mov_text|webvtt|text/i.test(s.codec_name || '')) subs.push({ idx: sN, lang, name: tg.title || (lang === 'und' ? 'Subtitle ' + (sN + 1) : lang.toUpperCase()) });
            else if (bitmap) subs.push({ idx: sN, lang, name: tg.title || lang.toUpperCase(), bitmap: true }); // tracked but only renderable via DLNA/burn-in
            sN++; // count ALL subtitle streams so idx maps to 0:s:<idx> correctly
          }
        }
        cb({ audio, subs, vcodec, dur, width, height, hdr, fps });
      } catch (e) { cb(null); }
    });
  }
  const cleanName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'Track';

  // Live HLS remux/transcode. AVPlayer plays HLS natively, so this casts MKV/AVI/TS releases AND
  // streams as a torrent downloads. Builds a MULTI-rendition master (all audio languages + text subs
  // as selectable renditions) when probing succeeds, else a simple single-audio playlist.
  //
  // opts = { caps, extraSubs }:
  //   • caps — receiver capability profile (normCaps). A capability-confirmed TV (LG NANO80T6A /
  //     webOS-24 / Cast-built-in) COPIES 4K HEVC + HDR10 and passes AC3/EAC3 through losslessly;
  //     an unknown receiver downscales to 1080p + AAC. (Capability-negotiated; see cast.js.)
  //   • extraSubs — [{path,lang,name}] external .srt/.ass files to convert + attach as renditions.
  // cb(masterOrIndex m3u8 LAN url, subTracks).
  function serveHls(input, cb, opts) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    const caps = normCaps(opts && opts.caps);
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    ensure(() => {
      cancelHls(); cancelRemux();
      const myToken = hlsToken = newToken();
      hlsDir = path.join(HLS_DIR, hlsToken);
      try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (e) {}
      probeTracks(input, (info) => {
        // Bail if a newer serveHls superseded us while probing. Comparing the captured token (not
        // `== null`) is essential — a second call sets a NEW non-null token, and proceeding here
        // would spawn orphan ffmpegs into the new session's dir.
        if (hlsToken !== myToken) return cb(null);
        // Subtitles → WebVTT sidecars (embedded text tracks + external files), wrapped in subtitle
        // media playlists and attached to the master as a SUBTITLES rendition group (buildMaster) so
        // AVPlayer (AirPlay) exposes a Legible group and the cast receiver a TEXT track — both
        // selectable mid-cast. Bitmap subs (PGS/VOBSUB) can't become WebVTT and the bundled ffmpeg
        // has no libass → they're skipped here (use the DLNA route, where the TV renders them).
        const embeddedTextSubs = (info && info.subs ? info.subs.filter((s) => !s.bitmap) : []);
        const allSubSources = embeddedTextSubs.map((s) => ({ idx: s.idx, lang: s.lang, name: s.name }))
          .concat(extraSubs.map((s, i) => ({ path: s.path, lang: s.lang || 'und', name: s.name || ('Subtitle ' + (embeddedTextSubs.length + i + 1)) })));
        // Subtitle sidecars are extracted only once a video launch SUCCEEDS (see succeed()), not up
        // front — so a hw→sw fallback that wipes+recreates the dir can't orphan extractor ffmpegs or
        // leave the master pointing at deleted stubs. (Audit H1/M8.)
        let subEntries = [], subTracks = [];
        const multi = !!(info && info.audio.length > 1);

        // ---- video copy-vs-transcode decision (capability-negotiated) ----
        const tooTall = !!(info && info.height > 1088);
        const isHevc = !!(info && info.vcodec === 'hevc');
        const isH264 = !!(info && info.vcodec === 'h264');
        // Can we COPY the video losslessly to THIS receiver? VP9/AV1/Xvid/VC-1/WMV are never
        // muxable into fMP4 → always transcode on this path (use DLNA for native passthrough).
        let canCopyVideo = false;
        if (info && info.vcodec) {
          if (isHevc) canCopyVideo = caps.hevc && (tooTall ? caps.hevc4k : true);
          else if (isH264) canCopyVideo = tooTall ? caps.h264_4k : true;
        }
        // HDR can only be copied to a receiver that does HDR10; otherwise it must be transcoded
        // (tonemapped) to SDR or it shows up washed-out/too-dark.
        if (info && info.hdr && !caps.hdr10) canCopyVideo = false;
        // info==null (inconclusive probe, e.g. a just-started torrent): assume copy; the software
        // fallback below rescues us if the real codec turns out to be uncopyable (VP9/AV1).
        const transcode = !!(info && info.vcodec) && !canCopyVideo;

        const inOpts = /^https?:\/\//i.test(input)
          ? ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '30000000']
          : [];
        const hlsOpts = ['-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_list_size', '0',
          '-hls_playlist_type', 'event', '-hls_flags', 'append_list+omit_endlist', '-hls_fmp4_init_filename', 'init.mp4'];

        // Per-audio-stream codec: COPY a passthrough-capable codec (AAC/AC3/EAC3 → surround intact),
        // else encode to AAC PRESERVING the channel layout (no forced -ac 2 stereo downmix). bitrate
        // scales with channel count so 5.1/7.1 isn't starved.
        function audioArgs() {
          if (!info || !info.audio.length) return ['-c:a', 'aac'];
          const out = [];
          info.audio.forEach((a, i) => {
            if (caps.audioCopy.has(a.codec)) out.push(`-c:a:${i}`, 'copy');
            else out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.channels > 2 ? '384k' : '160k');
          });
          return out;
        }

        // Build the video args for a given encoder MODE: 'copy' (primary, when allowed), 'hw'
        // (videotoolbox transcode), or 'sw' (libx264/libx265 — the fallback that always works,
        // and the path that can decode VP9/AV1/Xvid the hardware-copy can't).
        function videoArgs(mode) {
          // HDR10 output is HEVC, so keep it ONLY if the receiver displays HDR10 AND decodes HEVC.
          // A receiver that does HDR10 but is H.264-only (a plain Cast dongle: hdr10=true, hevc=false)
          // must get H.264 — otherwise it gets an undecodable HEVC stream with no fallback. (Audit H5.)
          const hdr = !!(info && info.hdr && caps.hdr10 && caps.hevc);
          // Downscale only ABOVE the receiver's max height, and scale TO that height — a 4K-capable
          // receiver (maxHeight 2160) keeps 4K instead of being forced to 1080p. (Audit M9.)
          const cap = caps.maxHeight || 1080;
          const needScale = !!(info && info.height && info.height > cap);
          const scaleExpr = 'scale=-2:' + cap;
          const scale = needScale ? ['-vf', scaleExpr] : [];
          if (mode === 'copy') return ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])];
          if (hdr) { // HDR10 (HEVC) — hardware or software
            const enc = mode === 'sw' ? ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20'] : ['-c:v', 'hevc_videotoolbox', '-prio_speed', '1', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '20M'];
            return [...scale, ...enc, '-tag:v', 'hvc1', '-pix_fmt', 'p010le',
              '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv'];
          }
          // SDR output (incl. HDR→SDR when the receiver can't take HDR10 OR can't decode HEVC). Proper
          // tonemap needs zscale; without it (shipped build) fall back to a plain scale — slightly
          // washed-out but watchable and, crucially, DECODABLE H.264.
          const needTonemap = !!(info && info.hdr && !(caps.hdr10 && caps.hevc));
          const vf = needTonemap && CAN_TONEMAP
            ? ['-vf', (needScale ? scaleExpr + ',' : '') + 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p']
            : scale;
          // AirPlay 1080p H.264 bitrate (AP1): bumped 8M/12M → 16M/24M. The receiver is capped at H.264/SDR
          // 1080p (4K/HDR over AirPlay-2 to this LG doesn't play), so resolution can't improve — bitrate is
          // the only quality lever, and 8 Mbit/s was visibly soft on a large panel. Quantizer-only change
          // (same codec/profile/container/handoff) so it can't trigger the "enters AirPlay, never plays".
          const enc = mode === 'sw' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'h264_videotoolbox', '-prio_speed', '1', '-b:v', '16M', '-maxrate', '24M', '-bufsize', '32M'];
          return [...vf, ...enc, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
        }

        function buildArgs(mode) {
          const vArgs = videoArgs(mode), aArgs = audioArgs();
          if (multi) {
            const args = ['-loglevel', 'error', '-y', ...inOpts, '-i', input, '-map', '0:v:0'];
            info.audio.forEach((a) => args.push('-map', '0:a:' + a.idx));
            args.push(...vArgs, ...aArgs, ...hlsOpts);
            const vm = ['v:0,agroup:aud'];
            info.audio.forEach((a, i) => vm.push(`a:${i},agroup:aud,language:${a.lang}` + (i === 0 ? ',default:yes' : '')));
            args.push('-var_stream_map', vm.join(' '), '-f', 'hls', '-master_pl_name', 'master.m3u8',
              '-hls_segment_filename', path.join(hlsDir, 'stream_%v/seg%05d.m4s'), path.join(hlsDir, 'stream_%v/index.m3u8'));
            return args;
          }
          // single audio. EXPLICIT maps so ffmpeg doesn't also segment a subtitle stream as junk
          // per-segment WebVTT (we carry subs via sidecar renditions). NO -ac 2 → channel layout survives.
          return ['-loglevel', 'error', '-y', ...inOpts, '-i', input, '-map', '0:v:0', '-map', '0:a:0',
            ...vArgs, ...aArgs, ...hlsOpts, '-f', 'hls',
            '-hls_segment_filename', path.join(hlsDir, 'seg%05d.m4s'), path.join(hlsDir, 'index.m3u8')];
        }

        const playlist = multi ? 'master.m3u8' : 'index.m3u8';
        const myDir = hlsDir, tok = myToken, m3u8 = path.join(myDir, playlist);
        const primaryMode = transcode ? 'hw' : 'copy';
        let settled = false, triedFallback = false;
        startHlsWatch(myDir);

        const ready = () => countSegs(myDir) > 0 && safeStat(m3u8); // ≥1 fMP4 segment AND the playlist

        // Spawn ffmpeg for a mode and watch for readiness. On a failure BEFORE the stream is ready
        // (videotoolbox session error, or an uncopyable codec the primary tried to copy), retry ONCE
        // with the software transcoder — which both fixes hardware hiccups AND decodes VP9/AV1/Xvid.
        // Every failure/wedge path routes through fail() so the caller ALWAYS gets a cb (never hangs).
        function launch(mode) {
          const ff = hlsProc = spawn(FFMPEG, buildArgs(mode));
          let lastSegs = 0, lastProgressAt = Date.now();
          const succeed = () => {
            settled = true; clearInterval(tick);
            // Dir is now stable (no further fallback wipes) → safe to spawn the subtitle extractors. (H1/M8)
            if (allSubSources.length) {
              subEntries = extractSubs(input, allSubSources, lan, tok, (info && info.dur) || 0, myDir);
              subTracks = subEntries.map((e) => ({ url: e.url, lang: e.lang, name: e.name }));
            }
            // Wrap a master only when there are subtitle renditions to carry (single-audio no-subs serves the
            // bare media playlist, like the proven build). (reverted A6 always-wrap.)
            const finalPl = subEntries.length ? buildMaster(myDir, playlist, multi, subEntries) : playlist;
            cb(`http://${lan}:${port}/hls/${tok}/${finalPl}`, subTracks);
          };
          const fail = () => {
            if (settled || hlsToken !== tok) return;
            clearInterval(tick);
            if (!triedFallback && mode !== 'sw') { // retry once via the always-works software encoder
              triedFallback = true;
              try { if (ff === hlsProc && hlsProc) hlsProc.kill('SIGKILL'); } catch (e) {}
              try { fs.rmSync(myDir, { recursive: true, force: true }); fs.mkdirSync(myDir, { recursive: true }); } catch (e) {}
              launch('sw');
            } else { settled = true; cancelHls(); cb(null); }
          };
          const tick = setInterval(() => {
            if (settled) { clearInterval(tick); return; }
            if (hlsToken !== tok) { clearInterval(tick); return; } // superseded → caller already got cb(null)
            let segs = 0; try { segs = countSegs(myDir); } catch (e) {}
            if (segs > lastSegs) { lastSegs = segs; lastProgressAt = Date.now(); }
            if (segs > 0 && safeStat(m3u8)) succeed();
            else if (Date.now() - lastProgressAt > 25000) fail(); // genuinely wedged (no new segment for 25s)
          }, 250);
          ff.stderr.on('data', () => {});
          // A SUPERSEDED process (e.g. the hw ffmpeg SIGKILLed when launching the sw fallback) must NOT
          // re-enter fail()/cancelHls() — that would tear down the brand-new process. Gate on the event
          // belonging to the CURRENT hlsProc. Without this, the fallback kills itself. (Audit H1.)
          ff.on('error', () => { if (ff !== hlsProc) return; hlsProc = null; if (!settled) fail(); });
          ff.on('close', () => {
            if (ff !== hlsProc) return; // superseded process → its lifecycle is no longer ours
            hlsProc = null;
            if (settled || hlsToken !== tok) return;
            // ffmpeg exited before we observed readiness. If it actually finished writing (a short
            // clip), the segments exist → let the next tick settle it; otherwise it failed → fail().
            try { if (ready()) return; } catch (e) {}
            fail();
          });
        }
        launch(primaryMode);
      });
    });
  }

  // ---- Chromecast transport: ONE progressive Matroska stream over a single HTTP GET ----
  // This is the proven-reliable progressive Cast path (vs the fragile live-EVENT-fMP4-HLS that
  // Spritz fed the receiver before). The LG webOS receiver demuxes raw MKV natively (the same reason
  // DLNA-4K works), and a single continuous stream has no playlist/segment/ENDLIST state machine to
  // fail. One video (-c:v copy for castable H.264/HEVC, else videotoolbox transcode) + EXACTLY ONE
  // audio track (language switch = re-cast with a new audioTrack); subtitles are sideloaded separately
  // as WebVTT TEXT tracks (cast.js), not muxed in. Non-seekable pipe → the renderer re-casts on seek.
  const MKV_CONTAINER = 'matroska', MKV_MIME = 'video/x-matroska'; // swap to mp4(frag)+video/mp4 if a receiver rejects MKV
  function cancelMkv() {
    if (mkvProc) { try { mkvProc.kill('SIGKILL'); } catch (e) {} mkvProc = null; }
    // Drop the on-demand WebVTT temp files this cast extracted (superseded /sub/ tokens already 404);
    // otherwise they accumulate under REMUX_DIR/subs across a long session of seeks/sub toggles.
    if (mkvEntry && mkvEntry.subCache) for (const f of Object.values(mkvEntry.subCache)) { try { fs.unlinkSync(f); } catch (e) {} }
    mkvEntry = null;
  }
  // Build the single-stream ffmpeg args. info from probeTracks; reuses the capability-negotiated
  // copy-vs-transcode decision (so a 4K-capable LG copies, an old dongle transcodes to 1080p H.264).
  function mkvArgs(input, info, capsRaw, audioTrack, startSec, burnSub, swEncode) {
    const caps = normCaps(capsRaw);
    const tooTall = !!(info && info.height > 1088);
    const isHevc = !!(info && info.vcodec === 'hevc');
    const isH264 = !!(info && info.vcodec === 'h264');
    let canCopyV = false;
    if (info && info.vcodec) {
      if (isHevc) canCopyV = caps.hevc && (tooTall ? caps.hevc4k : true);
      else if (isH264) canCopyV = tooTall ? caps.h264_4k : true;
    }
    if (info && info.hdr && !caps.hdr10) canCopyV = false;
    const cap = caps.maxHeight || 1080;
    const needScale = !!(info && info.height && info.height > cap);
    const a = info && info.audio && info.audio[audioTrack];
    const aArgs = (a && caps.audioCopy.has(a.codec)) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', (a && a.channels > 2) ? '384k' : '160k'];
    // Video ENCODER for the transcode/burn-in paths: hardware videotoolbox normally, software libx264 as
    // the fallback when a videotoolbox encode of an exotic source (VP9/AV1/VC-1) fails to emit any output.
    const vEnc = swEncode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high']
      : ['-c:v', 'h264_videotoolbox', '-prio_speed', '1', '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
    const inOpts = /^https?:\/\//i.test(input)
      ? ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '30000000']
      : [];
    // Resume/seek: input-seek with -copyts so video PTS stays file-absolute and aligns with the
    // sideloaded WebVTT (whose cue times are also file-absolute). Position 0 → no seek (cleanest).
    const seek = startSec > 0 ? ['-ss', String(Math.floor(startSec)), '-copyts'] : [];
    if (burnSub != null && burnSub >= 0) {
      // BURN-IN a BITMAP subtitle (PGS/VOBSUB) into the video — image-based subs can't be sideloaded
      // as WebVTT, so the only way to show them on the Cast receiver is to composite them onto the
      // frames. Forces a videotoolbox re-encode (overlay is incompatible with -c:v copy).
      const fc = `[0:v:0][0:s:${burnSub}]overlay` + (needScale ? `,scale=-2:${cap}` : '') + '[vo]';
      return ['-hide_banner', '-nostdin', '-loglevel', 'error', ...seek, ...inOpts, '-i', input,
        '-filter_complex', fc, '-map', '[vo]', '-map', '0:a:' + audioTrack + '?',
        ...vEnc,
        ...aArgs, '-max_muxing_queue_size', '1024', '-f', MKV_CONTAINER, 'pipe:1'];
    }
    const vArgs = canCopyV
      ? ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])]
      : [...(needScale ? ['-vf', 'scale=-2:' + cap] : []), ...vEnc];
    return ['-hide_banner', '-nostdin', '-loglevel', 'error', ...seek, ...inOpts, '-i', input,
      '-map', '0:v:0', '-map', '0:a:' + audioTrack + '?', '-sn',
      ...vArgs, ...aArgs, '-max_muxing_queue_size', '1024', '-f', MKV_CONTAINER, 'pipe:1'];
  }
  // serveMkv(input, opts, cb) → cb(url, sideloadSubs, audioTracks, audioTrack, dur, menuSubs).
  // opts = {caps, audioTrack, startSec, extraSubs, burnSub}
  //   • sideloadSubs = TEXT subs (embedded + external) as on-demand WebVTT for cast.js to sideload.
  //   • menuSubs = the FULL subtitle menu: text subs (burn:false, id=castv2 trackId) AND bitmap subs
  //     (burn:true, subIdx) which the receiver can't sideload → shown via a burn-in re-cast.
  function serveMkv(input, opts, cb) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    const caps = (opts && opts.caps) || null;
    const startSec = (opts && opts.startSec) || 0;
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    const burnSub = (opts && opts.burnSub != null) ? opts.burnSub : null;
    const subDelay = (opts && opts.subDelay) || 0; // cast subtitle sync offset (seconds, +later/−earlier)
    ensure(() => {
      probeTracks(input, (info) => {
        const aN = (info && info.audio.length) || 0;
        let audioTrack = (opts && opts.audioTrack) || 0;
        if (audioTrack < 0 || audioTrack >= aN) audioTrack = 0;
        const token = newToken();
        cancelMkv();
        const audioTracks = (info && info.audio) ? info.audio.map((a) => ({ idx: a.idx, name: a.name, lang: a.lang })) : [];
        const dur = (info && info.dur) || 0;
        // Build the subtitle menu. TEXT subs → on-demand WebVTT (sideloaded, toggled instantly); BITMAP
        // subs (PGS/VOBSUB) can't become WebVTT → offered as burn-in (a re-cast composites them onto
        // the frames). External .srt → sideloaded text. The menu appears immediately (probe-driven).
        const subDefs = [];
        (info && info.subs ? info.subs : []).forEach((s) => {
          if (s.bitmap) subDefs.push({ kind: 'burn', ref: s.idx, lang: s.lang, label: s.name });
          else subDefs.push({ name: 'e' + s.idx, kind: 'embedded', ref: s.idx, lang: s.lang, label: s.name });
        });
        extraSubs.forEach((s, i) => subDefs.push({ name: 'x' + i, kind: 'external', ref: s.path, lang: s.lang || 'und', label: s.name || ('Subtitle ' + (subDefs.length + 1)) }));
        const sideloadSubs = [], menuSubs = []; let sideIdx = 0;
        subDefs.forEach((s) => {
          if (s.kind === 'burn') { menuSubs.push({ burn: true, subIdx: s.ref, name: s.label, lang: s.lang }); return; }
          sideloadSubs.push({ url: `http://${lan}:${port}/sub/${token}/${s.name}.vtt`, lang: s.lang, name: s.label });
          menuSubs.push({ burn: false, id: 1000 + sideIdx, name: s.label, lang: s.lang }); // cast.js assigns trackId 1000+i in this order
          sideIdx++;
        });
        // mkvEntry.subs = the on-demand-servable TEXT subs only (serveMkvSub looks them up by name).
        mkvEntry = { token, input, info, caps, audioTrack, startSec, burnSub, subDelay, subs: subDefs.filter((s) => s.kind !== 'burn'), subCache: {} };
        cb(`http://${lan}:${port}/mkv/${token}/video.mkv`, sideloadSubs, audioTracks, audioTrack, dur, menuSubs);
      });
    });
  }
  // On-demand WebVTT for a sideloaded MKV-cast subtitle. Extracts the one track to a temp file (cached),
  // then serves it via serveFile (range + CORS + text/vtt). The receiver fetches this only when the
  // user turns the subtitle on, so the cast itself never waits on subtitle extraction.
  function serveMkvSub(req, res, token, name) {
    if (!mkvEntry || mkvEntry.token !== token) { res.writeHead(404); res.end(); return; }
    const base = String(name).replace(/\.vtt$/i, '');
    const sub = mkvEntry.subs.find((s) => s.name === base);
    if (!sub) { res.writeHead(404); res.end(); return; }
    const cached = mkvEntry.subCache[base];
    if (cached && safeStat(cached)) return serveFile(req, res, cached);
    try { fs.mkdirSync(path.join(REMUX_DIR, 'subs'), { recursive: true }); } catch (e) {}
    const out = path.join(REMUX_DIR, 'subs', newToken() + '.vtt');
    const args = sub.kind === 'external'
      ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(sub.ref), '-i', sub.ref, '-c:s', 'webvtt', '-f', 'webvtt', out]
      : ['-loglevel', 'error', '-y', '-i', mkvEntry.input, '-map', '0:s:' + sub.ref, '-c:s', 'webvtt', '-f', 'webvtt', out];
    const ff = spawn(FFMPEG, args); ff.stderr.on('data', () => {});
    const fail = () => { try { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(); } catch (x) {} };
    ff.on('error', fail);
    ff.on('close', (code) => {
      if (!mkvEntry || mkvEntry.token !== token) { try { fs.unlinkSync(out); } catch (x) {} return fail(); } // superseded
      if (code === 0 && safeStat(out)) { shiftVtt(out, mkvEntry.subDelay); mkvEntry.subCache[base] = out; serveFile(req, res, out); } else fail();
    });
  }
  function serveMkvStream(req, res, token) {
    if (!mkvEntry || mkvEntry.token !== token) { res.writeHead(404); res.end(); return; }
    const e = mkvEntry;
    if (mkvProc) { try { mkvProc.kill('SIGKILL'); } catch (x) {} mkvProc = null; } // a fresh GET supersedes (receiver reconnect)
    res.writeHead(200, { 'Content-Type': MKV_MIME, 'Accept-Ranges': 'none', 'Cache-Control': 'no-cache', 'Connection': 'close' });
    if (req.method === 'HEAD') return res.end();
    let produced = false, triedSw = false;
    const onEnd = (ff) => {
      if (ff !== mkvProc) return;
      mkvProc = null;
      // The encoder died before emitting a single byte (e.g. a hardware videotoolbox transcode of an
      // exotic codec it can't handle) → retry ONCE with the software libx264 encoder, reusing the open
      // 200 (no body sent yet, so the receiver just keeps waiting on the same connection).
      if (!produced && !triedSw) { triedSw = true; return launch(true); }
      try { res.end(); } catch (x) {}
    };
    function launch(sw) {
      const ff = mkvProc = spawn(FFMPEG, mkvArgs(e.input, e.info, e.caps, e.audioTrack, e.startSec, e.burnSub, sw));
      ff.stderr.on('data', () => {});
      ff.stdout.on('error', () => {}); // EPIPE when the TV drops the socket — harmless
      ff.stdout.once('data', () => { produced = true; });
      ff.stdout.pipe(res, { end: false }); // keep res open across a hw→sw relaunch; pipe preserves backpressure
      ff.on('error', () => onEnd(ff));
      ff.on('close', () => onEnd(ff));
    }
    req.on('close', () => { if (mkvProc) { try { mkvProc.kill('SIGKILL'); } catch (x) {} mkvProc = null; } });
    launch(false);
  }

  // Remux `src` → a temp MP4 (video copied, audio→AAC if needed), then cb(absTempPath|null).
  // -c copy is fast (I/O-bound, no re-encode); we wait for completion so the served file
  // is complete + range-seekable (AVPlayer requires that).
  function remuxToTemp(src, transcodeAudio, cb) {
    cancelRemux();
    try { fs.mkdirSync(REMUX_DIR, { recursive: true }); } catch (e) {}
    const out = path.join(REMUX_DIR, newToken() + '.mp4');
    // Keep the source audio channel layout (no forced -ac 2) so 5.1/7.1 surround survives.
    const args = ['-loglevel', 'error', '-y', '-i', src, '-c:v', 'copy', '-c:a', transcodeAudio ? 'aac' : 'copy'];
    if (transcodeAudio) args.push('-b:a', '384k');
    args.push('-movflags', '+faststart', '-f', 'mp4', out); // faststart: moov up front → fast TV start
    remuxOut = out;
    const ff = remuxProc = spawn(FFMPEG, args);
    ff.stderr.on('data', () => {});
    ff.on('error', () => { remuxProc = null; try { fs.unlinkSync(out); } catch (e) {} cb(null); });
    ff.on('close', (code) => {
      if (ff !== remuxProc) { try { fs.unlinkSync(out); } catch (e) {} return; } // superseded → drop its orphan temp
      remuxProc = null;
      if (code === 0 && safeStat(out)) cb(out);
      else { try { fs.unlinkSync(out); } catch (e) {} remuxOut = null; cb(null); }
    });
  }

  // (Removed: setMasterDefaultAudio/setMasterDefaultSubtitle — the old AirPlay "rewrite the master
  // DEFAULT + reload" track-switch path. AirPlay now switches renditions via the native AVPlayer
  // AVMediaSelectionGroup (apAddon.selectMedia) and Chromecast via EDIT_TRACKS_INFO, so these are dead.)

  // Serve an external subtitle file for a DLNA cast as a sidecar the LG can sideload. webOS DLNA
  // loads SRT/SMI sidecars (advertised in the DIDL), so SRT is served as-is and ASS/SSA/VTT/SUB are
  // converted to UTF-8 SRT (charset-sniffed). cb(lanUrl|null). The DLNA route plays the original file
  // untouched, so EMBEDDED subs are already handled by the TV — this is only for external files.
  function serveSubtitleForDlna(filePath, cb) {
    if (!filePath) return cb(null);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.srt' || ext === '.smi') return serve(filePath, cb); // LG loads these directly
    try { fs.mkdirSync(REMUX_DIR, { recursive: true }); } catch (e) {}
    const out = path.join(REMUX_DIR, newToken() + '.srt');
    const ff = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(filePath), '-i', filePath, '-c:s', 'subrip', '-f', 'srt', out]);
    ff.stderr.on('data', () => {});
    ff.on('error', () => cb(null));
    ff.on('close', (code) => { if (code === 0 && safeStat(out)) serve(out, cb); else cb(null); });
  }

  // serve(absPath, cb) → cb(lanUrl|null) — direct file, range-supported (already compatible).
  function serve(absPath, cb) {
    const lan = lanAddress();
    if (!lan || !absPath) return cb(null);
    ensure(() => {
      const token = newToken(); files.set(token, absPath);
      cb(`http://${lan}:${port}/file/${token}/${encodeURIComponent(path.basename(absPath))}`);
    });
  }

  // prepareCast(input, isFile, cb, remuxAlt) → cb(lanUrl|null). Probes the source and returns a
  // TV-fetchable URL: direct serve if already compatible, else repackage. When `remuxAlt(input, cb)`
  // is given (the casting path passes serveHls), the repackage uses live HLS — its first segment is
  // ready in ~1–3s, so the cast button appears fast even for an MP4 whose audio needs transcoding
  // (e.g. a 4K movie with TrueHD/DTS). Without it (DLNA, which needs a finite MP4) it falls back to
  // a full remux-to-temp-MP4 (slow for big files). null if the VIDEO codec is unsupported.
  function prepareCast(input, isFile, cb, remuxAlt, opts) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    probe(input, (info) => {
      if (!info || !info.vcodec) return remuxAlt ? remuxAlt(input, cb) : cb(null); // inconclusive → let HLS try (it has the fallback)
      // VP9/AV1/Xvid/VC-1/WMV can't ride a direct MP4 → hand to the HLS path, which now transcodes
      // them (was: hard refuse). DLNA serves the original untouched, so the TV decodes them natively.
      if (!VIDEO_OK.has(info.vcodec)) return remuxAlt ? remuxAlt(input, cb) : cb(null);
      const ext = isFile ? path.extname(input).toLowerCase().replace('.', '') : (input.match(/\.(\w+)(\?|#|$)/) || [])[1];
      const compatContainer = ['mp4', 'm4v', 'mov'].includes(ext) || /\/webtorrent\//.test(input) && /\.(mp4|m4v|mov)/i.test(input);
      const compatAudio = !info.acodec || AUDIO_OK.has(info.acodec);
      if (compatContainer && compatAudio) {
        // Already castable as-is: direct file serve (+ sideloadable subs), or LAN-rewrite the torrent URL.
        const finishDirect = (url) => {
          if (!url) return cb(null);
          // Attach embedded text subs (local files) + any external .srt/.ass as standalone WebVTT the
          // cast receiver can sideload — direct-MP4 casts used to carry NO subtitles. Only when this is
          // an actual Chromecast handoff (directSubs) — AirPlay/AVPlayer reads MP4 subs itself, so the
          // pre-resolution skips the extraction.
          if (opts && opts.directSubs) prepareDirectSubs(input, isFile, extraSubs, (subs) => cb(url, subs));
          else cb(url);
        };
        if (isFile) return serve(input, finishDirect);
        const m = input.match(/^http:\/\/(?:localhost|127\.0\.0\.1)(:\d+)(\/.*)$/i);
        return finishDirect(m ? 'http://' + lan + m[1] + m[2] : null);
      }
      if (remuxAlt) return remuxAlt(input, cb); // fast: live HLS (first segment in seconds)
      // remux needed (foreign container and/or audio): -c:v copy (+ audio→AAC) to a temp
      // MP4, then serve that complete file via /file/ with range support.
      ensure(() => remuxToTemp(input, !compatAudio, (tempPath) => {
        if (!tempPath) return cb(null);
        serve(tempPath, cb);
      }));
    });
  }

  // Extract embedded text subtitle tracks (local file) + external .srt/.ass files to standalone
  // WebVTT served over /file/ (text/vtt), for SIDELOADING onto a direct-MP4 cast (cast.js → TEXT
  // tracks). cb([{url,lang,name}]). Torrent/remote input: skip embedded probe (would stall), but
  // still attach external files. Bitmap subs are skipped (no WebVTT path).
  function prepareDirectSubs(input, isFile, extraSubs, cb) {
    const dir = path.join(REMUX_DIR, 'subs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const run = (embedded) => {
      const sources = embedded.map((s) => ({ idx: s.idx, lang: s.lang, name: s.name }))
        .concat((extraSubs || []).map((s, i) => ({ path: s.path, lang: s.lang || 'und', name: s.name || ('Subtitle ' + (embedded.length + i + 1)) })));
      if (!sources.length) return cb([]);
      const out = []; let pending = sources.length;
      const settle = () => { if (--pending === 0) cb(out); };
      sources.forEach((s) => {
        const vtt = path.join(dir, newToken() + '.vtt');
        const ffArgs = s.path
          ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(s.path), '-i', s.path, '-c:s', 'webvtt', '-f', 'webvtt', vtt]
          : ['-loglevel', 'error', '-y', '-i', input, '-map', '0:s:' + s.idx, '-c:s', 'webvtt', '-f', 'webvtt', vtt];
        const ff = spawn(FFMPEG, ffArgs); ff.stderr.on('data', () => {});
        ff.on('error', settle);
        ff.on('close', (code) => {
          let ok = false; try { ok = code === 0 && fs.statSync(vtt).size > 12; } catch (e) {}
          if (ok) serve(vtt, (u) => { if (u) out.push({ url: u, lang: s.lang, name: s.name }); settle(); });
          else settle();
        });
      });
    };
    if (isFile) probeTracks(input, (info) => run(info && info.subs ? info.subs.filter((x) => !x.bitmap) : []));
    else run([]);
  }

  function teardown() {
    cancelRemux(); cancelHls(); cancelMkv();
    try { if (server) server.close(); } catch (e) {} server = null;
    files.clear(); dlnaProxies.clear(); // drop all token→path / proxy entries (were leaking until quit)
    try { fs.rmSync(REMUX_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(HLS_DIR, { recursive: true, force: true }); } catch (e) {} // drop temp remux/HLS
  }

  // Cancel any in-flight HLS remux + temp remux (without closing the server) — used when the source
  // changes or a torrent is cancelled, so an orphan ffmpeg isn't left reading a dead URL. Also prune
  // the per-source token Maps (they only grew until app-quit before): the previous source's /file/ and
  // /dlna/ URLs are dead now, and the next source re-registers its own afterwards. (Audit M7)
  function cancelActive() { cancelHls(); cancelRemux(); cancelMkv(); files.clear(); dlnaProxies.clear(); }

  return { serve, serveDlna, serveSubtitleForDlna, prepareCast, serveHls, serveMkv, teardown, cancelActive, lanAddress, avCompatible };
};

function safeStat(f) { try { const s = fs.statSync(f); return s.isFile() ? s : null; } catch (e) { return null; } }
// Shift every WebVTT cue timestamp (HH:MM:SS.mmm) by deltaSec (may be negative) — the cast subtitle
// sync control: a positive delta makes subs appear later, negative earlier. Rewrites the file in place.
function shiftVtt(file, deltaSec) {
  if (!deltaSec) return;
  try {
    const p2 = (n) => String(n).padStart(2, '0'), p3 = (n) => String(n).padStart(3, '0');
    const txt = fs.readFileSync(file, 'utf8').replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (m, h, mi, s, ms) => {
      let total = Math.round(((+h) * 3600 + (+mi) * 60 + (+s)) * 1000 + (+ms) + deltaSec * 1000);
      if (total < 0) total = 0;
      const msv = total % 1000; total = Math.floor(total / 1000);
      const ss = total % 60; total = Math.floor(total / 60);
      const mm = total % 60, hh = Math.floor(total / 60);
      return p2(hh) + ':' + p2(mm) + ':' + p2(ss) + '.' + p3(msv);
    });
    fs.writeFileSync(file, txt);
  } catch (e) {}
}
function countSegs(dir) { // count .m4s segments (recursively) — drives the HLS readiness/progress check
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countSegs(path.join(dir, e.name));
      else if (e.name.endsWith('.m4s')) n++;
    }
  } catch (e) {}
  return n;
}
