'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeTorrentReads } = require('../src/main/torrent-read-diagnostics');
test('range telemetry observes progress and retires once without exposing source or credentials', () => {
  const server = new EventEmitter(), rows = []; let tick, cleared = 0, time = 0;
  observeTorrentReads(server, { log: r => rows.push(r), now: () => time, schedule: fn => { tick = fn; return 1; }, clear: () => cleared++ });
  const res = new EventEmitter(); res.socket = { bytesWritten: 100 }; res.statusCode = 206;
  server.emit('request', { url: '/private/movie?token=secret', headers: { range: 'bytes=4096-', 'user-agent': 'Lavf/62', authorization: 'secret' }, socket: { remotePort: 50000 } }, res);
  time = 2000; res.socket.bytesWritten = 4196; res.headersSent = true; tick();
  assert.equal(rows[1].connectionBytesWrittenDelta, 4096); assert.equal(rows[1].rangeStart, 4096);
  res.writableFinished = true; res.emit('finish'); res.emit('close');
  assert.equal(cleared, 1); assert.equal(rows.length, 3); assert.equal(rows[2].event, 'finished');
  assert.equal(JSON.stringify(rows).includes('secret'), false); assert.equal(JSON.stringify(rows).includes('private'), false);
});
test('malformed range values cannot inject raw text into telemetry', () => {
  const server = new EventEmitter(), rows = [];
  observeTorrentReads(server, { log: r => rows.push(r), schedule: () => 1, clear() {} });
  const res = new EventEmitter(); server.emit('request', { headers: { range: 'private-secret' }, socket: {} }, res);
  res.emit('close'); assert.equal(rows[0].rangeStart, null); assert.equal(rows[1].event, 'closed');
  assert.equal(JSON.stringify(rows).includes('private-secret'), false);
});
