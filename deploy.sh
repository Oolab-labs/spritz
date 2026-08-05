#!/bin/bash
# Deploy the source tree into the installed .app and re-sign it.
#
# Why this exists: the repo used to live INSIDE /Applications/Spritz.app/Contents/Resources/app.
# That put .git and other untracked files inside a signed bundle, so every edit broke the code
# signature seal. A broken seal means macOS stops honouring the app's TCC grants — which is what
# silently denied Local Network access and made cast discovery fail with an instant EHOSTUNREACH
# while System Settings still showed the permission as enabled. It also blocks notarization.
#
# Now: this repo is the source of truth, the .app is a build artifact. Edit here, run ./deploy.sh.
#
# What stays in the bundle and is NOT copied from here:
#   node_modules/            (installed into the bundle; large, gitignored)
#   native/*/build/          (compiled .node addons — built against the bundled Electron ABI)
#   ../bin/, ../../Frameworks/, etc.  (ffmpeg, Electron itself)
set -euo pipefail

APP="${SPRITZ_APP:-/Applications/Spritz.app}"
DEST="$APP/Contents/Resources/app"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$DEST" ] || { echo "error: $DEST not found (set SPRITZ_APP to override)"; exit 1; }

echo "deploying $SRC -> $DEST"
# Only the things the app actually runs. Deliberately NOT --delete: the bundle legitimately holds
# node_modules and native build outputs that do not exist here.
rsync -a --exclude '.git' --exclude '.github' --exclude 'test' --exclude 'deploy.sh' \
      "$SRC/src/" "$DEST/src/"
rsync -a "$SRC/package.json" "$DEST/package.json"
[ -d "$SRC/vendor" ] && rsync -a "$SRC/vendor/" "$DEST/vendor/"
# Native SOURCE only — build outputs stay in the bundle, they are ABI-bound to its Electron.
for d in "$SRC"/native/*/; do
  n="$(basename "$d")"
  [ -d "$DEST/native/$n" ] || continue
  rsync -a --exclude 'build' "$d" "$DEST/native/$n/"
done

echo "re-signing $APP"
codesign --force --deep --sign - "$APP"
codesign -v "$APP" && echo "signature valid"

echo
echo "done. If casting stops working, macOS may have dropped the Local Network grant when the"
echo "signature changed — toggle it off/on in System Settings > Privacy & Security > Local Network."
