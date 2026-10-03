'use strict';

// Fails when the shipped (production) dependencies carry an advisory we have not looked at.
//   node build/audit-gate.js       (needs network: it asks the npm advisory service)
//
// `npm audit` alone is all-or-nothing, and its "fix" for a transitive chain can be nonsense (it once proposed
// downgrading webtorrent three major versions). So: anything moderate or worse must either be fixed or be
// listed in .audit-accepted.json with a reason and a review date. Exceptions expire, and an exception for
// something no longer reported is flagged so the list cannot rot.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// Pure: easy to test without a network.
function evaluate(audit, accepted, now) {
  const failures = [], stale = [], seen = new Set();
  for (const [name, v] of Object.entries((audit && audit.vulnerabilities) || {})) {
    if ((RANK[v.severity] || 0) < RANK.moderate) continue;
    seen.add(name);
    const ex = accepted[name];
    if (!ex) { failures.push(`${name} (${v.severity}): not fixed and not accepted`); continue; }
    if (!ex.reason || !ex.reviewBy) { failures.push(`${name}: its exception needs both a reason and a reviewBy date`); continue; }
    if (new Date(ex.reviewBy) < now) failures.push(`${name}: the exception's review date ${ex.reviewBy} has passed — re-assess it`);
  }
  for (const name of Object.keys(accepted)) if (!seen.has(name)) stale.push(`${name}: accepted but no longer reported; remove it from .audit-accepted.json`);
  return { failures, stale };
}

function main() {
  const root = path.join(__dirname, '..');
  const accepted = JSON.parse(fs.readFileSync(path.join(root, '.audit-accepted.json'), 'utf8')).accepted || {};
  let out;
  try { out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 20e6 }); }
  catch (e) { out = e.stdout; }          // npm audit exits non-zero when it finds anything; the JSON is still on stdout
  const r = evaluate(JSON.parse(out), accepted, new Date());
  r.stale.forEach((s) => console.warn('stale: ' + s));
  if (r.failures.length) { r.failures.forEach((f) => console.error('✗ ' + f)); process.exit(1); }
  console.log('audit gate: no unreviewed advisories (' + Object.keys(accepted).length + ' accepted exceptions)');
}

if (require.main === module) main();
module.exports = { evaluate };
