'use strict';

// Assemble the licence texts that ship inside the app (Contents/Resources/licenses). The app conveys GPL
// binaries and Chromium, whose licences have to travel with it. Output: dist-licenses/ (not committed).
//   node build/collect-licenses.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderNpmLicenses } = require('./licenses');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-licenses');

function must(file, label) {
  if (!fs.existsSync(file)) { console.error(`collect-licenses: ${label} not found at ${file}`); process.exit(1); }
  return file;
}

function licenceFile(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const pick = names.find((n) => /^(licen[sc]e|copying|unlicen[sc]e)(\.(md|txt|markdown))?$/i.test(n));
  if (!pick) return null;
  try { return fs.readFileSync(path.join(dir, pick), 'utf8'); } catch (e) { return null; }
}

function declaredLicense(pj) {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && pj.license.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => l.type || l).join(' OR ');
  return null;
}

// Every production package that is actually installed, once per name@version.
function productionPackages() {
  // `npm ls` exits non-zero for any complaint (an optional peer that is not installed, say) while still
  // printing the whole tree, so a failure exit is not a failure to read it.
  let raw;
  try {
    raw = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { raw = e.stdout; }
  if (!raw) { console.error('collect-licenses: npm ls produced no output'); process.exit(1); }
  const tree = JSON.parse(raw);
  const seen = new Map();
  // Resolve each package the way node does: its own nested node_modules first, then up toward the root. The
  // `path` npm prints is not used: npm masks anything in its output that looks like a token, and a build
  // directory can contain such a string.
  const resolveDir = (name, parentDir) => {
    for (let dir = parentDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (dir === ROOT || dir === path.dirname(dir)) return null;
    }
  };
  (function walk(deps, parentDir) {
    for (const [name, d] of Object.entries(deps || {})) {
      const dir = resolveDir(name, parentDir);
      if (!dir) continue; // optional and not installed
      let pj = null;
      try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { /* unreadable */ }
      if (pj) {
        const key = pj.name + '@' + pj.version;
        if (!seen.has(key)) seen.set(key, { name: pj.name, version: pj.version, license: declaredLicense(pj), text: licenceFile(dir) });
      }
      walk(d.dependencies, dir);
    }
  })(tree.dependencies, ROOT);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(must(path.join(ROOT, 'LICENSE'), 'LICENSE'), path.join(OUT, 'LICENSE'));
  fs.copyFileSync(must(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'), path.join(OUT, 'THIRD_PARTY_NOTICES.md'));
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  fs.copyFileSync(must(path.join(dist, 'LICENSE'), 'Electron LICENSE'), path.join(OUT, 'ELECTRON-LICENSE'));
  fs.copyFileSync(must(path.join(dist, 'LICENSES.chromium.html'), 'LICENSES.chromium.html'), path.join(OUT, 'LICENSES.chromium.html'));
  const pkgs = productionPackages();
  fs.writeFileSync(path.join(OUT, 'npm-licenses.txt'), renderNpmLicenses(pkgs));
  console.log(`licences collected: ${pkgs.length} npm packages, Electron, Chromium, GPL, notices → dist-licenses/`);
}

if (require.main === module) main();
module.exports = { productionPackages, licenceFile, declaredLicense };
