'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = process.env.SPRITZ_TEST_APP_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/lanserver.js'), 'utf8');
const handler = source.slice(source.indexOf('  function serveHlsFile('), source.indexOf('  function deliverFile('));
const stub = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n';
const cues = stub + '00:00:01.000 --> 00:00:05.000\nSubtitle regression\n\n';
async function fixture(t, status = 'pending') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-sub-response-'));
  const file = path.join(dir, 'sub_0.vtt'); fs.writeFileSync(file, stub);
  const task = { status, queuedAt: Date.now() };
  const context = vm.createContext({ fs, URL, Buffer, setTimeout, require: createRequire(path.join(root, 'src/main/lanserver.js')),
    hlsToken: 'current', hlsDir: dir, receiverSubtitles: null, hlsMasterShape: null, hlsFinish: null,
    hlsSubTasks: new Map([['sub_0.vtt', task]]), SUB_RENDITION_BUDGET_MS: 10, SUB_GRACE_MS: 0,
    clog() {}, startSubExtract() {}, containedPath: (base, name) => path.join(base, name), safeStat: f => fs.statSync(f),
    deliverFile(req, res, f, size, type, extra) { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...extra }); res.end(fs.readFileSync(f)); }
  });
  vm.runInContext(handler, context);
  const server = http.createServer((req, res) => context.serveHlsFile(req, res, 'current', 'sub_0.vtt'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { context, task, file, url: `http://127.0.0.1:${server.address().port}/sub_0.vtt` };
}
test('native AirPlay subtitle URL waits for extraction and serves the published size', async t => {
  const f = await fixture(t);
  const result = fetch(f.url).then(async response => ({ response, body: await response.text() }));
  const publish = setTimeout(() => { fs.writeFileSync(f.file, cues); f.task.status = 'ready'; }, 40);
  t.after(() => clearTimeout(publish));
  const { response, body } = await result;
  assert.equal(body, cues);
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(cues));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('native AirPlay failed extraction returns retryable failure instead of empty VTT', async t => {
  const f = await fixture(t, 'failed'); const response = await fetch(f.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(await response.text(), '');
});
test('subtitle wait ends when the AirPlay session is replaced', async t => {
  const f = await fixture(t); const result = fetch(f.url);
  const retire = setTimeout(() => { f.context.hlsToken = 'replacement'; }, 40);
  t.after(() => clearTimeout(retire));
  assert.equal((await result).status, 404);
});
test('native AirPlay extraction deadline returns a retryable error', async t => {
  const f = await fixture(t); const response = await fetch(f.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(await response.text(), '');
});
