#!/bin/sh
# packed-pty-smoke.sh [<tgz-or-version>]
# The release ceremony's "packed PTY smoke": an interactive PTY session on
# the PACKED cli artifact (never the published one — publish is a HOLD'd
# action; the E2-round shape). Assertions, all on the PTY capture:
#   1. the banner reads the expected version (v0.4.0 by default),
#   2. the built-ins render (the /help list — the E5 banner's 8 columns),
#   3. the session exits cleanly.
# The environment: a FRESH KISO_HOME (the E2 lesson — never reuse), the
# installed bin from the packed tarball.
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
VERSION=${EXPECTED_BANNER:-v0.4.0}
SRC=${1:-}
TMP=$(mktemp -d /tmp/e6-pty.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

if [ -n "$SRC" ]; then
  # an explicit tarball (or a published name) — install it
  mkdir -p "$TMP/proj"; cd "$TMP/proj"
  npm init -y > /dev/null 2>&1
  npm install --no-audit --no-fund "$SRC" > /dev/null 2>&1
  BIN="$TMP/proj/node_modules/.bin/kiso"
else
  # pack the tree's cli AND its runtime — the cli pins the runtime at the
  # exact new version (0.3.0), which is NOT on the registry while publish
  # is a HOLD'd action; the runtime tarball installs first so the pin
  # resolves locally (the smoke.mjs closure pattern, never a registry
  # fetch of an unpublished version). The other eleven pins are the
  # published 0.2.0 line and come from the registry.
  TGZ_RT=$(npm pack -w @vincemakes/kiso-runtime --pack-destination "$TMP" 2>/dev/null | tail -1)
  TGZ=$(npm pack -w @vincemakes/kiso-code --pack-destination "$TMP" 2>/dev/null | tail -1)
  mkdir -p "$TMP/proj"; cd "$TMP/proj"
  npm init -y > /dev/null 2>&1
  npm install --no-audit --no-fund "$TMP/$TGZ_RT" > /dev/null 2>&1
  npm install --no-audit --no-fund "$TMP/$TGZ" > /dev/null 2>&1
  BIN="$TMP/proj/node_modules/.bin/kiso"
fi

export KISO_HOME="$TMP/home"
# macOS ships no `timeout` — the perl-alarm wrapper is the standard
# substitute: a hung chat dies to SIGALRM (rc 142) and FAILs the smoke.
printf '/help\nexit\n' | perl -e 'alarm 120; exec @ARGV' script -q "$TMP/capture" "$BIN" chat > /dev/null 2>&1
RC=$?
CAP="$TMP/capture"
grep -q "$VERSION" "$CAP" && echo "PASS banner: $VERSION" || { echo "FAIL banner: expected $VERSION"; exit 1; }
grep -qi "help" "$CAP" && echo "PASS built-ins render" || { echo "FAIL built-ins"; exit 1; }
[ "$RC" -eq 0 ] && echo "PASS clean exit (rc=0, capture tail: $(tail -1 "$CAP" | tr -d '\r' | cut -c1-40))" \
  || { echo "FAIL clean exit: rc=$RC"; exit 1; }
