'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findMoov, isMp4Name } = require('../src/main/mp4-index');

// Build a fake MP4 as a list of [type, size] boxes and hand back a reader over it. Only headers are
// ever materialised — the body bytes are zeros, which is all the walk looks at.
function fakeFile(boxes) {
  let size = 0;
  const at = [];
  for (const [type, len, opts] of boxes) {
    at.push({ type, offset: size, len, big: !!(opts && opts.big), toEof: !!(opts && opts.toEof) });
    size += len;
  }
  const read = async (offset, length) => {
    const box = at.find((b) => b.offset === offset);
    if (!box) return Buffer.alloc(length); // not a boundary: zeros, which parse as an invalid type
    const buf = Buffer.alloc(Math.max(16, length));
    if (box.big) {
      buf.writeUInt32BE(1, 0);
      buf.write(box.type, 4, 'latin1');
      buf.writeBigUInt64BE(BigInt(box.len), 8);
    } else {
      buf.writeUInt32BE(box.toEof ? 0 : box.len, 0);
      buf.write(box.type, 4, 'latin1');
    }
    return buf.subarray(0, Math.max(8, length));
  };
  return { read, size };
}

test('an index at the front is reported as already streamable', async () => {
  const f = fakeFile([['ftyp', 32], ['moov', 5000], ['mdat', 1000000]]);
  const got = await findMoov(f.read, f.size);
  assert.ok(got, 'moov should be found');
  assert.equal(got.atFront, true);
  assert.equal(got.offset, 32);
  assert.equal(got.size, 5000);
});

test('an index behind the media is found, and not called front-loaded', async () => {
  // The shape that broke casting: a gap where faststart would have put the index, then the media,
  // then the index right at the end.
  const f = fakeFile([['ftyp', 32], ['free', 9012706], ['mdat', 25413319545, { big: true }], ['moov', 7980002]]);
  const got = await findMoov(f.read, f.size);
  assert.ok(got, 'moov should be found past a 25 GB mdat');
  assert.equal(got.atFront, false);
  assert.equal(got.offset, 32 + 9012706 + 25413319545);
  assert.equal(got.size, 7980002);
});

test('a 64-bit box size is followed rather than truncated', async () => {
  // mdat above 4 GiB is written with the size-1 escape. Reading the 32-bit field literally would
  // land the walk in the middle of the video and find nothing.
  const f = fakeFile([['ftyp', 32], ['mdat', 8000000000, { big: true }], ['moov', 1234]]);
  const got = await findMoov(f.read, f.size);
  assert.ok(got);
  assert.equal(got.offset, 32 + 8000000000);
});

test('an index that never appears reports nothing rather than a guess', async () => {
  const f = fakeFile([['ftyp', 32], ['mdat', 500000]]);
  assert.equal(await findMoov(f.read, f.size), null);
});

test('a box running to end-of-file terminates the walk safely', async () => {
  const f = fakeFile([['ftyp', 32], ['mdat', 500000, { toEof: true }]]);
  assert.equal(await findMoov(f.read, f.size), null);
});

test('unreadable bytes yield nothing, never a wrong offset', async () => {
  // The reader throws when the region is not downloaded yet. Returning a plausible-looking offset
  // here would send the fetch after the wrong 8 MB and cast would fail anyway, more confusingly.
  const failing = async () => { throw new Error('not available'); };
  assert.equal(await findMoov(failing, 1000000), null);
});

test('garbage in place of a box header is rejected', async () => {
  const read = async () => Buffer.alloc(16); // zeros: size 0, type "\0\0\0\0"
  assert.equal(await findMoov(read, 1000000), null);
});

// The hand-built fixtures above encode my understanding of the format, which is exactly the thing
// that could be wrong. These two build real MP4s and check the answer against an independent scan
// for the box header, so a mistaken assumption cannot pass both.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FFMPEG = [
  '/Applications/Spritz.app/Contents/Resources/bin/ffmpeg',
  path.join(__dirname, '..', 'bin', 'ffmpeg')
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

function buildMp4(out, faststart) {
  const args = ['-y', '-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  if (faststart) args.push('-movflags', '+faststart');
  execFileSync(FFMPEG, args.concat([out]), { stdio: 'ignore', timeout: 60000 });
  const fd = fs.openSync(out, 'r');
  const size = fs.statSync(out).size;
  const read = async (o, l) => { const b = Buffer.alloc(l); const n = fs.readSync(fd, b, 0, l, o); return b.subarray(0, n); };
  const scan = fs.readFileSync(out).indexOf(Buffer.from('moov')) - 4; // where it really is
  return { read, size, scan };
}

test('a real MP4 written with the index at the end is located exactly', async (t) => {
  if (!FFMPEG) return t.skip('no bundled ffmpeg on this machine');
  const f = buildMp4(path.join(require('os').tmpdir(), 'spritz-idx-tail.mp4'), false);
  const got = await findMoov(f.read, f.size);
  assert.ok(got, 'index should be found');
  assert.equal(got.offset, f.scan, 'offset must match an independent scan for the header');
  assert.equal(got.atFront, false, 'ffmpeg writes moov last unless asked otherwise');
});

test('a real faststart MP4 is recognised as needing no fetch', async (t) => {
  if (!FFMPEG) return t.skip('no bundled ffmpeg on this machine');
  const f = buildMp4(path.join(require('os').tmpdir(), 'spritz-idx-front.mp4'), true);
  const got = await findMoov(f.read, f.size);
  assert.ok(got);
  assert.equal(got.offset, f.scan);
  assert.equal(got.atFront, true);
});

test('an HTML error page is refused rather than walked', async () => {
  // Not hypothetical: a torrent server that has moved on answers with a 404 page, and a loose type
  // check reads "<!DO" as a box of 169 MB and walks off into the file inventing boundaries.
  const page = Buffer.from('\n    <!DOCTYPE html>\n<html><body>404</body></html>');
  assert.equal(await findMoov(async () => page, 1000000), null);
});

test('only MP4-family containers are claimed', () => {
  for (const n of ['a.mp4', 'A.M4V', 'x.mov']) assert.equal(isMp4Name(n), true, n);
  for (const n of ['a.mkv', 'a.avi', 'a.webm', '', null]) assert.equal(isMp4Name(n), false, String(n));
});
