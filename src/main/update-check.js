'use strict';

// "Check for Updates", on request only.
//
// This is deliberately NOT an auto-updater and NOT a background check: Spritz makes no network request of its
// own accord, and that is a promise worth keeping. It runs when the person chooses Help > Check for Updates,
// asks GitHub's public releases list (no account, no identifiers beyond a generic User-Agent), and opens the
// release page. Nothing is downloaded or installed. The pure parts are unit-tested; the HTTP call is injected.
const https = require('https');

const REPO = 'Oolab-labs/spritz';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';

// semver-ish: 2.0.0-rc.7 -> {core:[2,0,0], pre:['rc',7]}; a release (no prerelease) sorts above its prereleases.
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null };
}

function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p > q ? 1 : -1;
    if (typeof p === 'number') return -1;     // numeric identifiers sort below alphanumeric ones
    if (typeof q === 'number') return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

// Only ever hand the UI a link that is an https page of THIS repo's releases; anything else becomes the generic page.
function safeUrl(u) {
  return typeof u === 'string' && u.startsWith('https://github.com/' + REPO + '/releases') ? u : RELEASES_PAGE;
}

function pickNewer(releases, current) {
  const stableUser = parse(current) && !parse(current).pre;
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft) continue;
    const v = parse(r.tag_name);
    if (!v) continue;
    if (v.pre && stableUser) continue;                       // do not nudge a stable build onto a prerelease
    const vs = compareVersions(r.tag_name, current);
    if (vs === null || vs <= 0) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  if (!best) return { status: 'current' };
  return { status: 'newer', version: String(best.tag_name).replace(/^v/, ''), url: safeUrl(best.html_url), notes: String(best.body || '').slice(0, 600) };
}

function request(version) {
  return { hostname: 'api.github.com', path: '/repos/' + REPO + '/releases?per_page=20', method: 'GET',
    headers: { 'User-Agent': 'Spritz/' + version, Accept: 'application/vnd.github+json' } };
}

function fetchJson(req, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const r = https.request(req, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) { r.destroy(new Error('reply too large')); } });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('unreadable reply')); } });
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error('timed out')));
    r.on('error', reject);
    r.end();
  });
}

async function check({ current, fetchJson: fj = (req) => fetchJson(req) } = {}) {
  try {
    const data = await fj(request(current));
    if (!Array.isArray(data)) return { status: 'error', message: (data && data.message) || 'unexpected reply from GitHub' };
    return pickNewer(data, current);
  } catch (e) { return { status: 'error', message: e.message || 'could not reach GitHub' }; }
}

module.exports = { compareVersions, pickNewer, check, request, RELEASES_PAGE };
