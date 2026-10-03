'use strict';

// The Mac end of the receiver, for the first hardware round.
//
// A development harness, NOT production wiring. It stands up the two things the receiver needs — an
// HTTP server that serves media, and the control hub on the same port — and drives one film. Real
// integration goes through lanserver's serveVod and main.js's receiver selection, which is
// deliberately not touched yet: the VOD branch that owns those files is frozen pending AirPlay
// hardware, and mixing the two workstreams is exactly what the brief said not to do.
//
//   node tools/receiver-dev.js /path/to/film.mkv
//   node tools/receiver-dev.js --url http://host/existing/media.m3u8
//
// Everything it prints is the log for the hardware round: one line per control message, plus the
// position stream, so the Mac's view of the television can be compared against the television.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const createReceiverHub = require('../src/main/receiver-hub');
const proto = require('../src/main/receiver-protocol');
const { shouldLoad } = require('../src/main/receiver-session');
const R = require('../src/main/receiver-registry');

// The HARNESS keeps 8099, its historical port. Production discovery is on 7737 (see
// receiver-service's BEACON_PORT) precisely so the two can run at the same time on one machine
// without the real beacon losing the bind and disabling discovery silently.
const PORT = 8099;
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const externalUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
const input = args.find((a) => !a.startsWith('--') && a !== externalUrl);

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's';
const log = (...a) => console.log(stamp(), ...a);

function lanAddress() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal && /^en/.test(name)) return a.address;
    }
  }
  return null;
}

// Pre-segment the whole film in ONE -f hls stream-copy pass, letting ffmpeg choose the boundaries.
//
// This mirrors the preseg model the VOD work landed on, and it is not a stylistic choice: cutting
// segments independently gave every boundary an open-GOP lead-in, consecutive segments overlapped by
// up to 10.4s while the playlist declared no discontinuity, and the television livelocked after 130s
// with 15,107 aborted requests. ffmpeg owning the boundaries is the fix. Do not reintroduce
// per-segment cutting here for convenience.
function presegment(src, dir) {
  const t = Date.now();
  execFileSync(FFMPEG, [
    '-loglevel', 'error', '-y', '-copyts', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-avoid_negative_ts', 'disabled', '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, '%d.ts'),
    path.join(dir, 'media.m3u8')
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const n = fs.readFileSync(path.join(dir, 'media.m3u8'), 'utf8').split('\n').filter((l) => /\.ts$/.test(l.trim())).length;
  log('pre-segmented in ' + ((Date.now() - t) / 1000).toFixed(1) + 's — ' + n + ' segments');
  return n;
}

function durationOf(src) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString();
    return Math.round(parseFloat(out.trim()) || 0);
  } catch (e) { return 0; }
}

const lan = lanAddress();
if (!lan) { console.error('no LAN address'); process.exit(1); }

let dir = null, mediaUrl = externalUrl, dur = 0;
if (!externalUrl) {
  if (!input || !fs.existsSync(input)) {
    console.error('usage: node tools/receiver-dev.js /path/to/film.mkv  |  --url <media.m3u8>');
    process.exit(1);
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-receiver-'));
  dur = durationOf(input);
  presegment(input, dir);
  mediaUrl = 'http://' + lan + ':' + PORT + '/media/media.m3u8';
}

// CORS, per endpoint rather than blanket.
//
// The webOS application is a different origin from this server, so the media endpoints need an
// explicit allow or the <video> element's fetches fail with nothing useful in the log. What they do
// NOT need is write access or credentials, so the policy is read-only verbs and no
// Allow-Credentials. The control channel is a WebSocket, which is exempt from CORS entirely — which
// is precisely why it cannot be the access control, and why pairing is the next milestone.
const MEDIA_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type'
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, MEDIA_CORS); return res.end(); }

  // Harness control, so the Mac -> TV command direction can be exercised without a second machine.
  // LOOPBACK ONLY and deliberately not CORS-enabled: it drives a television, and the whole point of
  // the pairing milestone is that such a channel must not be open to the LAN. It is a harness
  // affordance; the real controller is main.js's receiver selection.
  const cm = /^\/control\/([a-z0-9_.-]+)(?:\?to=(\d+))?$/.exec(req.url || '');
  if (cm) {
    const from = String(req.socket.remoteAddress || '');
    if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(from)) { res.writeHead(403); return res.end('loopback only'); }
    const cmd = cm[1];

    // Pairing and revocation do not need a live playback session, and must work before one exists.
    if (cmd === 'pair') {
      const r = hub.confirmPairing(cm[2] || '');
      res.writeHead(r.ok ? 200 : 400);
      return res.end(r.ok ? 'paired ' + R.short(r.receiverId) : 'rejected: ' + r.why);
    }
    if (cmd === 'revoke') {
      const first = (hub.receivers().find((x) => x.paired) || {}).receiverId;
      const r = hub.revoke(first);
      res.writeHead(r.ok ? 200 : 404);
      return res.end(r.ok ? 'revoked ' + R.short(r.receiverId) : r.why);
    }
    if (cmd === 'receivers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ paired: hub.receivers(), pending: hub.pending() }, null, 2));
    }

    const sid = hub.sessions()[0];
    if (!sid) { res.writeHead(409); return res.end('no receiver connected'); }
    const at = view.currentTime || 0;
    const d = view.durationSec || dur || 0;
    let did = cmd;
    if (cmd === 'play') hub.send(sid, proto.play(sid));
    else if (cmd === 'pause') hub.send(sid, proto.pause(sid));
    else if (cmd === 'stop') hub.send(sid, proto.stop(sid));
    else if (cmd === 'back30') { did = 'seek ' + Math.max(0, at - 30).toFixed(0); hub.send(sid, proto.seek(sid, { toSec: Math.max(0, at - 30) })); }
    else if (cmd === 'fwd30') { did = 'seek ' + (at + 30).toFixed(0); hub.send(sid, proto.seek(sid, { toSec: at + 30 })); }
    else if (cmd === 'seek') { const to = Number(cm[2] || 0); did = 'seek ' + to; hub.send(sid, proto.seek(sid, { toSec: to })); }
    else if (cmd === 'start') { did = 'seek 5'; hub.send(sid, proto.seek(sid, { toSec: 5 })); }
    else if (cmd === 'middle') { did = 'seek ' + Math.round(d / 2); hub.send(sid, proto.seek(sid, { toSec: Math.round(d / 2) })); }
    else if (cmd === 'end') { did = 'seek ' + Math.round(Math.max(0, d - 90)); hub.send(sid, proto.seek(sid, { toSec: Math.max(0, d - 90) })); }
    // The Phase 8 property — a control outage must not disturb healthy playback — cannot be tested
    // by killing this process, because that would take the media server with it. This drops only
    // the socket.
    else if (cmd === 'drop') hub.drop(sid, 'dropped by harness for a reconnect test');
    else { res.writeHead(400); return res.end('unknown command'); }
    log('CONTROL -> ' + did);
    res.writeHead(200); return res.end(did);
  }

  const m = /^\/media\/([A-Za-z0-9_.-]+)$/.exec(req.url || '');
  if (!m || !dir) { res.writeHead(404, MEDIA_CORS); return res.end(); }
  const file = path.join(dir, m[1]);
  let st;
  try { st = fs.statSync(file); } catch (e) { res.writeHead(404, MEDIA_CORS); return res.end(); }
  const type = /\.m3u8$/.test(file) ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
  const range = req.headers.range;
  if (range) {
    const r = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = r[1] ? parseInt(r[1], 10) : 0;
    const end = r[2] ? parseInt(r[2], 10) : st.size - 1;
    res.writeHead(206, Object.assign({
      'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type
    }, MEDIA_CORS));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, Object.assign({ 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Content-Type': type }, MEDIA_CORS));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

// The trust store on disk.
//
// Mode 0600: it holds receiver credentials in the clear, for the reason receiver-registry's proofFor
// explains (challenge-response needs the key, not a hash of it). A world-readable file would hand
// every local account the ability to drive the television.
const STORE = process.env.SPRITZ_RECEIVER_STORE || path.join(os.homedir(), '.spritz-receivers.json');
function loadRegistry() {
  try {
    const raw = fs.readFileSync(STORE, 'utf8');
    const r = JSON.parse(raw);
    if (r && r.receivers) { r.pending = {}; return r; }   // pending never survives a restart
  } catch (e) { /* first run, or unreadable — start fresh rather than refusing to run */ }
  return R.emptyRegistry();
}
function saveRegistry(reg) {
  try {
    fs.writeFileSync(STORE, JSON.stringify({ version: reg.version, receivers: reg.receivers }, null, 2),
      { mode: 0o600 });
    fs.chmodSync(STORE, 0o600);
  } catch (e) { log('registry: could not save — ' + e.message); }
}

const registry = loadRegistry();
// A discovery beacon, so the television can find THIS harness the same way it finds production.
//
// The receiver app probes port 7737 for /spritz/hello and connects to whatever control port that
// names. Without one the harness is invisible to a receiver that has discovery — which it now does.
// Same shape as receiver-service's beacon; deliberately a copy rather than a shared module, because
// this is throwaway development tooling and production must not depend on it.
const beacon = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] !== '/spritz/hello') { res.writeHead(404); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }); return res.end(); }
  const body = JSON.stringify({ spritz: true, name: os.hostname().replace(/\.local$/, '') + ' (harness)', protocol: 1, port: PORT });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(req.method === 'HEAD' ? undefined : body);
});
beacon.on('error', (e) => log('beacon could not listen — ' + e.message));
beacon.listen(7737, '0.0.0.0', () => log('discovery beacon on 7737 -> control port ' + PORT));

const hub = createReceiverHub({ registry, onLog: (m) => log(m), onRegistryChange: saveRegistry });
hub.attach(server);
log('trust store ' + STORE + ' — ' + R.listReceivers(registry).filter((r) => r.paired).length + ' paired receiver(s)');

hub.on('pairing', (e) => log('PAIRING  ' + R.short(e.receiverId) + ' (' + (e.name || '?') + ') is showing a code on screen'));
hub.on('paired', (e) => log('PAIRED   ' + R.short(e.receiverId)));
hub.on('authenticated', (e) => log('AUTH OK  ' + R.short(e.receiverId)));
hub.on('auth.failed', (e) => log('AUTH BAD ' + R.short(e.receiverId) + ' — ' + e.reason));
hub.on('revoked', (e) => log('REVOKED  ' + R.short(e.receiverId)));

// The Mac's view of the television, kept from POSITION reports alone. Printed once a second so the
// hardware round can be checked against the screen: this line IS the acceptance criterion for
// "the Mac knows where the TV is".
let view = { state: 'idle', currentTime: null, durationSec: null, bufferedUntil: null, at: 0 };

hub.on('hello', (e) => {
  if (e.msg.role !== 'receiver') return;
  log('RECEIVER  ' + (e.msg.name || '?') + '  id=' + (e.msg.receiverId || '?') + '  platform=' + (e.msg.platform || '?'));
  // Never reload on sight. A receiver that reconnects still holding the film must keep it — see
  // receiver-session.js for the measurement that produced this rule.
  const d = shouldLoad({ hello: e.msg, desired: { mediaId: 'film-1' } });
  if (!d.load) {
    log('NO RELOAD — ' + d.why + (d.adopt ? '  adopting t=' + d.adopt.currentTime + 's state=' + d.adopt.state : ''));
    if (d.adopt) view = { state: d.adopt.state, currentTime: d.adopt.currentTime, durationSec: view.durationSec,
      bufferedUntil: null, at: Date.now(), paused: d.adopt.state === 'paused' };
    return;
  }
  log('LOAD -> ' + mediaUrl + '  (' + d.why + ')');
  hub.send(e.sessionId, proto.load(e.sessionId, {
    mediaId: 'film-1', url: mediaUrl, title: input ? path.basename(input) : 'Stream', startSec: 0, autoplay: true
  }));
});

hub.on('capabilities', (e) => log('CAPABILITIES (reported, NOT observed) ' + JSON.stringify(e.msg.reported)));
hub.on('ready', () => log('READY'));
hub.on('loaded', (e) => log('LOADED duration=' + e.msg.durationSec + 's' + (dur ? ' (source says ' + dur + 's)' : '')));
hub.on('state', (e) => {
  view.state = e.msg.state;
  log('STATE ' + e.msg.state + (e.msg.flags && e.msg.flags.length ? '  flags=[' + e.msg.flags.join(',') + ']' : ''));
});
hub.on('error', (e) => log('ERROR code=' + e.msg.code + ' fatal=' + e.msg.fatal + ' — ' + e.msg.message));
hub.on('position', (e) => {
  view = { state: view.state, currentTime: e.msg.currentTime, durationSec: e.msg.durationSec,
    bufferedUntil: e.msg.bufferedUntil, at: Date.now(), paused: e.msg.paused };
});
hub.on('disconnected', (e) => log('DISCONNECTED ' + e.why + (e.receiver ? ' (' + e.receiver.name + ')' : '')));

// Print the Mac's view once a second. Age matters as much as the value — a position that is five
// seconds stale is not knowledge, and showing it without the age would hide that.
setInterval(() => {
  if (!view.at) return;
  const age = ((Date.now() - view.at) / 1000).toFixed(1);
  log('MAC VIEW  ' + view.state.padEnd(9) +
    ' t=' + (view.currentTime == null ? '?' : view.currentTime.toFixed(1)) + 's' +
    '  buffered=' + (view.bufferedUntil == null ? '?' : view.bufferedUntil.toFixed(1)) + 's' +
    '  age=' + age + 's');
}, 1000);

server.listen(PORT, () => {
  console.log('');
  console.log('Spritz receiver harness   http://' + lan + ':' + PORT);
  console.log('control channel           ws://' + lan + ':' + PORT + hub.PATH);
  console.log('media                     ' + mediaUrl);
  console.log('');
  console.log('Launch the receiver on the TV. It connects out; nothing here dials the television.');
  console.log('');
});

process.on('SIGINT', () => {
  try { hub.teardown(); } catch (e) {}
  try { beacon.close(); } catch (e) {}
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  process.exit(0);
});
