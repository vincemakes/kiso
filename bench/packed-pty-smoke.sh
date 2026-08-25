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
# CR, not LF: the multiline composer submits on \r; \n only inserts a
# line break (the KC1 driver supersession — this harness was the one
# file the 31-file \n→\r sweep missed, caught at the 0.13.0 ceremony).
# The sleeps pace input past TUI mount so submissions hit a wired
# dispatcher, and settle each command before the next.
(sleep 2; printf '/help\r'; sleep 3; printf 'exit\r'; sleep 5) \
  | perl -e 'alarm 120; exec @ARGV' script -q "$TMP/capture" "$BIN" chat > /dev/null 2>&1
RC=$?
CAP="$TMP/capture"
grep -q "$VERSION" "$CAP" && echo "PASS banner: $VERSION" || { echo "FAIL banner: expected $VERSION"; exit 1; }
# /compact is asserted (not "help"): the typed "/help" echoes into the
# capture, so only a command NEVER typed proves the help list rendered.
grep -q "/compact" "$CAP" && echo "PASS built-ins render" || { echo "FAIL built-ins"; exit 1; }
[ "$RC" -eq 0 ] && echo "PASS clean exit (rc=0, capture tail: $(tail -1 "$CAP" | tr -d '\r' | cut -c1-40))" \
  || { echo "FAIL clean exit: rc=$RC"; exit 1; }

# ── RD1B-F9 regression: two launches are two sessions ────────────────
# Two launches with NO explicit id, into the SAME fresh KISO_HOME, must
# not share a durable log. Each types a prompt, because a run-less
# session never appends (bare `exit` and `/help` create no log at all —
# the store's lock and jsonl are acquired lazily, by design). An earlier
# draft of this gate asserted on two `exit`-only launches and would have
# passed on a broken build by finding zero logs on both sides.
#
# This gate exists because neither smoke could see F9: the run above
# launches once, and scripts/smoke.mjs uses an explicit id (`cli-smoke`),
# so the generator was never exercised twice. The defect shipped through
# both.
#
# It runs against the PACKED artifact deliberately — an id change is
# exactly the class of thing a local dist can get right and a published
# tarball wrong, and this round already paid once for trusting a local
# build (the RD-1B evidence-tier gap).
for n in 1 2; do
  (sleep 2; printf 'hello\r'; sleep 4; printf 'exit\r'; sleep 3) \
    | perl -e 'alarm 120; exec @ARGV' script -q "$TMP/f9-$n" "$BIN" chat > /dev/null 2>&1
done
LOGS=$(find "$KISO_HOME/sessions" -maxdepth 1 -name '*.jsonl' | wc -l | tr -d ' ')
[ "$LOGS" -ge 2 ] \
  && echo "PASS session identity: $LOGS distinct durable logs from 2 launches" \
  || { echo "FAIL session identity (RD1B-F9): 2 launches produced $LOGS durable log(s) — a run-less launch logs nothing, so 0 here means the gate did not observe; 1 means the second inherited the first's history"; exit 1; }
