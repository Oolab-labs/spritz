'use strict';

// Unsupported, malformed and multipart ranges are ignored as a whole. HEAD ignores Range.
// Decimal fields are unbounded in HTTP; compare as BigInt before converting file offsets.
function byteRange(header, size, method = 'GET') {
  const full = { kind: 'full' };
  if (method !== 'GET' || typeof header !== 'string') return full;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return full;
  const length = BigInt(size);
  const bad = { kind: 'unsatisfiable' };
  if (length === 0n) return bad;
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return bad;
    start = suffix >= length ? 0n : length - suffix;
    end = length - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : length - 1n;
    if (start >= length || end < start) return bad;
    if (end >= length) end = length - 1n;
  }
  return { kind: 'partial', start: Number(start), end: Number(end) };
}

module.exports = { byteRange };
