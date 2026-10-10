'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { createRequire } = require('module');
const { once } = require('events');
const { pathToFileURL } = require('url');

// Point this at an extracted app.asar to exercise the actual packaged source and dependencies.
const appRoot = process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..');
const filename = path.join(appRoot, 'src/main/torrent.js');
const source = fs.readFileSync(filename, 'utf8');

// Real WebTorrent store and HTTP handler; no discovery, trackers, or outside peers.
async function fixture(t) {
  const localRequire = createRequire(filename);
  const { default: WebTorrent } = await import(pathToFileURL(localRequire.resolve('webtorrent')).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-door-test-'));
  const seedDir = path.join(temp, 'pack'); fs.mkdirSync(seedDir);
  for (const name of ['100% Wolf 日本.mp4', 'Other.mp4']) fs.writeFileSync(path.join(seedDir, name), Buffer.alloc(11 * 1024 * 1024, 42));
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  const seeded = await new Promise((resolve, reject) => {
    client.once('error', reject);
    client.seed(seedDir, { announce: [] }, resolve);
  });
  let server;
  const createServer = client.createServer.bind(client);
  client.createServer = (...args) => { server = createServer(...args); return server; };
  client.add = (_, __, cb) => { queueMicrotask(() => cb(seeded)); return seeded; };
  const context = { module: { exports: {} }, Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require: n => n === 'electron' ? { app: { getPath: () => temp } } : localRequire(n) };
  vm.runInNewContext(source, context, { filename });
  const events = [];
  const torrent = context.module.exports((type, payload) => events.push({ type, payload }), { loadWebTorrent: async () => ({ default: class { constructor() { return client; } } }) });
  t.after(() => {
    torrent.teardown();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await torrent.add('fixture');
  await new Promise(resolve => setImmediate(resolve));
  torrent.selectFile(0);
  if (!server.server.listening) await once(server.server, 'listening');
  const port = server.address().port;
  const paths = seeded.files.map(file => '/webtorrent/' + seeded.infoHash + '/' + file.path.split('/').map(encodeURIComponent).join('/'));
  const filePath = i => paths[i];
  return { torrent, server, port, filePath, length: seeded.files[0].length, events };
}

function request(port, pathname, headers = {}, method = 'GET', hostname = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, headers, method, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(900, () => req.destroy(new Error('HTTP response deadline exceeded')));
    req.on('error', reject); req.end();
  });
}

test('torrent HTTP admission against the real WebTorrent server', async t => {
  const f = await fixture(t);
  await t.test('binds only loopback', () => assert.equal(f.server.address().address, '127.0.0.1'));
  await t.test('foreign Host is rejected', async () => assert.equal((await request(f.port, f.filePath(0), { Host: 'attacker.example:' + f.port, Range: 'bytes=0-3' })).status, 403));
  await t.test('browser Origin is rejected', async () => assert.equal((await request(f.port, f.filePath(0), { Origin: 'https://attacker.example', Range: 'bytes=0-3' })).status, 403));
  await t.test('browser navigation and preflight are rejected', async () => {
    assert.equal((await request(f.port, f.filePath(0), { 'Sec-Fetch-Site': 'cross-site', Range: 'bytes=0-3' })).status, 403);
    assert.equal((await request(f.port, f.filePath(0), {}, 'OPTIONS')).status, 405);
  });
  for (const p of ['/webtorrent', '/webtorrent/', '/webtorrent/' + f.filePath(0).split('/')[2], f.filePath(1)]) {
    await t.test('route is hidden: ' + p, async () => {
      assert.equal((await request(f.port, p, { Range: 'bytes=0-3' })).status, 404, p);
    });
  }
  await t.test('selected Unicode/percent file supports ranges and HEAD without CORS', async () => {
    for (const host of ['localhost', '127.0.0.1']) {
      const r = await request(f.port, f.filePath(0), { Host: host + ':' + f.port, Range: 'bytes=5-12' });
      assert.equal(r.status, 206); assert.deepEqual(r.body, Buffer.alloc(8, 42));
      assert.equal(r.headers['content-range'], `bytes 5-12/${f.length}`);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    const head = await request(f.port, f.filePath(0), {}, 'HEAD');
    assert.equal(head.status, 200); assert.equal(Number(head.headers['content-length']), f.length); assert.equal(head.body.length, 0);
  });
  await t.test('file selection invalidates the previous file URL', async () => {
    f.torrent.selectFile(1);
    assert.equal((await request(f.port, f.filePath(0), { Range: 'bytes=0-3' })).status, 404);
    assert.equal((await request(f.port, f.filePath(1), { Range: 'bytes=0-3' })).status, 206);
  });
  await t.test('malformed escapes reply promptly', async () => {
    assert.equal((await request(f.port, f.filePath(0).replace(/[^/]+$/, '%E0%A4%A'))).status, 400);
  });
  await t.test('cancel invalidates the old URL', async () => {
    f.torrent.cancel();
    assert.equal((await request(f.port, f.filePath(0), { Range: 'bytes=0-3' })).status, 404);
  });
});

test('token LAN proxy preserves real torrent HEAD/ranges and retires on stop', async t => {
  const f = await fixture(t);
  const createLan = createRequire(filename)('./lanserver');
  const lan = createLan({}); t.after(() => lan.teardown());
  const input = `http://localhost:${f.port}${f.filePath(0)}`;
  const issued = await new Promise(resolve => lan.serveDlna(input, 'video/mp4', resolve));
  assert.ok(issued, 'LAN interface required for this integration test');
  const u = new URL(issued);
  assert.match(u.pathname, /^\/dlna\/[0-9a-f]+\//);
  const range = await request(u.port, u.pathname, { Range: 'bytes=1048576-1048583' }, 'GET', u.hostname);
  assert.equal(range.status, 206); assert.deepEqual(range.body, Buffer.alloc(8, 42));
  assert.equal(range.headers['content-range'], `bytes 1048576-1048583/${f.length}`);
  const head = await request(u.port, u.pathname, {}, 'HEAD', u.hostname);
  assert.equal(head.status, 200); assert.equal(Number(head.headers['content-length']), f.length); assert.equal(head.body.length, 0);
  await assert.rejects(request(f.port, f.filePath(0), { Range: 'bytes=0-3' }, 'GET', u.hostname), { code: 'ECONNREFUSED' });
  assert.equal((await request(u.port, u.pathname.replace(/\/dlna\/[^/]+\//, '/dlna/deadbeef/'), {}, 'GET', u.hostname)).status, 404);
  lan.cancelActive();
  assert.equal((await request(u.port, u.pathname, {}, 'GET', u.hostname)).status, 404);
});

test('native AirPlay resolves a torrent through the token proxy', () => {
  const main = fs.readFileSync(path.join(appRoot, 'src/main/main.js'), 'utf8');
  const resolver = main.slice(main.indexOf('  function resolveCastable('), main.indexOf('  // Resolve the CHROMECAST'));
  const input = 'http://localhost:1234/webtorrent/' + 'a'.repeat(40) + '/movie.mp4';
  const issued = 'http://192.0.2.1:2345/dlna/secret/movie.mp4';
  const calls = [], results = [];
  const ctx = { loadGen: 1, AIRPLAY_4K: false, externalSubs: [], ctypeFor: () => 'video/mp4',
    lan: { avCompatible: () => true, lanAddress: () => '192.0.2.1', serveDlna: (url, type, cb) => { calls.push({ url, type }); cb(issued); } } };
  vm.createContext(ctx); vm.runInContext(resolver + '\nthis.resolve = resolveCastable;', ctx);
  ctx.resolve(input, url => results.push(url));
  assert.deepEqual(results, [issued]); assert.deepEqual(calls, [{ url: input, type: 'video/mp4' }]);
});

test('probed direct casts also use the token proxy and cancel pending registration', () => {
  const lanSource = fs.readFileSync(path.join(appRoot, 'src/main/lanserver.js'), 'utf8');
  const input = 'http://localhost:1234/webtorrent/' + 'a'.repeat(40) + '/movie.mp4';
  const results = [], registrations = [], probes = [];
  let disposed = 0;
  const ctx = { path, VIDEO_OK: new Set(['h264']), AUDIO_OK: new Set(['aac']),
    lanAddress: () => '192.0.2.1', probe: (_, cb) => { probes.push(cb); },
    serveDlna: (url, type, cb) => { registrations.push({ url, type, cb }); return () => disposed++; } };
  vm.createContext(ctx);
  vm.runInContext(lanSource.slice(lanSource.indexOf('  const directPreparations ='), lanSource.indexOf('  // Extract embedded text subtitle tracks')) + '\nthis.prepare = prepareCast;', ctx);
  const cancel = ctx.prepare(input, false, url => results.push(url));
  probes[0]({ vcodec: 'h264', acodec: 'aac' });
  assert.equal(registrations.length, 1); assert.equal(registrations[0].url, input);
  cancel(); registrations[0].cb('late-token-url');
  assert.equal(disposed, 1); assert.deepEqual(results, [null]);
  ctx.prepare(input, false, url => results.push(url));
  probes[1]({ vcodec: 'h264', acodec: 'aac' });
  registrations[1].cb('token-url');
  assert.deepEqual(results, [null, 'token-url']);
});
