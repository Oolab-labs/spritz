'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const createLan = require('../src/main/lanserver');

async function fixture(t, fn, timeout = 2000) {
  const sockets = new Set();
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const upstream = http.createServer((req, res) => arrived({ req, res }));
  upstream.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const lan = createLan({ proxyHeaderTimeoutMs: timeout });
  try {
    const issued = await new Promise((resolve) => lan.serveDlna(`http://127.0.0.1:${upstream.address().port}/media`, 'video/mp4', resolve));
    if (!issued) return t.skip('no LAN address');
    const url = new URL(issued); url.hostname = '127.0.0.1';
    await fn({ url, lan, arrival });
  } finally {
    lan.teardown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

for (const method of ['GET', 'HEAD']) {
  test(`${method} pre-header request is retired on cancellation`, async (t) => {
    await fixture(t, async ({ url, lan, arrival }) => {
      const request = http.request(url, { method });
      const downstreamClosed = new Promise((resolve) => request.once('error', resolve));
      request.end();
      const { res } = await arrival;
      const upstreamClosed = new Promise((resolve) => res.once('close', resolve));
      lan.cancelActive();
      await Promise.all([downstreamClosed, upstreamClosed]);
      assert.ok(res.destroyed);
    });
  });
  test(`${method} teardown drains pending upstream requests`, async (t) => {
    await fixture(t, async ({ url, lan, arrival }) => {
      const request = http.request(url, { method });
      const ended = new Promise((resolve) => request.once('error', resolve));
      request.end();
      const { res } = await arrival;
      const closed = new Promise((resolve) => res.once('close', resolve));
      lan.teardown();
      await Promise.all([ended, closed]);
      assert.ok(res.destroyed);
    });
  });
  test(`${method} downstream disconnect releases a pre-header reader`, async (t) => {
    await fixture(t, async ({ url, arrival }) => {
      const request = http.request(url, { method });
      request.on('error', () => {}); request.end();
      const { res } = await arrival;
      const closed = new Promise((resolve) => res.once('close', resolve));
      request.destroy();
      await closed;
      assert.ok(res.destroyed);
    });
  });
}

test('header deadline retires the upstream and answers 504', async (t) => {
  await fixture(t, async ({ url, arrival }) => {
    const response = new Promise((resolve, reject) => {
      http.get(url, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    const { res } = await arrival;
    const closed = new Promise((resolve) => res.once('close', resolve));
    assert.equal(await response, 504);
    await closed;
  }, 100);
});

test('slow valid bodies survive the header deadline but cancel drains them', async (t) => {
  await fixture(t, async ({ url, lan, arrival }) => {
    let response;
    const opened = new Promise((resolve, reject) => {
      http.get(url, (res) => { response = res; res.on('error', () => {}); res.resume(); resolve(); }).on('error', reject);
    });
    const { res } = await arrival;
    res.writeHead(200, { 'Content-Length': 100 }); res.write('a');
    await opened;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(response.destroyed, false);
    const closed = new Promise((resolve) => res.once('close', resolve));
    lan.cancelActive(); await closed;
    assert.ok(res.destroyed);
  }, 100);
});
