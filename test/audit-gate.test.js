'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../build/audit-gate');

const vuln = (sev) => ({ severity: sev });
const accepted = { ip: { reason: 'server-only code path; no fixed release', reviewBy: '2027-01-01' } };
const NOW = new Date('2026-10-02');

test('no vulnerabilities passes', () => {
  assert.deepStrictEqual(evaluate({ vulnerabilities: {} }, {}, NOW).failures, []);
});

test('a moderate-or-worse advisory that is not accepted fails, naming the package and severity', () => {
  const r = evaluate({ vulnerabilities: { protobufjs: vuln('critical'), left: vuln('low') } }, {}, NOW);
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0], /protobufjs.*critical/);
});

test('an accepted advisory passes while its review date is in the future', () => {
  assert.deepStrictEqual(evaluate({ vulnerabilities: { ip: vuln('high') } }, accepted, NOW).failures, []);
});

test('an accepted advisory whose review date has passed fails, so exceptions cannot rot', () => {
  const r = evaluate({ vulnerabilities: { ip: vuln('high') } }, accepted, new Date('2027-02-01'));
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0], /ip.*review/i);
});

test('an exception for something that is no longer reported is flagged as stale (clean it up)', () => {
  const r = evaluate({ vulnerabilities: {} }, accepted, NOW);
  assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.stale.length, 1);
  assert.match(r.stale[0], /ip/);
});

test('every exception must carry a reason and a review date', () => {
  const r = evaluate({ vulnerabilities: { ip: vuln('high') } }, { ip: { reason: '' } }, NOW);
  assert.ok(r.failures.some((f) => /ip.*(reason|review)/i.test(f)));
});
