'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
for (const change of ['none', 'same-source-replacement', 'stop', 'target-roundtrip']) {
  test(`resume result with ${change} respects its owner`, async () => {
    let finish; const offers = [];
    const ctx = { currentKey: '/A.mp4', sourceIntent: 1, playbackTargetIntent: 1, engine: 'mpv', resumeReady: false,
      st: { duration: 100 }, showResume: (pos) => offers.push(pos),
      soda: { history: { get: () => new Promise((resolve) => { finish = resolve; }) } } };
    ctx.subtitleOwner = () => ({ source: ctx.sourceIntent, target: ctx.playbackTargetIntent });
    ctx.ownsSubtitle = (owner) => owner.source === ctx.sourceIntent && owner.target === ctx.playbackTargetIntent;
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('async function maybeOfferResume()'), source.indexOf('let resumeOwner =')) + '\nthis.offer = maybeOfferResume;', ctx);
    const pending = ctx.offer();
    if (change === 'same-source-replacement' || change === 'stop') ctx.sourceIntent++;
    if (change === 'target-roundtrip') ctx.playbackTargetIntent += 2;
    finish({ pos: 40, dur: 100 }); await pending;
    assert.deepEqual(offers, change === 'none' ? [40] : []);
    assert.equal(ctx.resumeReady, change === 'none');
  });
}

for (const current of [true, false]) {
  test(`Resume button ${current ? 'accepts current' : 'rejects stale'} offer`, () => {
    let click; const seeks = [];
    const ctx = { resumeOwner: { source: 1 }, engine: 'mpv', st: {},
      ownsSubtitle: () => current, hideResume() {},
      resumeBtn: { dataset: { pos: '40' }, addEventListener: (_, fn) => { click = fn; } },
      soda: { player: { seek: (pos) => seeks.push(pos) } } };
    vm.runInNewContext(source.slice(source.indexOf("resumeBtn.addEventListener('click'"), source.indexOf('// ---- open / load / stop')), ctx);
    click(); assert.deepEqual(seeks, current ? [40] : []);
  });
}
