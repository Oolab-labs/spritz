'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { PassThrough } = require('stream');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function pipeFile('), source.indexOf('const REMUX_DIR')), ctx);
test('response error closes its file reader even before response close arrives', () => {
  const response = new PassThrough(), reader = new PassThrough();
  ctx.pipeFile(response, reader);
  assert.doesNotThrow(() => response.emit('error', new Error('socket failed')));
  assert.equal(reader.destroyed, true);
  response.emit('close'); response.emit('error', new Error('late socket error'));
  assert.equal(reader.destroyed, true); response.destroy();
});
test('file reader failure destroys the response and remains handled after teardown', () => {
  const response = new PassThrough(), reader = new PassThrough();
  ctx.pipeFile(response, reader);
  reader.emit('error', new Error('disk failed'));
  assert.equal(reader.destroyed, true); assert.equal(response.destroyed, true);
  assert.doesNotThrow(() => response.emit('error', new Error('late response error')));
});
