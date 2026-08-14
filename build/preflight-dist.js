'use strict';

// Refuse to package something that cannot run on another Mac.
//
// The build config was wrong for a long time and nothing noticed, because a broken package is not a
// broken build: electron-builder happily produces a .dmg with no ffmpeg in it, and an addon still
// linked to /opt/homebrew works perfectly on the machine that built it. The failure is only visible
// to whoever opens it somewhere else, by which point it is a mystery crash on launch.
//
// So the inputs are checked before packaging rather than after shipping. Everything here is a fact
// about a file on disk — nothing is inferred, and every failure names the README step that fixes it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Does a Mach-O file still reference libraries that only exist on this machine? build/bundle-dylibs.sh
// rewrites these; a binary that skipped it launches here and nowhere else.
function homebrewRefs(file) {
  try {
    const out = execFileSync('otool', ['-L', file], { encoding: 'utf8', timeout: 20000 });
    return out.split('\n').slice(1).map((l) => l.trim().split(' ')[0]).filter((l) => l.startsWith('/opt/homebrew'));
  } catch (e) {
    return []; // not Mach-O, or no otool — not this check's business to fail on
  }
}

// Returns a list of problems, each { what, fix }. Empty means ready to package.
// `root` is injectable so this is testable against a fixture rather than only the real tree.
function check(root) {
  const problems = [];
  const at = (...p) => path.join(root, ...p);
  const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };

  // The media binaries. build.extraResources copies bin/ to Contents/Resources/bin, which is where
  // binPath() looks at runtime; without it the app has no ffmpeg, ffprobe or yt-dlp at all.
  for (const name of ['ffmpeg', 'ffprobe']) {
    const p = at('bin', name);
    if (!exists(p)) {
      problems.push({
        what: `bin/${name} is missing — the package would ship without it`,
        fix: 'Build it and place it in bin/ (README: "The bundled ffmpeg is not Homebrew\'s")'
      });
      continue;
    }
    const leaks = homebrewRefs(p);
    if (leaks.length) {
      problems.push({
        what: `bin/${name} still links ${leaks.length} Homebrew librar${leaks.length === 1 ? 'y' : 'ies'} (${path.basename(leaks[0])}…)`,
        fix: `./build/bundle-dylibs.sh /tmp/ffstage bin/ffmpeg bin/ffprobe, then copy the result back over bin/`
      });
    }
  }

  // The native addons, and the libmpv the player cannot start without.
  const addons = [];
  const nativeDir = at('native');
  if (exists(nativeDir)) {
    for (const mod of fs.readdirSync(nativeDir)) {
      const p = at('native', mod, 'build', 'Release');
      if (!exists(p)) continue;
      for (const f of fs.readdirSync(p)) if (f.endsWith('.node')) addons.push(path.join(p, f));
    }
  }
  if (!addons.length) {
    problems.push({ what: 'no compiled native addons found under native/*/build/Release', fix: 'npm run rebuild' });
  }
  for (const a of addons) {
    const leaks = homebrewRefs(a);
    if (leaks.length) {
      problems.push({
        what: `${path.relative(root, a)} links ${path.basename(leaks[0])} from Homebrew — it will not load on another Mac`,
        fix: `./build/bundle-dylibs.sh /tmp/stage ${path.relative(root, a)} && cp -R /tmp/stage/ ${path.relative(root, path.dirname(a))}/`
      });
    }
  }

  // Signing inputs. Packaging without these produces something Gatekeeper will refuse.
  if (!exists(at('build', 'entitlements.mac.plist'))) {
    problems.push({ what: 'build/entitlements.mac.plist is missing', fix: 'restore it — hardened runtime needs it' });
  }

  return problems;
}

module.exports = { check, homebrewRefs };

if (require.main === module) {
  const problems = check(ROOT);
  if (!problems.length) {
    console.log('preflight: ready to package');
    process.exit(0);
  }
  console.error(`\npreflight: refusing to package — ${problems.length} problem${problems.length === 1 ? '' : 's'} that would only show up on someone else\'s Mac:\n`);
  for (const p of problems) console.error(`  ✗ ${p.what}\n    → ${p.fix}\n`);
  process.exit(1);
}
