'use strict';

// A paired receiver, as the rest of Spritz already talks about playback targets.
//
// cast.js emits `{ id, type, host, name }` and main.js forwards that to the renderer. A Spritz
// Receiver becomes another entry in that vocabulary rather than a parallel "receiver devices"
// universe, so the UI has one idea of what a target is.
//
// Three identities are kept apart, deliberately, because collapsing them is how a device list
// quietly attaches itself to the wrong television:
//
//   receiverId   stable, survives reboots, DHCP leases and app reinstalls. THE identity.
//   sessionId    one connection. A reconnect makes a new one; it is not a new television.
//   credential   never appears here at all.
//
// The address is not identity and is not even reported: it is a DHCP lease, and the LG moved between
// two of them during this project's own development.
//
// Pure: no sockets, no registry mutation, no clock beyond what the caller passes.

// What the user is told. Kept small on purpose — a receiver that is paired but not connected is
// 'offline', and one that is connected but has not authenticated is not a target at all.
const ONLINE = 'online';
const OFFLINE = 'offline';

// The playback words are the receiver protocol's own STATES, unchanged, so nothing has to translate
// between two vocabularies. `stalled` is absent for the reason it is absent there: measured on this
// hardware it fires at every segment boundary while the clock keeps perfect time, and showing it
// would turn healthy playback into an alarming UI.
function targetsFrom({ registry, sessions } = {}) {
  const reg = registry || { receivers: {} };
  const live = new Map();
  for (const s of sessions || []) {
    if (!s || !s.receiverId || !s.authenticated) continue;
    // If one television somehow has two authenticated sockets, the most recent wins: the hub drops
    // superseded ones, so the newer is the real connection.
    const prev = live.get(s.receiverId);
    if (!prev || (s.since || 0) >= (prev.since || 0)) live.set(s.receiverId, s);
  }

  const out = [];
  for (const id of Object.keys(reg.receivers || {})) {
    const r = reg.receivers[id];
    // A revoked receiver is not a target. It keeps its row in the registry so a human can see it was
    // forgotten, but offering it as somewhere to send a film would be a lie: it has no authority.
    if (!r || r.revokedAt || !r.token) continue;
    const s = live.get(id) || null;
    out.push({
      id,                              // the STABLE receiver id, not an address
      type: 'spritz-receiver',
      name: r.displayName || 'Spritz Receiver',
      status: s ? ONLINE : OFFLINE,
      // The receiver build the television announced in its greeting; null until it has (and while offline).
      version: s && s.version ? String(s.version) : null,
      versionStatus: require('./receiver-version').status(s && s.version),
      // Present only while connected. An offline receiver has no playback state, and inventing
      // 'idle' for one would be indistinguishable from a connected receiver sitting at the home
      // screen.
      playback: s ? {
        ...(s.tracks ? { tracks: s.tracks } : {}),
        state: s.state || 'idle',
        mediaId: s.mediaId || null,
        epoch: s.epoch == null ? null : String(s.epoch),
        currentTime: Number.isFinite(s.currentTime) ? s.currentTime : null,
        durationSec: Number.isFinite(s.durationSec) ? s.durationSec : null,
        // How stale the reading is. A position without its age is not knowledge — the whole point of
        // this channel is that the Mac stops guessing where the television is.
        ageMs: Number.isFinite(s.at) ? Math.max(0, (s.now || Date.now()) - s.at) : null
      } : null,
      pairedAt: r.pairedAt || null,
      lastSeen: r.lastSeen || null
    });
  }
  // Stable ordering, so a device list does not reshuffle itself as connections come and go.
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  return out;
}

// Receivers awaiting a human's approval. The CODE is never included: it is on the television's
// screen, and a copy travelling to the renderer would let anything that can read the UI's state
// complete a pairing the human never saw.
function pendingFrom({ pending } = {}) {
  return (pending || []).map((p) => ({
    receiverId: p.receiverId,
    name: p.name || 'Spritz Receiver',
    platform: p.platform || null,
    expiresAt: p.expiresAt || null
  }));
}

module.exports = { targetsFrom, pendingFrom, ONLINE, OFFLINE };
