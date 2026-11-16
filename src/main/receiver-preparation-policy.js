'use strict';

const { isTorrentSource } = require('./receiver-playhead'); // the one definition of a torrent stream URL

function sourceWaiting(sample, { source, generation, now }) {
  if (!isTorrentSource(source)) return false;
  if (!sample || sample.source !== source || sample.generation !== generation) return false;
  const age = now - sample.at;
  const health = sample.health;
  return Number.isFinite(age) && age >= 0 && age <= 5000 && !!health &&
    health.known === true && health.sustainable === false &&
    Number.isFinite(health.secondsBuffered) && health.secondsBuffered <= 1;
}

function stallAction({ sourceWaiting, category, elapsedMs }) {
  // Explicit media errors always retain the existing recovery path.
  if (!sourceWaiting || !['no-output', 'output-available', 'partial-output', 'deadline-before-output'].includes(category)) return 'recover';
  return elapsedMs >= 60000 ? 'expire' : 'wait';
}

// Packaged-app defaults: a Finder launch has no shell environment, so the shipped behaviour must
// be the hardware-qualified one. Source-selected audio is on (SPRITZ_RECEIVER_SOURCE_AUDIO=0 turns
// it off).
function receiverFeatures(env) {
  return { sourceAudio: env.SPRITZ_RECEIVER_SOURCE_AUDIO !== '0' };
}

module.exports = { sourceWaiting, stallAction, receiverFeatures };
