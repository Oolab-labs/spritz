'use strict';

// Where does an MP4's index live?
//
// An MP4 is a flat chain of boxes. The media itself sits in `mdat`; the index that says where every
// frame is sits in `moov`. Nothing requires `moov` to come first. Files prepared for streaming put
// it at the front ("faststart"); plenty of releases leave it at the back, after 25 GB of video.
//
// That distinction is invisible when playing locally — mpv just seeks to the end and reads it — and
// fatal when casting a partially-downloaded torrent, where the end of the file does not exist yet:
// nothing can be demuxed, so the transcoder emits no bytes and the receiver sits on its idle screen
// forever. Finding the index is therefore the difference between "cast this now" and "fetch 8 MB
// first", and guessing wrong in either direction is expensive.
//
// The walk only ever reads box headers — 16 bytes at each boundary — so locating a `moov` at the far
// end of a 25 GB file costs a handful of tiny reads rather than a scan.

// A box header is 8 bytes: a 32-bit size then a 4-character type. Two escapes matter. Size 1 means
// the real size is a 64-bit value in the next 8 bytes, which is how any box over 4 GiB is written —
// `mdat` routinely is. Size 0 means "runs to end of file", which can only be the final box.
const HEADER_BYTES = 16;
const MAX_BOXES = 24;           // a sane chain reaches moov well inside this; a broken one stops here
// Box types are four characters, in practice alphanumeric with the odd space or '©' in metadata.
// This is deliberately tight: a loose "any printable byte" test happily reads an HTML error page as
// a chain of giant boxes and walks off into nonsense instead of reporting that it cannot parse.
const TYPE_RE = /^[A-Za-z0-9 \xa9]{4}$/;

function parseHeader(buf, fileSize, offset) {
  if (!buf || buf.length < 8) return null;
  const type = buf.toString('latin1', 4, 8);
  if (!TYPE_RE.test(type)) return null;         // not a box boundary — the chain is not what we think
  let size = buf.readUInt32BE(0);
  let header = 8;
  if (size === 1) {
    if (buf.length < 16) return null;
    const big = buf.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    header = 16;
  } else if (size === 0) {
    size = fileSize - offset;                   // extends to EOF
  }
  if (size < header) return null;               // a box cannot be smaller than its own header
  return { type, size, header };
}

// Walk the top-level chain and report where `moov` is.
//
//   read(offset, length) -> Promise<Buffer>   may return fewer bytes than asked for
//
// Resolves to { offset, size, atFront } or null when the index cannot be located. `atFront` means
// the index precedes the media, so the file is already streamable and nothing needs fetching.
async function findMoov(read, fileSize) {
  if (typeof read !== 'function' || !Number.isFinite(fileSize) || fileSize <= 0) return null;
  let offset = 0;
  let sawMedia = false;
  for (let i = 0; i < MAX_BOXES && offset + 8 <= fileSize; i++) {
    let buf;
    try {
      buf = await read(offset, Math.min(HEADER_BYTES, fileSize - offset));
    } catch (e) {
      return null;                              // the boundary is unreadable — treat as unknown
    }
    const box = parseHeader(buf, fileSize, offset);
    if (!box) return null;
    if (box.type === 'moov') return { offset, size: box.size, atFront: !sawMedia };
    if (box.type === 'mdat' && box.size > 0) sawMedia = true;
    const next = offset + box.size;
    if (next <= offset || next > fileSize) return null;  // overlapping or overrunning: malformed
    offset = next;
  }
  return null;
}

// True for the containers this applies to. MKV keeps its seek index (Cues) at the end just as often,
// but finding it means parsing EBML, and the fix there is a different shape — deliberately out of
// scope rather than half-done.
function isMp4Name(name) {
  return /\.(mp4|m4v|mov)$/i.test(String(name || ''));
}

module.exports = { findMoov, parseHeader, isMp4Name };
