'use strict';

// Turn an open EVENT playlist into a finished VOD one once its producer has exited cleanly and the
// segments add up to the film. The strictness is the point: a playlist is only declared complete when
// that can be proved, because an ENDLIST on a stream that is still growing ends the film early.
const { completedPlaylist } = require('./receiver-hls-finalize');

function finishedVariant(text, durationSec, code, signal) {
  if (typeof text !== 'string' || code !== 0 || signal) return null;
  const done = completedPlaylist(text, durationSec, code, signal);
  if (!done) return null;
  return done.replace(/^#EXT-X-PLAYLIST-TYPE:EVENT/m, '#EXT-X-PLAYLIST-TYPE:VOD');
}

module.exports = { finishedVariant };
