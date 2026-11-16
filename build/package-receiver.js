'use strict';

// Builds the Spritz Receiver .ipk that ships next to the Mac app (Contents/Resources/receiver/) and
// on the GitHub release.
//   node build/package-receiver.js        (needs LG's webOS CLI: `ares-package` on PATH)
//
// It packages a COPY of the git-tracked files only, so stray local files in webos-receiver/ can never
// be published. The flip side for development: a new receiver file is not in the .ipk until it has
// been `git add`ed.
//
// This is also the development loop, so a TV is tested with exactly the artifact that ships:
//   ares-install -d <device> dist-receiver/com.spritz.receiver_<version>_all.ipk
//   ares-launch -d <device> --close com.spritz.receiver; ares-launch -d <device> com.spritz.receiver
// Close first: ares-launch on a running app brings it forward WITHOUT reloading, which silently tests
// the previous build. Measured during the VOD work; it wasted a hardware round.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-receiver');

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z', 'webos-receiver'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

function main() {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'webos-receiver', 'appinfo.json'), 'utf8'));
  try { execFileSync('ares-package', ['--version'], { stdio: 'ignore' }); }
  catch (e) { console.error('ares-package not found. Install the webOS CLI (npm i -g @webos-tools/cli) and retry.'); process.exit(1); }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-receiver-'));
  try {
    for (const rel of trackedFiles()) {
      const dst = path.join(stage, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dst);
    }
    const app = path.join(stage, 'webos-receiver');
    execFileSync('ares-package', ['--check', app], { stdio: 'inherit' });
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync('ares-package', [app, '-o', OUT], { stdio: 'inherit' });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }

  const ipk = fs.readdirSync(OUT).find((f) => f.endsWith('.ipk'));
  if (!ipk) { console.error('no .ipk produced'); process.exit(1); }
  if (!ipk.includes('_' + info.version + '_')) { console.error('ipk name ' + ipk + ' does not carry version ' + info.version); process.exit(1); }
  console.log('receiver package: ' + path.join('dist-receiver', ipk));
}

if (require.main === module) main();
module.exports = { trackedFiles };
