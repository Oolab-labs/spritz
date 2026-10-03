'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { pollStatus } = require('../src/main/cast-poll');

// castv2-client's request() adds a 'message' listener and removes it only when the matching reply arrives.
// Polling with it every 3 s leaks one listener for every reply the TV never sends, and the library warns
// at eleven (seen in the field: MaxListenersExceededWarning on a MediaController).
function fixture() {
  const media = new EventEmitter(); media.sent = [];
  media.send = (m) => media.sent.push(m);
  const player = new EventEmitter(); player.media = media;
  const seen = []; player.on('status', (s) => seen.push(s));
  return { media, player, seen };
}
const timers = () => { const t = []; return { setTimeout: (fn) => { const h = { fn, cleared: false }; t.push(h); return h; }, clearTimeout: (h) => { h.cleared = true; }, fire: (i) => { if (!t[i].cleared) t[i].fn(); }, all: t }; };

test('a reply with the matching request id is delivered as a status and the listener goes', () => {
  const { media, player, seen } = fixture(); const tm = timers();
  pollStatus(player, tm);
  assert.strictEqual(media.sent.length, 1);
  assert.strictEqual(media.sent[0].type, 'GET_STATUS');
  assert.strictEqual(media.listenerCount('message'), 1);
  media.emit('message', { type: 'MEDIA_STATUS', requestId: media.sent[0].requestId, status: [{ playerState: 'PLAYING', currentTime: 12 }] }, false);
  assert.deepStrictEqual(seen, [{ playerState: 'PLAYING', currentTime: 12 }]);
  assert.strictEqual(media.listenerCount('message'), 0);
  assert.ok(tm.all[0].cleared, 'the timeout is cancelled once answered');
});

test('a reply that never comes is cleaned up by the timeout', () => {
  const { media, player, seen } = fixture(); const tm = timers();
  pollStatus(player, tm);
  tm.fire(0);
  assert.strictEqual(media.listenerCount('message'), 0);
  assert.deepStrictEqual(seen, []);
});

test('fifty unanswered polls never accumulate listeners', () => {
  const { media, player } = fixture(); const tm = timers();
  for (let i = 0; i < 50; i++) { pollStatus(player, tm); tm.fire(i); }
  assert.strictEqual(media.listenerCount('message'), 0);
  assert.strictEqual(media.sent.length, 50);
  assert.strictEqual(new Set(media.sent.map((m) => m.requestId)).size, 50, 'every request has its own id');
});

test('other traffic is ignored: other request ids, other message types, empty status lists', () => {
  const { media, player, seen } = fixture(); const tm = timers();
  pollStatus(player, tm);
  const id = media.sent[0].requestId;
  media.emit('message', { type: 'MEDIA_STATUS', requestId: id + 1, status: [{ currentTime: 1 }] }, false);
  media.emit('message', { type: 'PONG', requestId: id }, false);
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(media.listenerCount('message'), 1, 'still waiting for ours');
  media.emit('message', { type: 'MEDIA_STATUS', requestId: id, status: [] }, false);
  assert.strictEqual(seen.length, 0, 'an empty list is not a status');
  assert.strictEqual(media.listenerCount('message'), 0, 'but it is the answer, so the listener is released');
});

test('a player without a media controller, or one whose send throws, is not an error', () => {
  const tm = timers();
  assert.doesNotThrow(() => pollStatus({}, tm));
  const { media, player } = fixture(); media.send = () => { throw new Error('socket closed'); };
  assert.doesNotThrow(() => pollStatus(player, tm));
  assert.strictEqual(media.listenerCount('message'), 0, 'a failed send leaves nothing behind');
});
