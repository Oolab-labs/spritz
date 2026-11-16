'use strict';
// subtitle:external takes a path from the renderer and keeps it for casts. From there it reaches
// `ffmpeg -i` (lanserver serveSubtitleForDlna, the HLS/MKV extraSubs) and, for .srt/.smi, the LAN
// file server as-is. So it must hold to the same rule as every sibling path channel: an existing,
// absolute, regular local file (ipc-validate localMediaPath), and a subtitle extension at that.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { localMediaPath } = require('../src/main/ipc-validate');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

function fixture() {
  let handler;
  const ctx = { path, localMediaPath, externalSubs: [], ipcMain: { on: (ch, cb) => { if (ch === 'subtitle:external') handler = cb; } } };
  vm.createContext(ctx);
  const start = source.indexOf('  // External subtitle file the user attached');
  const end = source.indexOf('  // ---- VPN kill-switch status');
  assert.ok(start > 0 && end > start, 'subtitle:external handler found in main.js');
  vm.runInContext(source.slice(start, end), ctx);
  return { subs: ctx.externalSubs, send: (msg) => handler(null, msg) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-subext-'));
const srt = path.join(tmp, 'Movie.en.srt');
fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nhi\n');
const notSub = path.join(tmp, 'id_rsa');
fs.writeFileSync(notSub, 'secret');
const video = path.join(tmp, 'Movie.mkv');
fs.writeFileSync(video, '');

test('a real subtitle file is registered once, with defaults filled in', () => {
  const f = fixture();
  f.send({ path: srt });
  f.send({ path: srt });
  assert.equal(f.subs.length, 1);
  assert.deepEqual({ ...f.subs[0] }, { path: srt, lang: 'und', name: 'Movie.en.srt' });
});

test('every subtitle extension the Add Subtitle dialog offers is accepted', () => {
  const f = fixture();
  for (const ext of ['srt', 'ass', 'ssa', 'sub', 'smi', 'vtt', 'SRT']) {
    const p = path.join(tmp, 'x.' + ext);
    fs.writeFileSync(p, '');
    f.send({ path: p });
  }
  assert.equal(f.subs.length, 7);
});

test('URLs, ffmpeg protocols, relative, missing and directory paths are not registered', () => {
  const f = fixture();
  for (const p of ['concat:' + srt + '|' + srt, 'http://198.51.100.7/x.srt', 'file://' + srt, 'subfile,,start,0,end,0,,:' + srt,
    'Movie.en.srt', '../Movie.en.srt', path.join(tmp, 'missing.srt'), tmp, srt + '\0.srt', 42, {}, '']) {
    f.send({ path: p });
  }
  f.send(undefined);
  assert.deepEqual(f.subs, []);
});

test('a readable file that is not a subtitle is not registered (it would be served raw on the LAN)', () => {
  const f = fixture();
  f.send({ path: notSub });
  f.send({ path: video });
  assert.deepEqual(f.subs, []);
});
