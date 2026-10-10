'use strict';

// Map a subtitle chosen in the AirPlay menu back to the mpv `sid` the return-to-local reload restores.
//
// The AirPlay menu selects an AVMediaSelectionOption by index. Those options are the master's
// SUBTITLES renditions, which lanserver lists in castSubs (same order) with ids that name their source:
//   source-subtitle-N        → the N-th subtitle stream of the file (counting bitmap streams too,
//                              exactly as mpv's embedded sub tracks are numbered in demux order)
//   external-subtitle-<sha1> → an external file; sha1(path).slice(0,12)
// AVFoundation does not promise option order and composes its own displayName ("ENG - English" for
// NAME="ENG"), so the index is trusted only when the counts agree and every option name contains its
// rendition's name. Anything unverifiable returns null: keep the previous track rather than guess.
const crypto = require('crypto');

const pathId = (p) => crypto.createHash('sha1').update(String(p)).digest('hex').slice(0, 12);

function sidForAirplaySubtitle({ index, options, renditions, mpvTracks }) {
  if (!Number.isInteger(index)) return null;
  if (index < 0) return 'no';
  if (!Array.isArray(options) || !Array.isArray(renditions) || options.length !== renditions.length) return null;
  if (index >= renditions.length) return null;
  const agree = renditions.every((r, i) => {
    const label = String((r && (r.name || r.lang)) || '').toLowerCase();
    return label && String((options[i] && options[i].name) || '').toLowerCase().includes(label);
  });
  if (!agree) return null;

  const subs = (Array.isArray(mpvTracks) ? mpvTracks : []).filter((t) => t && t.type === 'sub');
  const id = String(renditions[index].id || '');
  let track = null;
  let m;
  if ((m = /^source-subtitle-(\d+)$/.exec(id))) {
    track = subs.filter((t) => !t.external).sort((a, b) => a.id - b.id)[Number(m[1])] || null;
  } else if ((m = /^external-subtitle-([0-9a-f]{12})$/.exec(id))) {
    track = subs.find((t) => t.external && t['external-filename'] && pathId(t['external-filename']) === m[1]) || null;
  }
  return track && Number.isInteger(track.id) ? String(track.id) : null;
}

module.exports = { sidForAirplaySubtitle };
