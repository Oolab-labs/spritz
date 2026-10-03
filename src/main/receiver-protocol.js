'use strict';

// The Mac <-> Receiver control protocol, as data.
//
// Deliberately NOT an RPC framework. It is a small set of JSON messages with a version, a session
// and a type, because the whole point of this channel is that a human can read a log of it and see
// what happened. Anything that needs a code generator to inspect would defeat that.
//
// Nothing here is webOS-specific, and that is a requirement rather than an accident: a Tizen or
// Android TV receiver must be able to implement the same conceptual interface. LG particulars
// (webOSTV.js, luna://, remote key codes) stay inside the TV application and never appear in a
// message. If a field can only be satisfied by one vendor, it does not belong in this file.
//
// Pure: no sockets, no I/O, no clock beyond what the caller passes. The hub owns transport.

const PROTOCOL_VERSION = 1;

// Mac -> TV. The Mac is authoritative for media preparation, so every one of these is an
// instruction about playback, never about how to obtain or decode the media.
const COMMANDS = ['hello', 'load', 'play', 'pause', 'seek', 'stop', 'ping',
  // Pairing and authentication. Dotted names because they are a family rather than seven unrelated
  // verbs, and because a log line reading `pair.challenge` explains itself.
  'select-track', 'pair.challenge', 'pair.accepted', 'pair.declined', 'auth.ok', 'auth.failed'];

// TV -> Mac. These are OBSERVATIONS. The receiver reports what its own player did; it does not
// assert what Spritz should do next.
const EVENTS = ['hello', 'ready', 'loaded', 'state', 'position', 'error', 'pong', 'capabilities',
  'tracks', 'select-track', 'pair.request', 'auth'];

// What an UNAUTHENTICATED socket may say. Everything else is refused before it reaches a listener.
//
// This list is the security boundary, so it is defined here beside the protocol rather than inline
// in the hub: a reader deciding whether a new message type is safe pre-authentication should find
// the answer next to the message definitions, not buried in a socket handler.
//
// `hello` and the pairing exchange are the point. `ping`/`pong` are here because liveness must work
// before trust — an unpaired television sitting on the pairing screen still has to be detectable as
// present or gone.
const PRE_AUTH_ALLOWED = ['hello', 'ping', 'pong', 'pair.request', 'auth'];

// Commands the hub must never send to a socket that has not authenticated. Media URLs are the ones
// that matter: they are the private thing this channel hands out.
const POST_AUTH_ONLY = ['select-track', 'load', 'play', 'pause', 'seek', 'stop'];

// The playback states a receiver may report. Kept small on purpose — a receiver that invents its
// own vocabulary is a receiver the Mac cannot reason about generically.
//
// `stalled` is NOT in this list, and its absence is measured rather than stylistic: on this exact
// hardware the HTML5 `stalled` event fires at every segment transition while the clock keeps moving
// perfectly (see HANDOFF-vod.md, "Corrections made this session"). It is reported as telemetry on a
// `state` message's `flags`, never as a state, so that nothing downstream can mistake it for a
// playback failure.
const STATES = ['idle', 'loading', 'buffering', 'playing', 'paused', 'ended'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validSubtitleId = id => typeof id === 'string' && /^(?:off|(?:source|sideload)-subtitle-(?:0|[1-9]\d?|1[01]\d|12[0-7])|(?:0|[1-9]\d?|1[01]\d|12[0-7])|external-subtitle-[a-f0-9]{12})$/.test(id);
const validSourceSubtitleId = id => typeof id === 'string' && (!id.startsWith('source-subtitle-') || validSubtitleId(id));
const validSubtitleMetadata = t => ['forced', 'sdh', 'default', 'prepare'].every(k => !has(t, k) || typeof t[k] === 'boolean') && (!has(t, 'format') || typeof t.format === 'string' && t.format.length <= 64);
const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

// One envelope builder, so a field cannot be spelled two ways in two places.
//
// `t` is the SENDER's clock in epoch milliseconds. It is not used to synchronise anything — the two
// machines' clocks are not assumed to agree — but it makes a captured log orderable and shows how
// stale a reading was when it arrived, which is the whole question for a position report.
function envelope(type, sessionId, fields, now) {
  return Object.assign({
    v: PROTOCOL_VERSION,
    type: String(type),
    sid: sessionId == null ? null : String(sessionId),
    t: isFiniteNum(now) ? now : Date.now()
  }, fields || {});
}

// ---- Mac -> TV -------------------------------------------------------------------------------

// The Mac greets first, naming the protocol it speaks. A receiver that cannot speak this major
// version should say so in its own hello rather than failing silently.
// `nonce` is per-connection and single-use: it is what makes a captured proof worthless on the next
// socket. `auth: 'required'` states the expectation explicitly rather than leaving a receiver to
// infer it, so a future receiver on another platform cannot quietly skip authenticating.
const hello = (sessionId, { name, nonce, now } = {}) =>
  envelope('hello', sessionId, {
    role: 'controller', name: name || 'Spritz', accepts: EVENTS.slice(),
    auth: 'required', nonce: nonce == null ? null : String(nonce)
  }, now);

// `url` is an HLS media or master playlist the Mac is already serving. The receiver is not told how
// it was produced, and must not care: local file, remux, or a torrent still downloading are all the
// same instruction here. That indifference is what lets the torrent-priority work land later without
// touching the receiver.
//
// `autoplay` is EXPLICIT. Leaving it implicit is how two receivers end up with different behaviour
// and a bug that only reproduces on one of them.
//
// `epoch` names the TRANSPORT — which ffmpeg-owned HLS representation of the film this URL is. A far
// seek can replace it while the film (mediaId) stays the same; the receiver echoes it back beside
// mediaId so that receiver-session.shouldLoad() can tell "same film, older transport" from "same
// film, same transport". See transport-epoch.js. Null when the URL is not epoch-backed.
const load = (sessionId, { mediaId, epoch, url, title, startSec, autoplay, subtitles, audioCatalog, subtitleTrackId, timelineOrigin, sourceDuration, now } = {}) =>
  envelope('load', sessionId, {
    mediaId: mediaId == null ? null : String(mediaId),
    epoch: epoch == null ? null : String(epoch),
    url: String(url || ''),
    title: title == null ? null : String(title),
    startSec: isFiniteNum(startSec) ? startSec : 0,
    autoplay: autoplay !== false,
    ...(timelineOrigin !== undefined ? { timelineOrigin, sourceDuration } : {}),
    ...(Array.isArray(subtitles) && subtitles.length ? { subtitles: subtitles.slice() } : {}),
    ...(Array.isArray(audioCatalog) ? { audioCatalog: audioCatalog.slice(0, 32) } : {}),
    ...(typeof subtitleTrackId === 'string' ? { subtitleTrackId } : {})
  }, now);

const play = (sessionId, { now } = {}) => envelope('play', sessionId, {}, now);
const pause = (sessionId, { now } = {}) => envelope('pause', sessionId, {}, now);
const stop = (sessionId, { now } = {}) => envelope('stop', sessionId, {}, now);

// Absolute seconds, never a delta. A relative seek would have to be resolved against a position the
// Mac only knows second-hand, and the ±30s remote keys are resolved on the TV where the true clock
// is — see the receiver app.
const seek = (sessionId, { toSec, now } = {}) =>
  envelope('seek', sessionId, { toSec: isFiniteNum(toSec) ? toSec : 0 }, now);

const ping = (sessionId, { nonce, now } = {}) => envelope('ping', sessionId, { nonce: nonce == null ? null : String(nonce) }, now);

// ---- TV -> Mac -------------------------------------------------------------------------------

// The receiver's identity must be STABLE across reboots and DHCP leases, for the same reason
// device-memory.js keys on an id rather than an address: a profile keyed on an address gets silently
// transplanted onto whatever answers there next week.
const helloFrom = (sessionId, { receiverId, name, platform, version, now } = {}) =>
  envelope('hello', sessionId, {
    role: 'receiver',
    receiverId: receiverId == null ? null : String(receiverId),
    name: name == null ? null : String(name),
    platform: platform == null ? null : String(platform),
    version: version == null ? null : String(version)
  }, now);

const ready = (sessionId, { now } = {}) => envelope('ready', sessionId, {}, now);

// Every report the receiver makes about media names BOTH the film (mediaId) and the transport
// (epoch) it is holding — the two facts shouldLoad and the position mapping need together.
const loaded = (sessionId, { mediaId, epoch, durationSec, now } = {}) =>
  envelope('loaded', sessionId, {
    mediaId: mediaId == null ? null : String(mediaId),
    epoch: epoch == null ? null : String(epoch),
    durationSec: isFiniteNum(durationSec) ? durationSec : null
  }, now);

// `flags` is where noisy-but-informative DOM events go — `stalled`, `waiting` — precisely so they
// stay out of `state`. See the STATES comment.
const state = (sessionId, { mediaId, epoch, state: st, flags, now } = {}) =>
  envelope('state', sessionId, {
    mediaId: mediaId == null ? null : String(mediaId),
    epoch: epoch == null ? null : String(epoch),
    state: String(st || 'idle'),
    flags: Array.isArray(flags) ? flags.slice() : []
  }, now);

// The core telemetry. `bufferedUntil` is included because it distinguishes the two failures that
// look identical from the Mac: a receiver that is starved (buffer at the play head) from one that is
// wedged with data in hand (buffer far ahead, clock still) — the exact distinction that took the VOD
// investigation days to make.
const position = (sessionId, { mediaId, epoch, currentTime, durationSec, paused, bufferedUntil, now } = {}) =>
  envelope('position', sessionId, {
    mediaId: mediaId == null ? null : String(mediaId),
    epoch: epoch == null ? null : String(epoch),
    currentTime: isFiniteNum(currentTime) ? currentTime : null,
    durationSec: isFiniteNum(durationSec) ? durationSec : null,
    paused: !!paused,
    bufferedUntil: isFiniteNum(bufferedUntil) ? bufferedUntil : null
  }, now);

// `code` and `message` are carried verbatim from the player. They are CONTEXT, not a capability
// signal: device-memory.js is explicit that a failure is not attributable to any one property, and
// nothing here may be used to narrow a device profile.
const error = (sessionId, { mediaId, epoch, code, message, fatal, now } = {}) =>
  envelope('error', sessionId, {
    mediaId: mediaId == null ? null : String(mediaId),
    epoch: epoch == null ? null : String(epoch),
    code: code == null ? null : String(code),
    message: message == null ? null : String(message),
    fatal: !!fatal
  }, now);

const pong = (sessionId, { nonce, now } = {}) => envelope('pong', sessionId, { nonce: nonce == null ? null : String(nonce) }, now);

// What the receiver believes it can do. REPORTED, in device-profile.js's ranking — weaker than
// `observed`, and the hub must never file it as the latter. Only media that actually played writes
// an observation.
const capabilities = (sessionId, { reported, now } = {}) =>
  envelope('capabilities', sessionId, { reported: reported && typeof reported === 'object' ? reported : {} }, now);

// ---- pairing and authentication ---------------------------------------------------------------

// TV -> Mac. A receiver with no stored credential asks to pair. It carries no secret, because it
// has none: this is the one message a completely untrusted socket is allowed to originate.
const pairRequest = (sessionId, { receiverId, name, platform, now: n } = {}) =>
  envelope('pair.request', sessionId, {
    receiverId: receiverId == null ? null : String(receiverId),
    name: name == null ? null : String(name),
    platform: platform == null ? null : String(platform)
  }, n);

// Mac -> TV. The code the human will read off the screen, and when it stops working.
//
// The code travels over an UNAUTHENTICATED socket, which is safe because it is not a secret: it
// authenticates nothing. Its only job is to bind the connection that asked to pair to the screen the
// human is looking at. An eavesdropper who learns the code gains nothing, because only the Mac's own
// UI can redeem it, and the human types the code from THEIR television.
const pairChallenge = (sessionId, { code, expiresAt, now: n } = {}) =>
  envelope('pair.challenge', sessionId, { code: String(code), expiresAt: Number(expiresAt) || 0 }, n);

// Mac -> TV. The long-term credential, sent EXACTLY ONCE, at the moment a human approved it.
// After this it is never transmitted again — see receiver-registry's proofFor.
const pairAccepted = (sessionId, { receiverId, token, displayName, now: n } = {}) =>
  envelope('pair.accepted', sessionId, {
    receiverId: String(receiverId), token: String(token),
    displayName: displayName == null ? null : String(displayName)
  }, n);

const pairDeclined = (sessionId, { reason, now: n } = {}) =>
  envelope('pair.declined', sessionId, { reason: String(reason || 'declined') }, n);

// TV -> Mac. Proof of possession, never the credential itself.
const auth = (sessionId, { receiverId, proof, now: n } = {}) =>
  envelope('auth', sessionId, { receiverId: String(receiverId), proof: String(proof) }, n);

const authOk = (sessionId, { receiverId, displayName, now: n } = {}) =>
  envelope('auth.ok', sessionId, {
    receiverId: String(receiverId),
    displayName: displayName == null ? null : String(displayName)
  }, n);

// The reason is deliberately coarse — 'bad proof', 'revoked', 'unknown receiver'. Enough for a human
// reading a log to act, not enough to help someone probe which receiver ids exist by watching how
// the answers differ in detail.
const authFailed = (sessionId, { reason, now: n } = {}) =>
  envelope('auth.failed', sessionId, { reason: String(reason || 'failed') }, n);

// ---- parsing ---------------------------------------------------------------------------------

// Returns { ok: true, msg } or { ok: false, why }. Never throws: this parses bytes that arrived over
// a network from another machine, and a malformed frame must close a connection deliberately rather
// than take down the process.
function parse(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch (e) { return { ok: false, why: 'not JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, why: 'not an object' };
  if (!has(m, 'v') || m.v !== PROTOCOL_VERSION) return { ok: false, why: 'unsupported protocol version ' + m.v };
  if (!has(m, 'type') || typeof m.type !== 'string') return { ok: false, why: 'missing type' };
  if (!COMMANDS.includes(m.type) && !EVENTS.includes(m.type)) return { ok: false, why: 'unknown type ' + m.type };
  for (const field of ['mediaId', 'epoch']) {
    if (has(m, field) && m[field] !== null && typeof m[field] !== 'string') return { ok: false, why: 'invalid ' + field };
  }
  if (m.type === 'state') {
    if (!STATES.includes(m.state)) return { ok: false, why: 'invalid state' };
    if (has(m, 'flags') && (!Array.isArray(m.flags) || m.flags.some(flag => typeof flag !== 'string'))) return { ok: false, why: 'invalid flags' };
  }
  if (m.type === 'load' && has(m, 'subtitles') && (!Array.isArray(m.subtitles) || m.subtitles.length > 128 || m.subtitles.some(s => !s || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url) || has(s, 'id') && !validSubtitleId(s.id) || !validSubtitleMetadata(s)))) return { ok: false, why: 'invalid subtitles' };
  if (m.type === 'select-track' && (!['audio', 'subtitle'].includes(m.kind) || typeof m.trackId !== 'string' || m.trackId.length > 32 || (m.kind === 'subtitle' && !validSubtitleId(m.trackId)) || typeof m.mediaId !== 'string')) return { ok: false, why: 'invalid track selection' };
  if (m.type === 'load' && has(m, 'audioCatalog') && (!Array.isArray(m.audioCatalog) || m.audioCatalog.length > 32 || m.audioCatalog.some(t => !t || typeof t.id !== 'string' || t.id.length > 32 || !/^source-audio-\d+$/.test(t.id) || typeof t.title !== 'string' || t.title.length > 128 || typeof t.lang !== 'string' || t.lang.length > 64 || typeof t.selected !== 'boolean'))) return { ok: false, why: 'invalid source audio catalog' };
  if (m.type === 'load' && has(m, 'subtitleTrackId') && !validSubtitleId(m.subtitleTrackId)) return { ok: false, why: 'invalid subtitle selection' };
  if (m.type === 'tracks') {
    if (typeof m.mediaId !== 'string' || !m.tracks || !['audio', 'subtitles'].every(kind => Array.isArray(m.tracks[kind]) && m.tracks[kind].length <= (kind === 'subtitles' ? 128 : 32) && m.tracks[kind].every(t => t && typeof t.id === 'string' && t.id.length <= 32 && (kind !== 'subtitles' || validSourceSubtitleId(t.id) && validSubtitleMetadata(t)) && typeof t.title === 'string' && t.title.length <= 128 && typeof t.lang === 'string' && t.lang.length <= 64 && typeof t.selected === 'boolean'))) return { ok: false, why: 'invalid tracks' };
  }
  if (m.type === 'tracks' && m.tracks.subtitles.some(t => has(t, 'readyState') && (!Number.isInteger(t.readyState) || t.readyState < 0 || t.readyState > 3) || has(t, 'cueCount') && (!Number.isInteger(t.cueCount) || t.cueCount < 0 || t.cueCount > 1000000))) return { ok: false, why: 'invalid subtitle readiness' };
  if (m.type === 'load' && has(m, 'timelineOrigin') && (!isFiniteNum(m.timelineOrigin) || m.timelineOrigin < 0 || !isFiniteNum(m.sourceDuration) || m.sourceDuration <= m.timelineOrigin || m.epoch != null || m.startSec < m.timelineOrigin)) return { ok: false, why: 'invalid logical timeline' };
  const times = m.type === 'position' ? ['currentTime', 'durationSec', 'bufferedUntil', 'requestedTime']
    : m.type === 'loaded' ? ['durationSec'] : m.type === 'load' ? ['startSec'] : m.type === 'seek' ? ['toSec'] : [];
  for (const field of times) {
    if (has(m, field) && m[field] !== null && (!isFiniteNum(m[field]) || m[field] < 0)) {
      return { ok: false, why: 'invalid ' + field };
    }
  }
  if (m.type === 'hello' && has(m, 'playing') && m.playing !== null) {
    const playing = m.playing;
    if (!playing || typeof playing !== 'object' || Array.isArray(playing)) return { ok: false, why: 'invalid playing' };
    for (const field of ['mediaId', 'epoch']) {
      if (has(playing, field) && playing[field] !== null && typeof playing[field] !== 'string') return { ok: false, why: 'invalid playing.' + field };
    }
    for (const field of ['currentTime', 'durationSec', 'bufferedUntil', 'requestedTime']) {
      if (has(playing, field) && playing[field] !== null && (!isFiniteNum(playing[field]) || playing[field] < 0)) return { ok: false, why: 'invalid playing.' + field };
    }
    if (has(playing, 'state') && !STATES.includes(playing.state)) return { ok: false, why: 'invalid playing.state' };
    if (has(playing, 'paused') && typeof playing.paused !== 'boolean') return { ok: false, why: 'invalid playing.paused' };
  }
  if (m.type === 'position' && has(m, 'seeking') && typeof m.seeking !== 'boolean') return { ok: false, why: 'invalid seeking' };
  if (m.type === 'position' && has(m, 'paused') && typeof m.paused !== 'boolean') return { ok: false, why: 'invalid paused' };
  return { ok: true, msg: m };
}

const serialize = (msg) => JSON.stringify(msg);

module.exports = {
  PROTOCOL_VERSION, COMMANDS, EVENTS, STATES, PRE_AUTH_ALLOWED, POST_AUTH_ONLY,
  pairRequest, pairChallenge, pairAccepted, pairDeclined, auth, authOk, authFailed,
  envelope, parse, serialize,
  hello, load, play, pause, seek, stop, ping,
  helloFrom, ready, loaded, state, position, error, pong, capabilities
};
