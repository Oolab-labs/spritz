'use strict';

// Ask a Cast receiver for its media status without leaking listeners.
//
// castv2-client's request() adds a 'message' listener and removes it only when the matching reply arrives,
// so polling with it leaks one listener per reply the TV never sends. This sends the same GET_STATUS itself,
// listens for exactly its own reply, and always lets go: on the reply, on a timeout, or if the send fails.
// The reply is delivered as an ordinary 'status' event, so the existing handler sees it.
const REQUEST_ID_BASE = 1000000; // above anything the library numbers its own requests with
let nextId = REQUEST_ID_BASE;

function pollStatus(player, timers = { setTimeout, clearTimeout }, timeoutMs = 4000) {
  const media = player && player.media;
  if (!media || typeof media.send !== 'function') return;
  const id = ++nextId;
  let timer = null;
  const release = () => { media.removeListener('message', onMessage); if (timer) timers.clearTimeout(timer); };
  function onMessage(message) {
    if (!message || message.type !== 'MEDIA_STATUS' || message.requestId !== id) return;
    release();
    const status = Array.isArray(message.status) ? message.status[0] : null;
    if (status) player.emit('status', status);
  }
  media.on('message', onMessage);
  timer = timers.setTimeout(release, timeoutMs);
  try { media.send({ type: 'GET_STATUS', requestId: id }); } catch (e) { release(); }
}

module.exports = { pollStatus };
