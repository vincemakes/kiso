#!/bin/sh
# run-t5-e6.sh <arm: baseline|auto|drop> <run-id>
# E6 crux (the 2026-08-14 order): three T5 arms at n=3, the same durable-
# session protocol as run-t5.sh, differing ONLY in the compression
# mechanism. KISO_ROUND=e6-crux scopes the runs.
#   baseline — the historical 3-process shape: turns 1-5, the manual
#              /compact line, turns 6-8 (the E5 baseline arm).
#   auto     — the 2-process shape (turns 1-5, 6-8, NO /compact line) with
#              KISO_POLICY_SUMMARY_TRIGGER: the policy fires at the turn-6
#              run's start, covering turns 1-3 (keepRounds=2 keeps 4-5 —
#              the pre-registered turn 3-4 crossing).
#   drop     — the same shape as auto with KISO_POLICY_DROP=1: the
#              mechanical arm — the covered turns leave the sent context
#              at ZERO generation cost (the placeholder, no summary call).
# Pre-registered verdict: drop all verify=pass → C wins (a summary is an
# unnecessary mechanism, max delta); drop fails and auto passes → A wins
# (the summary is real insurance); both fail → the trigger is too
# aggressive, reopen with a more conservative A+B (fires less).
set -eu
ARM=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
# KISO_BIN defaults to the TREE dist, never the PATH `kiso` — the crux
# arms REQUIRE the E6 policy code, and the PATH bin on this machine is a
# stale published 1.0.0 (no policy, no trace ledger — the 2026-08-14
# botched-round root cause). An explicit override stays honored.
KISO_BIN=${KISO_BIN:-node "$B/../apps/cli/dist/index.js"}
KISO_VERSION=${KISO_VERSION:-$(node -p "require('$B/../apps/cli/package.json').version")}
KISO_ROUND=${KISO_ROUND:-e6-crux}
# The trigger: calibrated 2026-08-14 by probe-projected.mjs over TWO
# process-1 sessions (thin/fat). Per-boundary projections at the turn-5
# start (after 1-4): 1037/1190; at the turn-6 start (after 1-5):
# 1598/2508. The gap's widest stable placement is 1300: fires at the
# turn-6 start in both samples (keepRounds=2 keeps turns 4-5: the
# pre-registered turn 3-4 crossing) and never earlier. Run-to-run
# variance beyond the samples may land one boundary earlier/later — the
# verdict path is unchanged (one run-start fire, >=2 covered, >=2 kept).
KISO_POLICY_SUMMARY_TRIGGER=${KISO_POLICY_SUMMARY_TRIGGER:-1300}
WORK="$B/runs/$KISO_ROUND/$ARM-T5-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-t5/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
TOT=0
cd "$WORK/repo"
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t5.json','utf8'))[$1-1])"; }
EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
KENV="OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=$DEEPSEEK_API_KEY OPENAI_MODEL=deepseek-v4-flash KISO_EXTENSIONS_DIR=$EXTDIR KISO_HOME=$WORK/kiso-home"
SID="bench-t5e6-$ARM-$RUN"
case "$ARM" in
  baseline)
    S=$(date +%s)
    printf '%s\n' "$(TURN 1)" "$(TURN 2)" "$(TURN 3)" "$(TURN 4)" "$(TURN 5)" |
      env $KENV $KISO_BIN --mode bypass "$SID" > "$WORK/stdout-1.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    S=$(date +%s)
    printf '/compact\n' |
      env $KENV $KISO_BIN --mode bypass "$SID" > "$WORK/stdout-2.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    S=$(date +%s)
    printf '%s\n' "$(TURN 6)" "$(TURN 7)" "$(TURN 8)" |
      env $KENV $KISO_BIN --mode bypass "$SID" > "$WORK/stdout-3.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    ;;
  auto|drop)
    POL="KISO_POLICY_SUMMARY_TRIGGER=$KISO_POLICY_SUMMARY_TRIGGER KISO_POLICY_SUMMARY_KEEP=2"
    if [ "$ARM" = drop ]; then POL="KISO_POLICY_DROP=1 $POL"; fi
    S=$(date +%s)
    printf '%s\n' "$(TURN 1)" "$(TURN 2)" "$(TURN 3)" "$(TURN 4)" "$(TURN 5)" |
      env $KENV $POL $KISO_BIN --mode bypass "$SID" > "$WORK/stdout-1.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    S=$(date +%s)
    printf '%s\n' "$(TURN 6)" "$(TURN 7)" "$(TURN 8)" |
      env $KENV $POL $KISO_BIN --mode bypass "$SID" > "$WORK/stdout-2.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    ;;
  *)
    echo "usage: run-t5-e6.sh <baseline|auto|drop> <run-id>" >&2
    exit 2
    ;;
esac
echo "$TOT" > "$WORK/wall_seconds"
VERIFY=$("$B/t5-verify.sh" "$WORK/repo")
echo "$VERIFY" > "$WORK/verify"
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: 'T5-E6', arm: '$ARM', run: '$RUN', round: '$KISO_ROUND',
  model: 'deepseek-v4-flash',
  kisoVersion: '$KISO_VERSION',
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  policyTrigger: '$KISO_POLICY_SUMMARY_TRIGGER',
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
echo "DONE T5E6 $ARM run=$RUN wall=${TOT}s verify=$VERIFY"
