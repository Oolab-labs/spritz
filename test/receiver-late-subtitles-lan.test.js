'use strict';

// The Mac's half of late subtitles for a torrent MP4 cast to the Spritz Receiver.
//
// resolveCastable hands a torrent MP4 to the television untouched, through the /dlna/ proxy, and
// deliberately probes nothing first: an MP4 written the ordinary way keeps its index (moov) at the
// END, so a probe before the cast would wait on the last pieces of the swarm. Measured on a 13 GB
// WEB-DL: moov at byte 13,182,791,484 of 13,188,472,946, two English mov_text tracks, and a receiver
// whose menu offered no subtitles at all. Once the TV is playing it has fetched that index itself, so
// a probe then is cheap. prepareLateReceiverSubtitles is that probe, plus the route that prepares the
// chosen track on demand exactly as the HLS path does (receiver-subtitles.js).

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { binPath } = require('../src/main/bin-path');

const FFMPEG = binPath('ffmpeg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-late-subs-'));
const SKIP = !FFMPEG && 'ffmpeg not available';

// An MP4 the way a release is written: moov at the end (no faststart), one mov_text track.
function fixtures() {
  const srt = path.join(tmp, 'en.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nHello from the subtitle track\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond line\n\n');
  const withSubs = path.join(tmp, 'film.mp4'), without = path.join(tmp, 'bare.mp4');
  const video = ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=10'];
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...video, '-i', srt, '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', withSubs]);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...video, '-c:v', 'mpeg4', without]);
  return { withSubs, without };
}

// A stand-in for webtorrent's localhost server: ranged GETs of one file under /webtorrent/.
function upstream(files) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop());
    const file = files[name];
    if (!file) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? +m[1] : 0, end = m && m[2] ? +m[2] : size - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); }).on('error', reject);
  });
}
const late = (lan, input) => new Promise((resolve) => lan.prepareLateReceiverSubtitles(input, { extraSubs: [] }, resolve));

test('a torrent MP4 with its index at the end yields its embedded subtitles, prepared on selection', { skip: SKIP }, async (t) => {
  const { withSubs } = fixtures();
  const up = await upstream({ 'film.mp4': withSubs });
  const lan = require('../src/main/lanserver.js')({});
  t.after(() => { lan.teardown(); up.close(); });
  if (!lan.lanAddress()) return t.skip('no LAN address on this machine');
  await new Promise((r) => lan.serve(withSubs, r)); // the server is listening once a token is issued
  const input = 'http://127.0.0.1:' + up.address().port + '/webtorrent/abc/film.mp4';
  const entries = await late(lan, input);
  assert.ok(Array.isArray(entries) && entries.length === 1, 'one text track: ' + JSON.stringify(entries));
  const [e] = entries;
  assert.equal(e.id, 'source-subtitle-0');
  assert.equal(e.lang, 'eng');
  assert.equal(e.prepare, true);
  assert.match(e.url, /^http:\/\/[\d.]+:\d+\/rsub\/[^/]+\/[^/]+\.vtt$/);

  // The TV's subtitle loader: prepare at a position until ready, then load the revision.
  let result;
  for (let i = 0; i < 100; i++) {
    const r = await get(e.url + '?spritzSubPrepare=1&spritzSubPosition=0&spritzSubOwner=tv1');
    assert.equal(r.status, 200);
    result = JSON.parse(r.body);
    if (result.status === 'ready') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.equal(result.status, 'ready', JSON.stringify(result));
  const vtt = await get(result.url);
  assert.equal(vtt.status, 200);
  assert.match(vtt.body, /^WEBVTT/);
  assert.match(vtt.body, /Hello from the subtitle track/);

  // Teardown takes the route with it: the URL the TV holds stops answering.
  lan.teardown();
  await new Promise((r) => setTimeout(r, 50));
});

test('an MP4 with no text subtitles yields an empty list, and an unreadable one yields null', { skip: SKIP }, async (t) => {
  const { without } = fixtures();
  const up = await upstream({ 'bare.mp4': without });
  const lan = require('../src/main/lanserver.js')({});
  t.after(() => { lan.teardown(); up.close(); });
  if (!lan.lanAddress()) return t.skip('no LAN address on this machine');
  await new Promise((r) => lan.serve(without, r));
  const base = 'http://127.0.0.1:' + up.address().port + '/webtorrent/abc/';
  assert.deepEqual(await late(lan, base + 'bare.mp4'), [], 'nothing to offer: stop asking');
  assert.equal(await late(lan, base + 'missing.mp4'), null, 'not readable yet: the caller may ask again');
});

test('a subtitle route is refused for a token it was not issued', { skip: SKIP }, async (t) => {
  const { withSubs } = fixtures();
  const up = await upstream({ 'film.mp4': withSubs });
  const lan = require('../src/main/lanserver.js')({});
  t.after(() => { lan.teardown(); up.close(); });
  if (!lan.lanAddress()) return t.skip('no LAN address on this machine');
  await new Promise((r) => lan.serve(withSubs, r));
  const [e] = await late(lan, 'http://127.0.0.1:' + up.address().port + '/webtorrent/abc/film.mp4');
  const forged = e.url.replace(/\/rsub\/[^/]+\//, '/rsub/' + 'f'.repeat(32) + '/');
  assert.equal((await get(forged + '?spritzSubPrepare=1&spritzSubPosition=0&spritzSubOwner=tv1')).status, 404);
  assert.equal((await get(e.url.replace(/[^/]+\.vtt$/, '..%2F..%2Fsecret.vtt'))).status, 404);
});
