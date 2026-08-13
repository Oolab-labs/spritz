#!/bin/bash
# Make Mach-O binaries self-contained by copying their Homebrew dylib dependencies next to them
# and rewriting the install names to @executable_path/lib.
#
# Why this exists: the bundled ffmpeg/ffprobe are built against Homebrew libraries. Left alone they
# would only run on a machine that has the same Homebrew formulae installed at the same prefix —
# fine here, useless for anyone else, and silently broken the moment `brew upgrade` bumps a soname.
# The bundle already shipped relocated dylibs, but the relocation had been done by hand and no
# script existed, so it could not be reproduced or audited. This is that script.
#
# Usage:  build/bundle-dylibs.sh <staging-dir> <binary> [binary...]
#   e.g.  build/bundle-dylibs.sh /tmp/stage ./ffmpeg ./ffprobe
# Produces <staging-dir>/{binaries...,lib/} ready to drop into Contents/Resources/bin.
#
# Signing: rewriting a load command invalidates any existing signature, so every file is re-signed
# ad-hoc here. The .app itself must still be re-signed afterwards (deploy.sh does that).
#
# Written for the bash macOS actually ships (3.2) — no associative arrays, no mapfile.
set -euo pipefail

PREFIX='/opt/homebrew'   # only relocate Homebrew libs; system dylibs stay where they are

[ $# -ge 2 ] || { echo "usage: $0 <staging-dir> <binary> [binary...]" >&2; exit 1; }
STAGE="$1"; shift
LIBDIR="$STAGE/lib"
mkdir -p "$LIBDIR"

# Direct Homebrew dependencies of one Mach-O file.
deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep "^$PREFIX" || true; }

for b in "$@"; do
  [ -f "$b" ] || { echo "error: no such binary: $b" >&2; exit 1; }
  cp -f "$b" "$STAGE/$(basename "$b")"
  chmod u+w "$STAGE/$(basename "$b")"
done

# Walk the dependency closure, following dylib-to-dylib edges. SEEN is a newline-delimited list of
# basenames; bash 3.2 has no sets, and the closure is ~20 entries so linear lookup is irrelevant.
SEEN=""
QUEUE="$(for b in "$@"; do echo "$STAGE/$(basename "$b")"; done)"
while [ -n "$QUEUE" ]; do
  cur="$(printf '%s\n' "$QUEUE" | head -1)"
  QUEUE="$(printf '%s\n' "$QUEUE" | tail -n +2)"
  [ -n "$cur" ] || continue
  for dep in $(deps_of "$cur"); do
    base="$(basename "$dep")"
    case "
$SEEN" in *"
$base
"*) continue ;; esac
    SEEN="$SEEN$base
"
    cp -f "$dep" "$LIBDIR/$base"
    chmod u+w "$LIBDIR/$base"
    QUEUE="$QUEUE
$LIBDIR/$base"
  done
done

count="$(printf '%s' "$SEEN" | grep -c . || true)"
echo "collected $count dylibs into $LIBDIR"

# Rewrite install names. Each copied dylib gets an id of @executable_path/lib/<name>, and every
# reference to a relocated lib — from the binaries AND from the other libs — is repointed at it.
retarget() {
  for dep in $(deps_of "$1"); do
    install_name_tool -change "$dep" "@executable_path/lib/$(basename "$dep")" "$1"
  done
}

for base in $SEEN; do
  install_name_tool -id "@executable_path/lib/$base" "$LIBDIR/$base"
  retarget "$LIBDIR/$base"
done
for b in "$@"; do retarget "$STAGE/$(basename "$b")"; done

# Re-sign: the rewrites above invalidate whatever signature each file carried.
for f in "$LIBDIR"/*.dylib; do codesign --force --sign - "$f" >/dev/null 2>&1 || true; done
for b in "$@"; do codesign --force --sign - "$STAGE/$(basename "$b")" >/dev/null 2>&1 || true; done

# Verify nothing still points outside the bundle.
leaks=0
for f in "$STAGE"/* "$LIBDIR"/*.dylib; do
  [ -f "$f" ] || continue
  if [ -n "$(deps_of "$f")" ]; then
    echo "LEAK: $f still references Homebrew:" >&2
    deps_of "$f" | sed 's/^/    /' >&2
    leaks=1
  fi
done
[ "$leaks" -eq 0 ] || { echo "error: unrelocated references remain" >&2; exit 1; }

echo "ok — $STAGE is self-contained"
