'use strict';

// The Mac's side of the receiver control channel.
//
// The television connects OUT to this. There is deliberately no server on the TV: a TV-side server
// would have to be discovered, port-forwarded past whatever the platform allows, and kept alive
// while the app is backgrounded. A client socket dialling out has none of those problems, and it
// also means the Mac decides who may talk to it.
//
// This attaches to an EXISTING http.Server via its 'upgrade' event rather than opening a second
// listener, so the control channel lives on the same LAN port the media already uses. One port to
// reach, one address to discover.
//
// The hub owns transport and sessions. It knows nothing about media, playlists or codecs — that is
// lanserver's and the media engine's job — and nothing about webOS.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const wsf = require('./ws-frame');
const proto = require('./receiver-protocol');
const R = require('./receiver-registry');

const PATH = '/receiver';

// How long a receiver may say nothing at all before it is assumed gone. A television that has been
// unplugged does not close its TCP connection politely; without a liveness check the Mac holds a
// dead socket and believes a film is still playing on it.
const IDLE_TIMEOUT_MS = 30000;
const PING_INTERVAL_MS = 10000;
const MAX_CONNECTIONS = 16;
const MAX_QUEUED_BYTES = 1024 * 1024;

// A connection's authentication state, explicit rather than a boolean.
//
// A boolean would collapse the two states that behave differently before trust: a socket in PAIRING
// has a live challenge that must be cancelled if it goes away, and one merely UNAUTHENTICATED has
// nothing to clean up. REVOKED is distinct again — the credential was good and has been withdrawn,
// which is what a human reading a log needs to see rather than an undifferentiated failure.
const STATE = { UNAUTHENTICATED: 'UNAUTHENTICATED', PAIRING: 'PAIRING', AUTHENTICATED: 'AUTHENTICATED', REVOKED: 'REVOKED' };

function createReceiverHub({ onLog, registry, onRegistryChange, maxConnections = MAX_CONNECTIONS, maxQueuedBytes = MAX_QUEUED_BYTES } = {}) {
  // The caller owns persistence, exactly as device-memory.js does. The hub mutates the registry
  // object and calls back when something durable changed; it never touches a disk itself.
  const reg = registry || R.emptyRegistry();
  const saved = () => { try { if (onRegistryChange) onRegistryChange(reg); } catch (e) {} };
  const log = (m) => { try { if (onLog) onLog(m); } catch (e) {} };
  const hub = new EventEmitter();
  const attachedServers = new Set();
  const conns = new Map();   // sessionId -> conn

  function writeFrame(c, frame) {
    if (!c || c.dead) return false;
    if (frame.length > maxQueuedBytes || (c.socket.writableLength || 0) + frame.length > maxQueuedBytes) {
      drop(c.sessionId, 'write queue limit');
      return false;
    }
    try { c.socket.write(frame); return true; }
    catch (e) { drop(c.sessionId, 'write failed'); return false; }
  }
  function send(sessionId, msg) {
    const c = conns.get(sessionId);
    if (!c || c.dead) return false;
    // Outbound gate. Blocking only what a receiver may SAY would still let the controller hand a
    // media URL — the private thing this channel gives out — to an unauthenticated socket. A caller
    // bug must not become a disclosure.
    if (proto.POST_AUTH_ONLY.includes(msg && msg.type) && c.state !== STATE.AUTHENTICATED) {
      log('receiver: refused to send ' + msg.type + ' to unauthenticated session ' + sessionId.slice(0, 8));
      return false;
    }
    try {
      return writeFrame(c, wsf.encodeText(proto.serialize(msg)));
    } catch (e) {
      log('receiver: write failed on ' + sessionId + ' — ' + e.message);
      drop(sessionId, 'write failed');
      return false;
    }
  }

  function drop(sessionId, why) {
    const c = conns.get(sessionId);
    if (!c) return;
    c.dead = true;
    c.buf = Buffer.alloc(0); c.st = null; // release retained frame/fragment storage at retirement
    clearInterval(c.timer);
    conns.delete(sessionId);
    // A dead socket's pairing code must die with it, or a code could be redeemed for a connection
    // that is no longer there.
    if (R.cancelPairing(reg, sessionId)) log('receiver: pairing cancelled for gone session ' + sessionId.slice(0, 8));
    try { c.socket.destroy(); } catch (e) {}
    log('receiver: session ' + sessionId + ' gone — ' + why);
    // The MEDIA is not stopped here, and that is the point of the whole design: a control-channel
    // outage must not kill healthy playback. The television keeps pulling HLS over its own HTTP
    // connection and keeps playing; when it reconnects it re-announces where it is and the Mac
    // reconstructs state. See HANDOFF-vod.md for why the previous cast-pipe behaviour, where the
    // control channel dying took the picture with it, needed a whole recovery module.
    hub.emit('disconnected', { sessionId, why, receiver: c.receiver || null });
  }

  // The HTTP upgrade handshake. Anything that is not a well-formed WebSocket upgrade for our path is
  // refused rather than ignored, so a misconfigured client gets an answer instead of a hang.
  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return refuse(socket, 400, 'bad request'); }
    if (url.pathname !== PATH) return refuse(socket, 404, 'not found');
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      return refuse(socket, 400, 'not a websocket upgrade');
    }

    if (conns.size >= maxConnections) return refuse(socket, 503, 'receiver connection limit');
    socket.setNoDelay(true);
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + wsf.acceptKey(key),
      '', ''
    ].join('\r\n'));

    // The SESSION id is the Mac's, not the receiver's. It names this connection; the receiver's own
    // stable identity arrives in its hello and is kept alongside. Conflating the two would mean a
    // reconnecting television could not be recognised as the same device.
    const sessionId = crypto.randomBytes(8).toString('hex');
    // The nonce is minted per CONNECTION and never reused. It is what makes a proof captured from an
    // earlier socket useless on this one.
    const conn = { socket, sessionId, receiver: null, dead: false, buf: Buffer.alloc(0), st: null,
      lastSeen: Date.now(), timer: null, state: STATE.UNAUTHENTICATED, nonce: R.newNonce(), receiverId: null };
    conns.set(sessionId, conn);
    log('receiver: session ' + sessionId + ' connected from ' + (socket.remoteAddress || '?'));

    conn.timer = setInterval(() => {
      if (conn.dead) return;
      if (Date.now() - conn.lastSeen > IDLE_TIMEOUT_MS) return drop(sessionId, 'idle timeout');
      writeFrame(conn, wsf.encodePing());
    }, PING_INTERVAL_MS);

    const receive = (chunk) => {
      if (conn.dead) return;
      conn.lastSeen = Date.now();
      conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
      const out = wsf.decode(conn.buf, conn.st);
      conn.buf = out.rest;
      conn.st = out.state || conn.st;
      if (out.fatal) return drop(sessionId, out.fatal);
      for (const f of out.frames) {
        if (conn.dead) return;
        if (f.type === 'ping') { if (!writeFrame(conn, wsf.encodePong(f.body))) return; continue; }
        if (f.type === 'pong') continue;                       // liveness only; lastSeen already moved
        if (f.type === 'close') return drop(sessionId, 'closed by receiver');
        if (f.type !== 'text') continue;                       // binary is not part of this protocol
        const r = proto.parse(f.text);
        if (!r.ok) { log('receiver: bad message on ' + sessionId + ' — ' + r.why); continue; }
        handleMessage(conn, r.msg);
      }
    };
    socket.on('data', receive);
    socket.on('error', () => drop(sessionId, 'socket error'));
    socket.on('close', () => drop(sessionId, 'socket closed'));
    // 'end' as well as 'close', and this is not belt-and-braces. A socket taken from an HTTP
    // upgrade is half-open capable: the peer's FIN raises 'end', and with the writable side still
    // open 'close' does not follow. Without this the departure was only noticed when a keepalive
    // ping failed to write — measured at 20,004ms, two ping intervals, during which the Mac still
    // believed a film was playing on a television that had gone.
    socket.on('end', () => drop(sessionId, 'receiver ended the connection'));
    // 'end' as well as 'close', and this is not belt-and-braces. A socket taken from an HTTP
    // upgrade is half-open capable: the peer's FIN raises 'end', and with the writable side still
    // open 'close' does not follow. Without this the departure was only noticed when a keepalive
    // ping failed to write — measured at 20,004ms, two ping intervals, during which the Mac still
    // believed a film was playing on a television that had gone.

    hub.emit('connected', { sessionId, send: (m) => send(sessionId, m) });
    send(sessionId, proto.hello(sessionId, { nonce: conn.nonce }));
    if (head && head.length) receive(head);
  }

  function handleMessage(conn, msg) {
    const sessionId = conn.sessionId;

    // THE INBOUND GATE. Everything below this line has already been proven to come from a socket
    // entitled to say it. Nothing is emitted to listeners before the check, so a controller cannot
    // accidentally act on an unauthenticated command by subscribing to it — the boundary is here,
    // not in every caller.
    if (conn.state !== STATE.AUTHENTICATED && !proto.PRE_AUTH_ALLOWED.includes(msg.type)) {
      log('receiver: refused ' + msg.type + ' from unauthenticated session ' + sessionId.slice(0, 8));
      return;
    }

    if (msg.type === 'ping') return void send(sessionId, proto.pong(sessionId, { nonce: msg.nonce }));
    if (msg.type === 'pong') return;

    if (msg.type === 'hello') {
      if (conn.state === STATE.AUTHENTICATED && msg.receiverId && msg.receiverId !== conn.receiverId) {
        log('receiver: refused greeting identity change on authenticated session ' + sessionId.slice(0, 8));
        return;
      }
      const receiverId = conn.state === STATE.AUTHENTICATED ? conn.receiverId : (msg.receiverId || null);
      conn.receiver = { receiverId, name: msg.name || null,
        platform: msg.platform || null, version: msg.version || null, playing: msg.playing || null };
      conn.receiverId = receiverId;
      log('receiver: ' + (conn.receiver.name || 'unnamed') + ' (' + (conn.receiver.platform || '?') +
        ') id=' + R.short(conn.receiverId) + ' state=' + conn.state);
      // A greeting from an unauthenticated socket is NOT forwarded as a session event: the
      // controller's hello handler decides whether to load media, and it must never run for a
      // connection that has not proved itself.
      if (conn.state !== STATE.AUTHENTICATED) return;
    }

    if (msg.type === 'auth') return void handleAuth(conn, msg);
    if (msg.type === 'pair.request') return void handlePairRequest(conn, msg);

    hub.emit('message', { sessionId, msg, receiver: conn.receiver });
    hub.emit(msg.type, { sessionId, msg, receiver: conn.receiver });
  }

  function handleAuth(conn, msg) {
    const sessionId = conn.sessionId;
    const id = msg.receiverId || conn.receiverId;
    const alreadyAuthenticated = conn.state === STATE.AUTHENTICATED;
    if (alreadyAuthenticated && id !== conn.receiverId) return drop(sessionId, 'authentication identity changed');
    const r = R.authenticate(reg, { receiverId: id, nonce: conn.nonce, proof: msg.proof });
    if (!r.ok) {
      // The socket is NOT dropped. A receiver that fails to authenticate may be a television whose
      // credential was revoked while it was playing, and killing the connection would teach it
      // nothing; it is told why, and stays in a state where it can ask to pair again.
      conn.state = r.why === 'revoked' ? STATE.REVOKED : STATE.UNAUTHENTICATED;
      log('receiver: authentication failed for ' + R.short(id) + ' — ' + r.why);
      send(sessionId, proto.authFailed(sessionId, { reason: r.why }));
      hub.emit('auth.failed', { sessionId, receiverId: id, reason: r.why });
      return;
    }
    if (alreadyAuthenticated) {
      send(sessionId, proto.authOk(sessionId, { receiverId: r.receiverId, displayName: r.displayName }));
      return; // acknowledge a duplicate proof without replaying session adoption/load events
    }
    R.cancelPairing(reg, sessionId); // successful proof supersedes any challenge on this connection
    conn.state = STATE.AUTHENTICATED;
    conn.receiverId = r.receiverId;
    saved();
    log('receiver: ' + R.short(r.receiverId) + ' authenticated');
    send(sessionId, proto.authOk(sessionId, { receiverId: r.receiverId, displayName: r.displayName }));

    // A genuine reconnect leaves the previous socket for this television lingering. Dropping it is
    // safe precisely BECAUSE authentication succeeded — only the holder of the credential can reach
    // this line, so this cannot be used by a stranger to knock a paired television offline.
    for (const [sid, other] of conns) {
      if (sid !== sessionId && other.receiverId === r.receiverId && other.state === STATE.AUTHENTICATED) {
        drop(sid, 'superseded by a newer authenticated connection from the same receiver');
      }
    }
    hub.emit('authenticated', { sessionId, receiverId: r.receiverId, receiver: conn.receiver });
    // Only now is the greeting worth acting on. Replaying it here means the controller's normal
    // hello path — including shouldLoad's do-not-reload rule — runs exactly once, after trust.
    if (conn.receiver) {
      const greeting = Object.assign({ v: proto.PROTOCOL_VERSION, type: 'hello', sid: sessionId, t: Date.now(), role: 'receiver' }, conn.receiver);
      hub.emit('message', { sessionId, msg: greeting, receiver: conn.receiver });
      hub.emit('hello', { sessionId, msg: greeting, receiver: conn.receiver });
    }
  }

  function handlePairRequest(conn, msg) {
    const sessionId = conn.sessionId;
    if (conn.state === STATE.AUTHENTICATED) {
      send(sessionId, proto.pairDeclined(sessionId, { reason: 'already authenticated' }));
      return;
    }
    const id = msg.receiverId || conn.receiverId;
    if (!id) {
      send(sessionId, proto.pairDeclined(sessionId, { reason: 'no receiver id' }));
      return;
    }
    const b = R.beginPairing(reg, { sessionId, receiverId: id,
      name: msg.name || (conn.receiver && conn.receiver.name), platform: msg.platform || (conn.receiver && conn.receiver.platform) });
    if (!b.ok) { send(sessionId, proto.pairDeclined(sessionId, { reason: b.why })); return; }
    conn.state = STATE.PAIRING;
    conn.receiverId = id;
    // The CODE is not logged. It is not a long-term secret, but logging it would let anything that
    // can read a log complete a pairing the human never approved.
    log('receiver: pairing challenge created for ' + R.short(id) + ', expires in ' + Math.round(b.ttlMs / 1000) + 's');
    send(sessionId, proto.pairChallenge(sessionId, { code: b.code, expiresAt: b.expiresAt }));
    hub.emit('pairing', { sessionId, receiverId: id, name: (conn.receiver && conn.receiver.name) || null, expiresAt: b.expiresAt });
  }

  function refuse(socket, code, text) {
    try {
      socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    } catch (e) {}
  }

  // Attach to an http.Server that is already listening for the media routes.
  function attach(server) {
    if (attachedServers.has(server)) return hub;
    attachedServers.add(server);
    server.on('upgrade', handleUpgrade);
    return hub;
  }

  // The human typed a code on the Mac. Redeem it, mint the credential, and hand it to the socket
  // that asked — once.
  function confirmPairing(code) {
    const r = R.confirmPairing(reg, { code });
    if (!r.ok) { log('receiver: pairing confirmation rejected — ' + r.why); return r; }
    const conn = conns.get(r.sessionId);
    if (!conn || conn.dead) {
      log('receiver: pairing confirmed but the session had gone');
      return { ok: false, why: 'session gone' };
    }
    conn.state = STATE.AUTHENTICATED;
    conn.receiverId = r.receiverId;
    saved();
    log('receiver: pairing succeeded for ' + R.short(r.receiverId));
    // The credential crosses the wire exactly here, once, immediately after a human approved it.
    send(r.sessionId, proto.pairAccepted(r.sessionId, { receiverId: r.receiverId, token: r.token,
      displayName: (conn.receiver && conn.receiver.name) || null }));
    hub.emit('paired', { sessionId: r.sessionId, receiverId: r.receiverId });
    if (conn.receiver) {
      const greeting = Object.assign({ v: proto.PROTOCOL_VERSION, type: 'hello', sid: r.sessionId, t: Date.now(), role: 'receiver' }, conn.receiver);
      hub.emit('hello', { sessionId: r.sessionId, msg: greeting, receiver: conn.receiver });
    }
    return { ok: true, receiverId: r.receiverId };
  }

  // Forget a television. Revocation that only took effect on the next reconnect would be a lie —
  // "forget this device" has to reach the session holding authority right now.
  function revoke(receiverId) {
    const r = R.revoke(reg, receiverId);
    if (!r.ok) return r;
    saved();
    log('receiver: credential revoked for ' + R.short(receiverId));
    for (const [sid, c] of conns) {
      if (c.receiverId === r.receiverId) {
        c.state = STATE.REVOKED;
        send(sid, proto.authFailed(sid, { reason: 'revoked' }));
        // The socket is left OPEN on purpose: the television is very likely playing, and playback
        // must survive losing authority. It simply cannot be commanded any more, and its own
        // reports stop being accepted.
        log('receiver: session ' + sid.slice(0, 8) + ' lost authority');
      }
    }
    hub.emit('revoked', { receiverId: r.receiverId });
    return r;
  }

  hub.confirmPairing = confirmPairing;
  hub.revoke = revoke;
  hub.registry = reg;
  hub.pending = () => R.pendingList(reg);
  hub.receivers = () => R.listReceivers(reg);
  hub.isAuthenticated = (sessionId) => (conns.get(sessionId) || {}).state === STATE.AUTHENTICATED;
  hub.stateOf = (sessionId) => (conns.get(sessionId) || {}).state || null;
  hub.attach = attach;
  hub.handleUpgrade = handleUpgrade;
  hub.send = send;
  hub.drop = drop;
  hub.sessions = () => [...conns.keys()];
  hub.receiverFor = (sessionId) => (conns.get(sessionId) || {}).receiver || null;
  hub.teardown = () => {
    for (const server of attachedServers) server.removeListener('upgrade', handleUpgrade);
    attachedServers.clear();
    for (const id of [...conns.keys()]) drop(id, 'teardown');
  };
  hub.PATH = PATH;
  return hub;
}

module.exports = createReceiverHub;
module.exports.PATH = PATH;
module.exports.STATE = STATE;
module.exports.IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;
