'use strict';

// The Spritz Receiver, as the application sees it.
//
// Everything below this is proven and hardware-tested (commit 18f46c9): ws-frame, receiver-protocol,
// receiver-hub, receiver-registry, receiver-session. This module CALLS them; it does not reimplement
// any part of them. In particular it does not decide whether to load media — `shouldLoad()` is the
// single authority for that, and this file's job at the critical moment is to hand it FACTS.
//
// What it owns:
//   - registry lifecycle (load at start, save on change, save at stop)
//   - hub lifecycle (attach once to lanserver's HTTP server, tear down cleanly)
//   - live session state, so the UI can show what each television is doing
//   - turning a playback plan into a LOAD, or deciding — via shouldLoad — not to
//
// What it deliberately does not own: media analysis, playlists, codecs, or where a film should
// start. Those arrive as inputs.

const { EventEmitter } = require('events');
const http = require('http');
const os = require('os');
const createReceiverHub = require('./receiver-hub');
const proto = require('./receiver-protocol');
const R = require('./receiver-registry');
const store = require('./receiver-store');
const targets = require('./receiver-targets');
const { shouldLoad } = require('./receiver-session');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// These facts describe one presentation and must become empty together. Keeping any of them after
// the receiver says it holds no media makes the public snapshot combine a current idle state with
// identity, timing or buffering facts from a presentation that no longer exists.
function clearPlayback(s) {
  Object.assign(s, {
    mediaId: null,
    epoch: null,
    currentTime: null,
    durationSec: null,
    paused: null,
    bufferedUntil: null,
    flags: [], tracks: null, trackMediaId: null, trackEpoch: null
  });
}

// The well-known port a television probes to find Spritz.
//
// lanserver listens on an EPHEMERAL port by design, which a receiver sweeping the LAN cannot guess.
// So one small fixed-port beacon answers "Spritz is here, and the control channel is on port N", and
// everything real continues to happen on lanserver's port. The alternative — pinning lanserver to a
// fixed port — would change behaviour for every existing cast path to solve a problem only the
// receiver has.
//
// 7737 is CHOSEN, not inherited. The spike and tools/receiver-dev.js use 8099, and making that the
// protocol's permanent address would have meant the harness and the real application fighting for
// the same port on a developer's machine — the beacon would lose, log a line nobody reads, and
// discovery would silently stop working. It is also outside macOS's ephemeral range (49152-65535),
// so the kernel will not hand it to something else first, and it is not one of the common
// development ports (3000/5000/8000/8080/8099).
const BEACON_PORT = 7737;

function createReceiverService({ storePath, lan, onLog, now, beaconPort, onSelectTrack } = {}) {
  const clock = now || (() => Date.now());
  const log = (m) => { try { if (onLog) onLog('receiver: ' + m); } catch (e) {} };
  const ev = new EventEmitter();

  let registry = R.emptyRegistry();
  let storeWriteBlocked = false;
  let hub = null;
  let detach = null;         // unsubscribes from lanserver's server announcements
  let started = false;
  let attachedTo = null;     // the http.Server the hub is currently bound to
  let upgradeHandler = null; // our listener on that server, so stop() can remove it
  let beacon = null;         // the fixed-port discovery responder

  function detachUpgrade() {
    if (attachedTo && upgradeHandler) {
      try { attachedTo.removeListener('upgrade', upgradeHandler); } catch (e) {}
    }
    upgradeHandler = null;
    attachedTo = null;
  }

  // What each live connection is doing. Kept HERE rather than in the hub because it is application
  // state — the hub's job ends at "a trusted message arrived".
  const sessions = new Map();   // sessionId -> { receiverId, authenticated, state, mediaId, currentTime, ... }

  // What the application currently wants played, per receiver. This is the DESIRE; what the
  // television is actually doing is in `sessions`. Keeping them apart is what lets shouldLoad
  // compare the two instead of guessing.
  const desired = new Map();    // receiverId -> { mediaId, url, title, startSec }

  function persist() {
    if (!storePath || storeWriteBlocked) return;
    try {
      store.save(storePath, registry);
    } catch (e) {
      // A store that cannot be written is worth saying out loud: pairings made now will not survive
      // a restart. It is not worth stopping playback over.
      log('could not save the trust store — ' + e.message);
      ev.emit('error', { where: 'persist', message: e.message });
    }
  }

  const emitTargets = () => ev.emit('targets', list());

  function list() {
    // A stopped service has no targets. Reporting paired-but-offline receivers after stop would
    // leave a device list on screen that nothing can act on.
    if (!started) return [];
    const live = [];
    for (const [sessionId, s] of sessions) live.push(Object.assign({ sessionId, now: clock() }, s));
    return targets.targetsFrom({ registry, sessions: live });
  }

  function sessionFor(receiverId) {
    for (const [sessionId, s] of sessions) {
      if (s.receiverId === receiverId && s.authenticated) return { sessionId, s };
    }
    return null;
  }

  function start() {
    if (started) return;         // one hub, however many times the application asks
    started = true;

    const loaded = store.load(storePath);
    registry = loaded.registry;
    storeWriteBlocked = !!loaded.writeBlocked;
    if (storeWriteBlocked) log('trust store preserved in place; saving disabled — ' + loaded.error);
    if (loaded.corrupt) log('the trust store was unreadable and has been kept at ' + loaded.corrupt);
    const paired = R.listReceivers(registry).filter((r) => r.paired).length;
    log('started with ' + paired + ' paired receiver(s)');

    hub = createReceiverHub({ registry, onLog: (m) => log(m.replace(/^receiver: /, '')), onRegistryChange: persist });
    wire(hub);

    // Attach to whatever HTTP server lanserver has, now or later, and re-attach if it makes a new
    // one. See lanserver.onServer for why this is a subscription rather than a getter.
    if (lan && typeof lan.onServer === 'function') {
      const owner = hub;
      detach = lan.onServer((server) => {
        if (!started || hub !== owner || attachedTo === server) return;
        detachUpgrade();
        attachedTo = server;
        // This service owns replacement-server attachment and removes its wrapper on stop.
        // Preserve bytes already read by HTTP during upgrade: they may begin the first frame.
        upgradeHandler = (req, socket, head) => { try { hub.handleUpgrade(req, socket, head); } catch (e) { try { socket.destroy(); } catch (e2) {} } };
        server.on('upgrade', upgradeHandler);
        log('control channel attached to the LAN server');
      });
      // And BRING IT UP. lanserver listens lazily — only when something is cast — so at rest there
      // was no open port at all and a television sweeping the network found nothing. Found by
      // running the real application: the receiver is the one consumer that must be able to reach
      // Spritz BEFORE any media exists, because it connects out to us rather than being dialled.
      //
      // The consequence is deliberate and worth stating: Spritz now holds a LAN port open for as
      // long as it is running. That port serves tokenised media, the /spritz/hello identification,
      // and the authenticated control channel — nothing else, and nothing without either a token or
      // a paired credential.
      if (typeof lan.ensureServer === 'function') lan.ensureServer(() => {});
    }
    startBeacon();
    emitTargets();
  }

  // One question, one answer, nothing else. Every other path is refused: this is a beacon, not a
  // server, and it is reachable by anything on the network before any trust exists.
  function startBeacon() {
    if (beacon) return;
    const want = Number.isFinite(beaconPort) ? beaconPort : BEACON_PORT;
    const s = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' });
        return res.end();
      }
      if ((req.url || '').split('?')[0] !== '/spritz/hello') { res.writeHead(404); return res.end(); }
      // Refuse anything this does not serve, rather than quietly treating a POST as a GET. The
      // beacon is reachable by anything on the network before any trust exists, so the smaller and
      // more explicit its contract, the less there is to reason about later.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      const body = JSON.stringify({
        spritz: true,
        name: os.hostname().replace(/\.local$/, ''),
        protocol: 1,
        // Where the control channel actually is. Null until lanserver has listened, which a
        // receiver should treat as "not ready yet" rather than as an address.
        port: (lan && typeof lan.serverPort === 'function') ? lan.serverPort() : null
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    // A beacon that cannot bind must not stop Spritz: another instance may already hold the port,
    // and everything except discovery still works.
    s.on('error', (e) => { log('discovery beacon could not listen — ' + e.message); if (beacon === s) beacon = null; });
    // Recorded BEFORE listen completes, so that a stop() arriving in the same tick as start() —
    // the application quitting at once, or a caller that never yields — has something to close.
    // Recording it only in the listen callback left that stop() with nothing to do, after which the
    // callback installed a live listener on a service that had already stopped. Nothing ever closed
    // it: the process could not exit and the well-known port stayed taken.
    beacon = s;
    s.listen(want, '0.0.0.0', () => {
      if (beacon !== s) { try { s.close(); } catch (e) {} return; }   // stopped while binding
      log('discovery beacon on port ' + s.address().port);
    });
  }

  function ownsReport(s, msg) {
    const expected = desired.get(s.receiverId) || s;
    if (msg.mediaId != null && expected.mediaId && msg.mediaId !== expected.mediaId) return false;
    if (msg.epoch != null && expected.epoch != null && msg.epoch !== expected.epoch) return false;
    return true;
  }

  function wire(h) {
    h.on('pairing', (e) => {
      log(R.short(e.receiverId) + ' is showing a pairing code');
      ev.emit('pairing', targets.pendingFrom({ pending: h.pending() }));
    });
    h.on('paired', (e) => {
      // Pairing AUTHENTICATES the socket that asked — the hub sets it to AUTHENTICATED inside
      // confirmPairing — but it reports that as `paired`, not `authenticated`. Without this the
      // session stayed marked untrusted here and the television showed as "offline" in the device
      // list seconds after a successful pairing, and could not be played to. Seen in the real UI.
      const s = sessions.get(e.sessionId);
      if (s) Object.assign(s, { receiverId: e.receiverId, authenticated: true, since: clock() });
      log(R.short(e.receiverId) + ' paired');
      emitTargets();
      ev.emit('pairing', targets.pendingFrom({ pending: h.pending() }));
    });
    h.on('revoked', () => { emitTargets(); });

    h.on('connected', ({ sessionId }) => {
      sessions.set(sessionId, { receiverId: null, authenticated: false, state: 'idle', since: clock() });
    });

    h.on('authenticated', ({ sessionId, receiverId, receiver }) => {
      const s = sessions.get(sessionId) || {};
      sessions.set(sessionId, Object.assign(s, {
        receiverId, authenticated: true, since: clock(),
        name: (receiver && receiver.name) || null,
        version: (receiver && receiver.version) || null
      }));
      log(R.short(receiverId) + ' authenticated');
      emitTargets();
    });

    h.on('auth.failed', ({ sessionId, receiverId, reason }) => {
      const s = sessions.get(sessionId);
      if (s) { s.authenticated = false; s.receiverId = receiverId || s.receiverId; }
      log(R.short(receiverId) + ' authentication failed — ' + reason);
      emitTargets();
    });

    // THE critical seam. A receiver's greeting only reaches here once the hub has authenticated it.
    h.on('capabilities', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !s.authenticated) return;
      s.logicalTimeline = msg.reported && msg.reported.logicalTimeline === 1;
      s.profile = require('./device-profile').fromReceiver(msg.reported, s.receiverId);
      log(R.short(s.receiverId) + ' reported decoder profile: ' + s.profile.maxHeight + 'p, HEVC4K=' + s.profile.hevc4k);
    });

    h.on('hello', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !s.authenticated) return;
      // Record what the receiver says it is holding BEFORE deciding anything. This is knowledge
      // about the television, worth having even when the application has no plans for it — without
      // it, re-picking the film already on screen looked like "holding nothing" and restarted it.
      if (msg.playing && msg.playing.mediaId && (!desired.has(s.receiverId) || ownsReport(s, msg.playing))) {
        Object.assign(s, {
          mediaId: msg.playing.mediaId,
          epoch: msg.playing.epoch == null ? null : String(msg.playing.epoch),
          currentTime: Number.isFinite(msg.playing.currentTime) ? msg.playing.currentTime : null,
          state: msg.playing.state || s.state,
          at: clock()
        });
        emitTargets();
      }
      const want = desired.get(s.receiverId) || null;
      // shouldLoad decides. This function's contribution is facts: what the receiver says it is
      // holding (inside msg.playing) and what the application wants (mediaId). No policy here.
      const d = shouldLoad({ hello: msg, desired: want });
      if (d.load) {
        if (!want) {
          // Nothing the application wants yet — a receiver announcing itself after an app restart,
          // before anyone has chosen a film. Logged anyway: a support log that goes silent here
          // cannot answer "why did nothing happen when the TV reconnected?".
          log(R.short(s.receiverId) + ' connected with nothing requested' +
            (msg.playing && msg.playing.mediaId ? ' (it is holding ' + msg.playing.mediaId + ')' : ' (holding nothing)'));
          return;
        }
        log(R.short(s.receiverId) + ' load requested: ' + d.why + ', start=' + want.startSec.toFixed(1) + 's, autoplay=' + want.autoplay);
        if (!h.send(sessionId, proto.load(sessionId, { ...want, url: require('./hls-start-position').loadUrl(want.url, want.startSec - (want.timelineOrigin || 0)) }))) {
          log(R.short(s.receiverId) + ' reconnect load could not be sent; intent retained');
        }
        return;
      }
      if (d.adopt) {
        // Adopt the television's own reading rather than reconstructing one. This is the line that
        // stops a reconnect restarting a film — measured before it existed: healthy playback at
        // 5905.4s restarted at 7.8s.
        Object.assign(s, { state: d.adopt.state, mediaId: d.adopt.mediaId, epoch: d.adopt.epoch, currentTime: d.adopt.currentTime, at: clock() });
        log(R.short(s.receiverId) + ' adopted existing playback at ' +
          (d.adopt.currentTime == null ? 'an unknown position' : d.adopt.currentTime.toFixed(1) + 's'));
        emitTargets();
      }
    });

    h.on('tracks', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !ownsReport(s, msg)) return;
      const want = desired.get(s.receiverId);
      s.trackMediaId = msg.mediaId; s.trackEpoch = msg.epoch == null ? null : String(msg.epoch);
      s.tracks = want && want.audioCatalog ? { ...msg.tracks, audio: want.audioCatalog } : msg.tracks;
      log(R.short(s.receiverId) + ' tracks: audio=' + msg.tracks.audio.length + ', subtitles=' + msg.tracks.subtitles.length);
      const selected = msg.tracks.subtitles.find(t => t.selected);
      if (want && msg.mediaId === want.mediaId && (msg.epoch == null ? null : String(msg.epoch)) === want.epoch) {
        const observed = selected ? selected.id : 'off';
        // An older inventory must not overwrite a just-sent selection before its
        // acknowledgement; TV-local choices are authoritative after that point.
        if (!want.subtitleSelectionPending || observed === want.subtitleTrackId) {
          want.subtitleTrackId = observed; want.subtitleSelectionPending = false;
        }
      }
      if (selected) log(R.short(s.receiverId) + ' subtitle ' + selected.id + ': readyState=' + (selected.readyState == null ? 'unknown' : selected.readyState) + ', cues=' + (selected.cueCount == null ? 'unknown' : selected.cueCount));
      emitTargets();
    });

    h.on('select-track', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !s.authenticated || !ownsReport(s, msg)) return;
      Promise.resolve(command(s.receiverId, 'select-track', msg)).then(result => {
        if (!result || !result.ok) { log(R.short(s.receiverId) + ' track request failed: ' + (result && result.why || 'unknown')); ev.emit('track-request-error', { receiverId: s.receiverId, why: result && result.why || 'Track selection failed' }); }
      }).catch(() => ev.emit('track-request-error', { receiverId: s.receiverId, why: 'Track selection failed' }));
    });

    h.on('loaded', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !ownsReport(s, msg)) return;
      log(R.short(s.receiverId) + ' loaded media, duration ' +
        (Number.isFinite(msg.durationSec) ? Math.round(msg.durationSec) + 's' : 'unknown'));
      const mediaId = has(msg, 'mediaId') ? msg.mediaId : s.mediaId;
      const epoch = has(msg, 'epoch') ? (msg.epoch == null ? null : String(msg.epoch)) : (mediaId === s.mediaId ? s.epoch : null);
      const changed = s.mediaId !== mediaId || s.epoch !== epoch;
      if (changed) {
        s.currentTime = null; s.bufferedUntil = null;
        if (s.trackMediaId !== mediaId || s.trackEpoch !== epoch) s.tracks = null;
      }
      s.mediaId = mediaId; s.epoch = epoch;
      s.awaitingPlaybackClock = true;
      if (has(msg, 'durationSec')) s.durationSec = msg.durationSec;
      else if (changed) s.durationSec = null;
      s.at = clock();
      emitTargets();
    });

    h.on('state', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !ownsReport(s, msg)) return;
      // A state that names no media, arriving while this session holds none, is not about
      // playback. Seen on hardware: after a fatal decode error the dead video element still fires
      // a trailing DOM `pause`, and the television reported "paused" with no media — which logged
      // a transition for a film that no longer exists. Nothing is learned from it; ignore it.
      if (!msg.mediaId && !s.mediaId) return;
      // Log TRANSITIONS, not every frame. A support log has to answer "did it actually play, and
      // where did it stop" without being a wall of position reports — and without the `stalled`
      // flag, which fires at every segment boundary on healthy playback and would drown the signal.
      if (s.state !== msg.state) {
        log(R.short(s.receiverId) + ' ' + msg.state +
          (Number.isFinite(s.currentTime) ? ' at ' + s.currentTime.toFixed(1) + 's' : ''));
      }
      s.state = msg.state;
      const want = desired.get(s.receiverId);
      if (want && msg.mediaId === want.mediaId &&
          (msg.epoch == null ? null : String(msg.epoch)) === want.epoch &&
          (msg.state === 'playing' || msg.state === 'paused')) {
        want.autoplay = msg.state === 'playing';
      }
      // `flags` (stalled, waiting) are recorded but are NOT the state. Measured on this hardware:
      // stalled fires at every segment boundary while the clock keeps perfect 1:1 time.
      s.flags = msg.flags || [];
      // This is an observation from the current authenticated receiver, not an inference from the
      // controller having sent Stop. The webOS receiver's Stop acknowledgement explicitly carries
      // mediaId:null and omits all the other playback fields, so that one fact invalidates the whole
      // presentation cache. It is intentionally the final presentation-field write: Stop can carry
      // stale waiting/stalled flags, and those belong to the discarded presentation too. An omitted
      // mediaId remains different; partial state reports do not assert that anything was unloaded.
      if (msg.state === 'idle' && has(msg, 'mediaId') && msg.mediaId === null) {
        clearPlayback(s); desired.delete(s.receiverId);
        ev.emit('playback-stopped', { receiverId: s.receiverId });
      }
      s.at = clock();
      emitTargets();
    });

    h.on('position', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId);
      if (!s || !ownsReport(s, msg)) return;
      if ((has(msg, 'mediaId') && msg.mediaId !== s.mediaId) || (has(msg, 'epoch') && msg.epoch !== s.epoch)) {
        for (const field of ['currentTime', 'durationSec', 'bufferedUntil']) if (!has(msg, field)) s[field] = null;
      }
      for (const field of ['mediaId', 'epoch', 'currentTime', 'durationSec', 'paused', 'bufferedUntil']) {
        if (has(msg, field)) s[field] = msg[field];
      }
      s.at = clock();
      // `epoch` and `currentTime` travel together: the time is EPOCH-LOCAL as the television counts
      // it, and only the epoch says how to turn it into film time (transport-epoch.js toLogical).
      // A page restart loses the TV's player. Retain its last confirmed position for the
      // replacement LOAD, in the same transport clock as the retained URL.
      if (Number.isInteger(msg.videoWidth) && Number.isInteger(msg.videoHeight) && msg.videoWidth > 0 && msg.videoHeight > 0) {
        const resolution = msg.videoWidth + 'x' + msg.videoHeight;
        if (s.decodedResolution !== resolution) {
          s.decodedResolution = resolution;
          log(R.short(s.receiverId) + ' decoded video: ' + resolution);
        }
      }
      const want = desired.get(s.receiverId);
      if (s.awaitingPlaybackClock && msg.seeking !== true && msg.mediaId === s.mediaId &&
          Number.isFinite(msg.currentTime) && typeof msg.paused === 'boolean') {
        s.awaitingPlaybackClock = false;
        log(R.short(s.receiverId) + ' first playback clock at ' + msg.currentTime.toFixed(1) +
          's, paused=' + msg.paused + ', epoch=' + (s.epoch == null ? 'none' : s.epoch));
      }
      if (want && msg.mediaId === want.mediaId &&
          (msg.epoch == null ? null : String(msg.epoch)) === want.epoch &&
          Number.isFinite(msg.currentTime) && msg.currentTime >= 0 && msg.seeking !== true &&
          (s.state === 'playing' || s.state === 'paused')) {
        want.startSec = msg.currentTime;
      }
      ev.emit('position', { receiverId: s.receiverId, mediaId: s.mediaId || null, epoch: s.epoch == null ? null : String(s.epoch),
        currentTime: msg.currentTime, durationSec: msg.durationSec, paused: msg.paused, seeking: msg.seeking, requestedTime: msg.requestedTime });
    });

    h.on('error', ({ sessionId, msg }) => {
      const s = sessions.get(sessionId) || {};
      if (!ownsReport(s, msg)) return;
      const reportedOwner = { mediaId: msg.mediaId == null ? s.mediaId : msg.mediaId,
        epoch: msg.epoch == null ? s.epoch : msg.epoch, identitySupplied: msg.mediaId != null || msg.epoch != null,
        mediaIdentitySupplied: msg.mediaId != null, epochIdentitySupplied: msg.epoch != null };
      log(R.short(s.receiverId) + ' reported a playback error ' + (msg.code || '?') + (msg.fatal ? ' (fatal)' : '') + ' — ' + (msg.message || ''));
      // A FATAL error means the receiver is no longer holding a playable film, whatever it last
      // said. Keeping the old claim makes choosing that film again do nothing at all: shouldLoad is
      // told the receiver already has it, and the viewer clicks into silence. Measured after
      // quitting Spritz mid-playback — "already holds this film — not reloading", twice, with a
      // blank television.
      //
      // NON-fatal errors are left alone deliberately: autoplay refusal arrives this way, and a film
      // sitting paused is still a film the receiver is holding.
      if (msg.fatal && s.receiverId) {
        clearPlayback(s); s.state = 'idle'; s.at = clock();
        emitTargets();
      }
      ev.emit('playback-error', Object.assign({ receiverId: s.receiverId, code: msg.code, message: msg.message, fatal: msg.fatal, ...(Number.isFinite(msg.requestedTime) && msg.requestedTime >= 0 ? { requestedTime: msg.requestedTime } : {}) }, reportedOwner));
    });

    h.on('disconnected', ({ sessionId, why }) => {
      const s = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (s && s.receiverId) log(R.short(s.receiverId) + ' disconnected — ' + why);
      emitTargets();
    });
  }

  // ---- what the application asks for ----------------------------------------------------------

  // Send a prepared playback plan to a receiver.
  //
  // `plan` is produced by Spritz's existing media analysis — this module does not inspect it beyond
  // the fields the protocol carries. `startSec` is a FACT (a resume point, or where local playback
  // had reached), not a policy: whether to load at all is shouldLoad's decision, taken against what
  // the receiver reports it is already holding.
  function play(receiverId, plan) {
    if (plan && plan.startSec != null && (!Number.isFinite(plan.startSec) || plan.startSec < 0)) return { ok: false, loaded: false, why: 'invalid start position' };
    if (!hub) return { ok: false, why: 'receiver service not started' };
    const found = sessionFor(receiverId);
    if (!found) return { ok: false, why: 'receiver is not connected' };
    const want = {
      mediaId: String(plan && plan.mediaId || ''),
      // Which transport of the film the URL is; null when the URL is not epoch-backed.
      epoch: plan && plan.epoch != null ? String(plan.epoch) : null,
      url: String(plan && plan.url || ''),
      ...(Array.isArray(plan && plan.subtitles) ? { subtitles: plan.subtitles.slice() } : {}),
      ...(Array.isArray(plan && plan.audioCatalog) ? { audioCatalog: plan.audioCatalog.slice(0, 32) } : {}),
      ...(plan && typeof plan.subtitleTrackId === 'string' ? { subtitleTrackId: plan.subtitleTrackId, subtitleSelectionPending: true } : {}),
      ...(plan && plan.timelineOrigin !== undefined ? { timelineOrigin: plan.timelineOrigin, sourceDuration: plan.sourceDuration } : {}),
      title: (plan && plan.title) || null,
      startSec: Number.isFinite(plan && plan.startSec) ? plan.startSec : 0,
      autoplay: !(plan && plan.autoplay === false)
    };
    if (!want.mediaId || !want.url) return { ok: false, why: 'a plan needs a mediaId and a url' };
    if (!proto.parse(proto.serialize(proto.load(found.sessionId, want))).ok) return { ok: false, why: 'invalid receiver playback plan' };
    desired.set(receiverId, want);

    // Ask the same authority the reconnect path asks, from the receiver's CURRENT state — so
    // choosing the film that is already playing does not restart it.
    const s = found.s;
    const hello = { role: 'receiver', playing: s.mediaId ? { mediaId: s.mediaId, epoch: s.epoch == null ? null : s.epoch, currentTime: s.currentTime, state: s.state } : null };
    const d = plan && plan.forceReload === true ? { load: true, why: 'explicit failed-replacement recovery' } : shouldLoad({ hello, desired: want });
    if (!d.load) {
      log(R.short(receiverId) + ' already holds this film — not reloading (' + d.why + ')');
      return { ok: true, loaded: false, why: d.why };
    }
    log(R.short(receiverId) + ' load requested: ' + d.why + ', start=' + want.startSec.toFixed(1) + 's, autoplay=' + want.autoplay);
    if (!hub.send(found.sessionId, proto.load(found.sessionId, { ...want, url: require('./hls-start-position').loadUrl(want.url, want.startSec - (want.timelineOrigin || 0)) }))) {
      log(R.short(receiverId) + ' load could not be sent; awaiting reconnection');
      return { ok: false, loaded: false, why: 'receiver load could not be sent' };
    }
    return { ok: true, loaded: true, why: d.why };
  }

  // Close a receiver's CONTROL socket, and nothing else. The television keeps its media connection,
  // notices, reconnects, and is judged by shouldLoad like any reconnect — which is the point: this
  // is the production lever for exercising the adopt-on-reconnect behaviour that used to need the
  // dev harness. The hub's drop does not touch media by design; see receiver-hub.js.
  function dropControl(receiverId) {
    if (!hub) return { ok: false, why: 'receiver service not started' };
    const found = sessionFor(receiverId);
    if (!found) return { ok: false, why: 'receiver is not connected' };
    log(R.short(receiverId) + ' control socket dropped on request');
    hub.drop(found.sessionId, 'dropped on request');
    return { ok: true };
  }

  function command(receiverId, what, arg) {
    if (what === 'seek' && (!Number.isFinite(arg) || arg < 0)) return { ok: false, why: 'invalid seek position' };
    if (!hub) return { ok: false, why: 'receiver service not started' };
    const found = sessionFor(receiverId);
    if (!found) return { ok: false, why: 'receiver is not connected' };
    const sid = found.sessionId;
    if (what === 'select-track') {
      log(R.short(receiverId) + ' track request: ' + (arg && arg.kind) + ' ' + String(arg && arg.trackId).slice(0, 32));
      if (!arg || arg.mediaId !== found.s.mediaId || (arg.epoch == null ? null : String(arg.epoch)) !== found.s.epoch) return { ok: false, why: 'track selection superseded' };
      const kind = arg.kind, trackId = String(arg.trackId);
      const items = found.s.tracks && found.s.tracks[kind === 'audio' ? 'audio' : 'subtitles'];
      if (!['audio', 'subtitle'].includes(kind) || !items || !(kind === 'subtitle' && trackId === 'off') && !items.some(t => t.id === trackId)) return { ok: false, why: 'track unavailable' };
      if (kind === 'audio' && trackId.startsWith('source-audio-')) {
        return typeof onSelectTrack === 'function' ? onSelectTrack(receiverId, arg) : { ok: false, why: 'Source audio selection unavailable' };
      }
      const ok = hub.send(sid, proto.envelope('select-track', sid, { mediaId: arg.mediaId, epoch: arg.epoch, kind, trackId }));
      const want = desired.get(receiverId);
      if (ok && kind === 'subtitle' && want && want.mediaId === arg.mediaId && want.epoch === (arg.epoch == null ? null : String(arg.epoch))) {
        want.subtitleTrackId = trackId; want.subtitleSelectionPending = true;
      }
      return { ok };
    }
    const msg = what === 'play' ? proto.play(sid)
      : what === 'pause' ? proto.pause(sid)
        : what === 'stop' ? proto.stop(sid)
          : what === 'seek' ? proto.seek(sid, { toSec: arg })
            : null;
    if (!msg) return { ok: false, why: 'unknown command ' + what };
    const want = desired.get(receiverId);
    if (want && (what === 'play' || what === 'pause')) want.autoplay = what === 'play';
    if (want && what === 'seek') want.startSec = arg;
    if (what === 'stop') {
      desired.delete(receiverId);
      // Release the media too. Measured: after a stop the television went idle and the live-HLS
      // ffmpeg kept transcoding for nobody until the next cast happened to cancel it. Pause is not
      // this — the film is still on screen and the session must stay.
      if (lan && typeof lan.cancelActive === 'function') { try { lan.cancelActive(); } catch (e) {} }
    }
    return { ok: hub.send(sid, msg) };
  }

  function confirmPairing(code) {
    if (!hub) return { ok: false, why: 'receiver service not started' };
    const r = hub.confirmPairing(code);
    emitTargets();
    ev.emit('pairing', targets.pendingFrom({ pending: hub.pending() }));
    return r;
  }

  function revoke(receiverId) {
    if (!hub) return { ok: false, why: 'receiver service not started' };
    const r = hub.revoke(receiverId);
    desired.delete(receiverId);
    emitTargets();
    return r;
  }

  function stop() {
    if (!started) return;
    started = false;
    try { if (detach) detach(); } catch (e) {}
    detach = null;
    detachUpgrade();
    try { if (beacon) beacon.close(); } catch (e) {}
    beacon = null;
    try { if (hub) hub.teardown(); } catch (e) {}
    hub = null;
    sessions.clear();
    desired.clear();
    // Written on the way out as well as on change: a pairing made moments before quit must not be
    // the one that gets lost.
    persist();
    log('stopped');
  }

  ev.start = start;
  ev.stop = stop;
  ev.play = play;
  ev.command = command;
  ev.dropControl = dropControl;
  ev.confirmPairing = confirmPairing;
  ev.revoke = revoke;
  ev.subtitleSelection = (id, mediaId, epoch) => {
    const want = desired.get(id);
    if (want && want.mediaId === mediaId && want.epoch === (epoch == null ? null : String(epoch)) && typeof want.subtitleTrackId === 'string') return want.subtitleTrackId;
    const live = sessionFor(id), s = live && live.s;
    if (!s || s.mediaId !== mediaId || s.epoch !== (epoch == null ? null : String(epoch))) return 'off';
    const selected = s.tracks && s.tracks.subtitles.find(t => t.selected);
    return selected ? selected.id : 'off';
  };
  ev.supportsLogicalTimeline = id => { const live = sessionFor(id); return !!(live && live.s.logicalTimeline); };
  ev.profile = (id) => { const live = sessionFor(id); return live ? live.s.profile || null : null; };
  ev.targets = list;
  ev.pending = () => (hub ? targets.pendingFrom({ pending: hub.pending() }) : []);
  ev.isStarted = () => started;
  ev.beaconPort = () => (beacon && beacon.listening ? beacon.address().port : 0);
  // Test and diagnostics only. The registry holds credentials; nothing should hand this to a
  // renderer or a log.
  ev._registry = () => registry;
  ev._lanForTest = () => lan;
  return ev;
}

module.exports = createReceiverService;
