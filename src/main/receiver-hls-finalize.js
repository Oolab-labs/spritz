'use strict';

// Declare an open EVENT playlist complete once its producer has exited cleanly and the segments add up to
// the film. The strictness is the point: an ENDLIST on a stream that is still growing ends the film early,
// so an error/killed producer, unknown duration or an incomplete presentation must remain an open EVENT.
// Two users: the source-selected receiver path rewrites the file on disk and keeps the EVENT type; the
// AirPlay serve path (lanserver serveHlsFile) passes { vod: true } to also relabel it VOD at serve time,
// because an LG AirPlay receiver treats an EVENT playlist as live even with ENDLIST.
function completedPlaylist(text, duration, code, signal, opts) {
  if (typeof text !== 'string' || code !== 0 || signal || !Number.isFinite(duration) || duration <= 0 ||
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
  const done = text.trimEnd() + '\n#EXT-X-ENDLIST\n';
  return opts && opts.vod ? done.replace(/^#EXT-X-PLAYLIST-TYPE:EVENT/m, '#EXT-X-PLAYLIST-TYPE:VOD') : done;
}
module.exports = { completedPlaylist };
