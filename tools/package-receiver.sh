#!/bin/sh
# Package, install and launch the Spritz Receiver on a webOS television.
#
# DEVELOPMENT TOOLING. The receiver has no discovery yet, so the Mac's LAN address is written into
# webos-receiver/host.json at package time and the application reads it at startup. That file is
# gitignored on purpose: it is machine-specific state, and a committed address is the kind of thing
# that quietly becomes product configuration. Production wiring should replace it with real
# discovery (or an address the app is told), not with a checked-in default.
#
#   tools/package-receiver.sh [device]        default device: spritzTV
set -e
DEVICE="${1:-spritzTV}"
OUT="${TMPDIR:-/tmp}/spritz-receiver-pkg"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
[ -n "$IP" ] || { echo "no LAN address on en0/en1 — is Wi-Fi up?" >&2; exit 1; }

cd "$(dirname "$0")/.."
printf '{"host":"%s"}\n' "$IP" > webos-receiver/host.json
echo "baked host $IP"

mkdir -p "$OUT"
ares-package webos-receiver -o "$OUT" >/dev/null
ares-install -d "$DEVICE" "$OUT"/com.spritz.receiver_*_all.ipk | tail -1
# Close first: ares-launch on a running app brings it forward WITHOUT reloading, which silently
# tests the previous build. Measured during the VOD work; it wasted a hardware round.
ares-launch -d "$DEVICE" --close com.spritz.receiver >/dev/null 2>&1 || true
sleep 3
ares-launch -d "$DEVICE" com.spritz.receiver | tail -1
