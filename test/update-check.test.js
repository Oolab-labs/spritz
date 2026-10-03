'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/main/update-check');

// UI audit P1-U: no update mechanism, so users sat on whatever they installed. This is deliberately NOT an
// auto-updater and NOT a background check: it runs only when the person chooses Help > Check for Updates,
// asks GitHub's public releases list, and opens the release page. Nothing is downloaded or installed.
const rel = (tag, extra = {}) => Object.assign({ tag_name: tag, html_url: 'https://github.com/Oolab-labs/spritz/releases/tag/' + tag, draft: false, prerelease: /-/.test(tag), body: 'notes' }, extra);

test('versions compare numerically and prereleases sort below their release', () => {
  const c = U.compareVersions;
  assert.ok(c('2.0.0-rc.10', '2.0.0-rc.9') > 0, 'rc.10 is newer than rc.9 (not a string compare)');
  assert.ok(c('2.0.0', '2.0.0-rc.99') > 0);
  assert.ok(c('2.1.0-rc.1', '2.0.9') > 0);
  assert.strictEqual(c('v2.0.0-rc.7', '2.0.0-rc.7'), 0, 'a leading v is ignored');
  assert.ok(c('2.0.0-alpha.0', '2.0.0-rc.1') < 0);
  assert.ok(c('2.0.0-rc.7', '2.0.0-rc.6') > 0);
});

test('unparseable versions never count as newer', () => {
  assert.strictEqual(U.compareVersions('garbage', '2.0.0'), null);
  assert.strictEqual(U.compareVersions('2.0.0', ''), null);
});

test('a newer release is reported with its page', () => {
  const r = U.pickNewer([rel('v2.0.0-rc.8'), rel('v2.0.0-rc.7')], '2.0.0-rc.7');
  assert.strictEqual(r.status, 'newer'); assert.strictEqual(r.version, '2.0.0-rc.8');
  assert.match(r.url, /^https:\/\/github\.com\/Oolab-labs\/spritz\/releases/);
});

test('being up to date, or ahead of the newest published release, is "current"', () => {
  assert.strictEqual(U.pickNewer([rel('v2.0.0-rc.7')], '2.0.0-rc.7').status, 'current');
  assert.strictEqual(U.pickNewer([rel('v2.0.0-rc.5')], '2.0.0-rc.7').status, 'current');
  assert.strictEqual(U.pickNewer([], '2.0.0-rc.7').status, 'current');
});

test('drafts are never offered; stable builds are not nudged toward prereleases', () => {
  assert.strictEqual(U.pickNewer([rel('v2.0.0-rc.9', { draft: true })], '2.0.0-rc.7').status, 'current');
  assert.strictEqual(U.pickNewer([rel('v2.1.0-rc.1')], '2.0.0').status, 'current', 'a stable user is not pushed onto a prerelease');
  assert.strictEqual(U.pickNewer([rel('v2.1.0')], '2.0.0').status, 'newer');
});

test('the release URL must be an https GitHub releases page of this repo, or it is dropped', () => {
  const evil = U.pickNewer([rel('v9.9.9', { html_url: 'https://evil.example/releases/v9.9.9' })], '2.0.0-rc.7');
  assert.strictEqual(evil.status, 'newer');
  assert.strictEqual(evil.url, 'https://github.com/Oolab-labs/spritz/releases');
  const js = U.pickNewer([rel('v9.9.9', { html_url: 'javascript:alert(1)' })], '2.0.0-rc.7');
  assert.strictEqual(js.url, 'https://github.com/Oolab-labs/spritz/releases');
});

test('check() maps a successful fetch, a malformed reply and a failure to distinct results', async () => {
  assert.strictEqual((await U.check({ current: '2.0.0-rc.7', fetchJson: async () => [rel('v2.0.0-rc.8')] })).status, 'newer');
  assert.strictEqual((await U.check({ current: '2.0.0-rc.7', fetchJson: async () => ({ message: 'rate limited' }) })).status, 'error');
  const e = await U.check({ current: '2.0.0-rc.7', fetchJson: async () => { throw new Error('offline'); } });
  assert.strictEqual(e.status, 'error'); assert.match(e.message, /offline/);
});

test('the request is a single public GitHub API call with no identifiers', () => {
  const req = U.request('2.0.0-rc.7');
  assert.strictEqual(req.hostname, 'api.github.com');
  assert.strictEqual(req.path, '/repos/Oolab-labs/spritz/releases?per_page=20');
  assert.deepStrictEqual(Object.keys(req.headers).sort(), ['Accept', 'User-Agent']);
  assert.strictEqual(req.headers['User-Agent'], 'Spritz/2.0.0-rc.7');
});
