'use strict';
const fs = require('fs');
// Minimal asar writer (independent of the reader): UInt32 4, UInt32 headerPickleSize,
// UInt32 headerPickleSize-4, UInt32 jsonLength, JSON (padded to 4), then file bodies.
function writeAsar(file, entries) {
  const root = { files: {} }; const bodies = []; let offset = 0;
  for (const [p, content] of Object.entries(entries)) {
    const parts = p.split('/'); let node = root;
    for (const dir of parts.slice(0, -1)) node = (node.files[dir] ||= { files: {} });
    const buf = Buffer.from(content);
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    bodies.push(buf); offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4); json.copy(padded);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(padded.length + 8, 4); head.writeUInt32LE(padded.length + 4, 8); head.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([head, padded, ...bodies]));
}
module.exports = { writeAsar };
