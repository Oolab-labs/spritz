'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Stable UUID v5 for each executable role, distinct from the upstream Electron application.
function uuidFor(identity) {
  const dnsNamespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const uuid = crypto.createHash('sha1').update(dnsNamespace).update(identity).digest().subarray(0, 16);
  uuid[6] = (uuid[6] & 15) | 0x50; uuid[8] = (uuid[8] & 63) | 0x80;
  return uuid;
}
function uuidOffset(binary) {
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf) throw Error('Expected a thin little-endian 64-bit Mach-O executable');
  const count = binary.readUInt32LE(16), end = 32 + binary.readUInt32LE(20);
  if (end > binary.length) throw Error('Truncated Mach-O load commands');
  let offset = 32, found = null;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw Error('Truncated Mach-O load command');
    const command = binary.readUInt32LE(offset), size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw Error('Invalid Mach-O load command size');
    if (command === 0x1b) {
      if (size !== 24 || found !== null) throw Error('Invalid Mach-O LC_UUID');
      found = offset + 8;
    }
    offset += size;
  }
  if (found === null) throw Error('Mach-O executable has no LC_UUID');
  return found;
}
function stampUuid(binary, identity) { uuidFor(identity).copy(binary, uuidOffset(binary)); }
function executables(app, product = 'Spritz') {
  const rels = [`Contents/MacOS/${product}`];
  const frameworks = path.join(app, 'Contents/Frameworks');
  for (const name of fs.readdirSync(frameworks)) {
    if (name.startsWith(product + ' Helper') && name.endsWith('.app')) rels.push(`Contents/Frameworks/${name}/Contents/MacOS/${name.slice(0, -4)}`);
  }
  return rels;
}
function verifyUuids(app, appId = 'app.spritz.player', product = 'Spritz') {
  return executables(app, product).filter(rel => {
    const binary = fs.readFileSync(path.join(app, rel));
    return !binary.subarray(uuidOffset(binary), uuidOffset(binary) + 16).equals(uuidFor(appId + '/' + rel));
  });
}
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { productFilename, id } = context.packager.appInfo;
  const app = path.join(context.appOutDir, productFilename + '.app');
  for (const rel of executables(app, productFilename)) {
    const file = path.join(app, rel), binary = fs.readFileSync(file);
    stampUuid(binary, id + '/' + rel); fs.writeFileSync(file, binary);
  }
  console.log('Executable UUIDs isolated for ' + id + ' (before fuses and signing)');
}
module.exports = afterPack;
Object.assign(module.exports, { uuidFor, stampUuid, verifyUuids });
