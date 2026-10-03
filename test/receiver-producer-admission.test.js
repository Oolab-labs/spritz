'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
test('receiver producer registration rejects superseded generations and other source URLs', () => {
  let opts, registered = 0;
  const ctx = { loadGen: 1, mpvLastUrl: 'source-A', recordErr() {},
    torrent: { registerProducer: () => ++registered },
    require: () => options => { opts = options; return {}; } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function receiverTransportFor('), source.indexOf('  function receiverTimelineTransport(')) + '\nthis.create = receiverTransportFor;', ctx);
  ctx.create(); assert.equal(opts.registerSourceProducer('other'), null);
  assert.equal(opts.registerSourceProducer('source-A'), 1);
  ctx.loadGen++; assert.equal(opts.registerSourceProducer('source-A'), null);
  ctx.loadGen = 1; ctx.mpvLastUrl = 'source-B'; assert.equal(opts.registerSourceProducer('source-A'), null);
  assert.equal(registered, 1);
});
