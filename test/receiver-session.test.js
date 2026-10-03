'use strict';

// Whether a reconnecting receiver should be sent a fresh LOAD.
//
// Measured on hardware: dropping the control socket mid-film, the television reconnected in 1.4s and
// correctly re-announced itself — capabilities, LOADED with the right duration, STATE playing, at
// film 5905s. The controller then sent LOAD unconditionally on the greeting and restarted the film
// from zero. Position went 5905.4s -> 7.8s. The receiver did its job; the Mac discarded the answer.
//
// So the rule lives here, as a pure function, rather than inline in a socket handler where it cannot
// be tested and where the next controller would reimplement it differently.

const { test } = require('node:test');
const assert = require('assert');
const { shouldLoad } = require('../src/main/receiver-session');

test('a fresh receiver with nothing playing gets the film', () => {
  const d = shouldLoad({ hello: { role: 'receiver' }, desired: { mediaId: 'film-1' } });
  assert.equal(d.load, true);
  assert.match(d.why, /nothing/i);
});

// The case the hardware round got wrong.
test('a receiver already playing the film we want is left alone', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'film-1', currentTime: 5905.4, state: 'playing' } },
    desired: { mediaId: 'film-1' }
  });
  assert.equal(d.load, false, 'reloading here restarts the film from zero — measured: 5905.4s -> 7.8s');
  assert.equal(d.adopt.currentTime, 5905.4, 'the position the receiver reported is the one to adopt');
});

test('a receiver playing something else is switched to the film we want', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'other', currentTime: 12, state: 'playing' } },
    desired: { mediaId: 'film-1' }
  });
  assert.equal(d.load, true);
  assert.match(d.why, /different/i);
});

// A receiver that is paused is still holding the film. Restarting it would be just as destructive as
// restarting one that is playing, and is the easier case to get wrong.
test('a paused receiver keeps its film and its position', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'film-1', currentTime: 606.2, state: 'paused' } },
    desired: { mediaId: 'film-1' }
  });
  assert.equal(d.load, false);
  assert.equal(d.adopt.currentTime, 606.2);
  assert.equal(d.adopt.state, 'paused');
});

// `ended` is not "holding the film" — there is nothing to resume, and leaving it alone would strand
// the viewer on a finished film with a controller that thinks all is well.
test('a receiver that finished the film is reloaded', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'film-1', currentTime: 5980, state: 'ended' } },
    desired: { mediaId: 'film-1' }
  });
  assert.equal(d.load, true);
});

test('a nonsense position is not adopted', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'film-1', currentTime: null, state: 'playing' } },
    desired: { mediaId: 'film-1' }
  });
  assert.equal(d.load, false, 'the receiver still holds the film');
  assert.equal(d.adopt.currentTime, null, 'but an unusable clock reading is passed through as unknown, not invented');
});

test('nothing is desired, nothing is loaded', () => {
  assert.equal(shouldLoad({ hello: { role: 'receiver' }, desired: null }).load, false);
});

// The controller's own greeting must never be mistaken for a receiver's.
test('a non-receiver hello is ignored', () => {
  const d = shouldLoad({ hello: { role: 'controller' }, desired: { mediaId: 'film-1' } });
  assert.equal(d.load, false);
  assert.match(d.why, /not a receiver/i);
});

// ---- transport epochs -----------------------------------------------------------------------
//
// A far seek may replace the film's TRANSPORT — a new ffmpeg-owned HLS run at that position, a new
// URL — while the film stays the same film (see transport-epoch.js). shouldLoad stays the single
// authority: it is handed one more fact, which epoch each side holds, and the rule is additive.
// A receiver that reports no epoch (an older receiver build) gets today's rule unchanged.

test('same film, same epoch, reconnect: adopt', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'goat', epoch: 'epoch-2', currentTime: 412.5, state: 'playing' } },
    desired: { mediaId: 'goat', epoch: 'epoch-2', url: 'http://mac/vod/t/epoch-2/media.m3u8' }
  });
  assert.equal(d.load, false);
  assert.equal(d.adopt.currentTime, 412.5);
});

test('same film, but an explicit seek made a newer epoch: the transport must be reloaded', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'goat', epoch: 'epoch-1', currentTime: 12.5, state: 'playing' } },
    desired: { mediaId: 'goat', epoch: 'epoch-2', url: 'http://mac/vod/t/epoch-2/media.m3u8' }
  });
  assert.equal(d.load, true);
  assert.match(d.why, /epoch/);
});

test('a different film is a different film, whatever the epochs say', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'other', epoch: 'epoch-2', currentTime: 12.5, state: 'playing' } },
    desired: { mediaId: 'goat', epoch: 'epoch-2', url: 'http://mac/x' }
  });
  assert.equal(d.load, true);
  assert.match(d.why, /different media/);
});

test('a receiver that reports no epoch is judged by the film alone, as before', () => {
  // The hardware-proven reconnect case must not regress on a receiver build that predates epochs.
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'goat', currentTime: 5905.4, state: 'playing' } },
    desired: { mediaId: 'goat', epoch: 'epoch-1', url: 'http://mac/x' }
  });
  assert.equal(d.load, false, 'no reload of a healthy receiver over a fact it cannot report');
  assert.equal(d.adopt.currentTime, 5905.4);
});

test('the adopted reading names the epoch the receiver holds', () => {
  const d = shouldLoad({
    hello: { role: 'receiver', playing: { mediaId: 'goat', epoch: 'epoch-2', currentTime: 1, state: 'paused' } },
    desired: { mediaId: 'goat', epoch: 'epoch-2', url: 'http://mac/x' }
  });
  assert.equal(d.adopt.epoch, 'epoch-2');
});
