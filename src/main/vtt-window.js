'use strict';

// Serving a partially-extracted WebVTT file.
//
// Pulling subtitles out of a streamed torrent cannot be done the obvious way. Subtitle samples are
// interleaved through the media, so collecting every cue means reading the whole file — 25 GB over a
// swarm, which is hours, and the receiver has long since given up. Measured: four such extractions
// ran for five minutes and produced nothing at all.
//
// So the extraction is given a time budget instead and whatever it managed is served. That works
// because the torrent downloads in order: the stretch around the play head is already on disk, so
// those cues arrive at disk speed, and the run only slows down when it reaches data that has not
// arrived — exactly where the cues stop being useful anyway. A local file finishes well inside the
// budget and is unaffected.
//
// The catch is that a file cut off mid-write can end in a half-written cue, and a receiver that
// rejects the malformed tail may drop the whole track. Hence this: keep every complete cue, discard
// anything trailing that is not one.

// A cue is a timing line and its text. The timing line is the only thing that has to be intact for
// the cue to be meaningful, so blocks are validated on that.
const TIMING_RE = /^(?:\d{1,}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,}:)?\d{2}:\d{2}\.\d{3}/m;

// Trim a WebVTT document to its last complete cue.
//   text  — what the extractor wrote so far, possibly cut mid-cue
// Returns a valid document, or null when there is not one usable cue in it (callers should treat
// that as "no subtitles yet" rather than serving an empty track the receiver would show as blank).
function trimToCompleteCues(text) {
  if (typeof text !== 'string' || !text) return null;
  // Normalise line endings first: a CRLF file would otherwise split into blocks that keep a stray
  // \r, and the timing test would miss on cues that are in fact fine.
  const body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/^WEBVTT/.test(body)) return null;             // not a WebVTT document at all
  const blocks = body.split(/\n{2,}/);
  const header = blocks.shift();                       // "WEBVTT" plus any header metadata
  const kept = [];
  for (const b of blocks) {
    const block = b.trim();
    if (!block) continue;
    if (!TIMING_RE.test(block)) continue;              // a cue with no intact timing line is unusable
    // The final block is the one at risk of truncation. A cue whose timing line is complete but whose
    // text was cut still renders; a cue that is only a timing line does not.
    const lines = block.split('\n');
    const timingAt = lines.findIndex((l) => TIMING_RE.test(l));
    if (timingAt === lines.length - 1) continue;       // timing line with nothing after it
    kept.push(block);
  }
  if (!kept.length) return null;
  return header + '\n\n' + kept.join('\n\n') + '\n';
}

// How much of the file the cues actually cover, in seconds — the end time of the last complete cue.
// Used to report coverage rather than implying the whole film is subtitled.
function coverageEnd(text) {
  const doc = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  let last = 0;
  const re = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/g;
  let m;
  while ((m = re.exec(doc))) {
    const h = +(m[5] || 0), mi = +m[6], s = +m[7], ms = +m[8];
    const end = h * 3600 + mi * 60 + s + ms / 1000;
    if (end > last) last = end;
  }
  return last;
}

module.exports = { trimToCompleteCues, coverageEnd };
