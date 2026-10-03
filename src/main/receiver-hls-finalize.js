'use strict';

// Only the source-selected receiver path uses this. An error/killed producer,
// unknown duration or an incomplete presentation must remain an open EVENT.
function completedPlaylist(text, duration, code, signal) {
  if (code !== 0 || signal || !Number.isFinite(duration) || duration <= 0 ||
      !text.startsWith('#EXTM3U') || /^#EXT-X-ENDLIST/m.test(text) ||
      !/^#EXT-X-PLAYLIST-TYPE:EVENT/m.test(text)) return null;
  let seconds = 0, segments = 0;
  const lines = text.trim().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) continue;
    const match = /^#EXTINF:(\d+(?:\.\d+)?),/.exec(lines[i]);
    if (!match || !lines[i + 1] || lines[i + 1].startsWith('#')) return null;
    const length = Number(match[1]);
    if (!(length > 0)) return null;
    seconds += length; segments++;
  }
  // Allow sub-frame/audio-padding disagreement in the probed container duration,
  // not a whole missing segment. Segment history itself remains unchanged.
  if (!segments || seconds < duration - 0.25 || seconds > duration + 2) return null;
  return text.trimEnd() + '\n#EXT-X-ENDLIST\n';
}
module.exports = { completedPlaylist };
