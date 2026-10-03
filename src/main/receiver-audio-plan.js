'use strict';

// Source audio ordinals are FFmpeg's 0:a:N, never HTML audioTracks indices.
//
// `hint` is the track the Mac is playing at the first cast. It is advisory: an explicit `requested`
// wins and stays strict, but a hint the source does not have (external audio file, stale id) falls
// back to track 0 rather than failing the cast.
function selectSourceAudio(info, requested, hint) {
  const audio = info && Array.isArray(info.audio) ? info.audio : [];
  const hinted = requested == null && Number.isInteger(hint) && audio.some(track => track.idx === hint);
  const index = requested != null ? requested : hinted ? hint : 0;
  if (!Number.isInteger(index) || index < 0 || index > 31) throw new Error('Invalid source audio index');
  if (!audio.length) {
    if (requested != null) throw new Error('Source audio inventory unavailable');
    return { index: 0, catalog: [], info };
  }
  const selected = audio.find(track => track.idx === index);
  if (!selected) throw new Error('Source audio track unavailable');
  return {
    index,
    catalog: audio.slice(0, 32).map(track => ({
      id: 'source-audio-' + track.idx,
      title: String(track.name || 'Audio ' + (track.idx + 1)).slice(0, 128),
      lang: String(track.lang || 'und').slice(0, 64),
      selected: track.idx === index
    })),
    // Plan audio compatibility against the chosen track, including its codec/channels.
    info: { ...info, audio: [selected] }
  };
}

// A near-position transport is qualified only for stream copy with a known timeline.
// Unsupported sources keep the existing from-zero preparation path.
function nearInputStart(requested, duration, transcode) {
  return !transcode && Number.isFinite(requested) && requested > 0 &&
    Number.isFinite(duration) && duration > requested ? requested : 0;
}
// mpv's `aid` is 1-based per stream type; FFmpeg's 0:a:N is 0-based. 'auto'/'no'/unset mean the
// viewer made no explicit choice.
function audioOrdinalFromAid(aid) {
  const n = typeof aid === 'number' ? aid : /^\d+$/.test(String(aid)) ? Number(aid) : NaN;
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

module.exports = { selectSourceAudio, nearInputStart, audioOrdinalFromAid };
