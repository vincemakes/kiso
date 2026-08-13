#!/bin/sh
# run-t6c.sh <round> <seq>
# E4-a — the T6-compact long-session curve: the 24 progressive turns of
# the T6 scenario (4 buckets × 6 turns on fixture-t6) with the
# microcompact threshold made EXPLICIT — the runner pins
# KISO_CONTEXT_WINDOW (default 200000 = the product default; the CLI's
# threshold is window/2), so the boundary events land where the scenario
# declares them. kiso only: the per-request curve reads the trace sidecar
# (sessions/traces/), which only kiso writes.
#
# E4-e run hygiene: runs land in runs/<round>/kiso-T6C-<seq>/ with
# meta.json (tool versions, commit, model, round, date) — the extractor
# refuses an unlabeled run; the round's dir is named by the caller and
# never reuses a historical run name.
set -eu
ROUND=$1; SEQ=$2
B="$(cd "$(dirname "$0")" && pwd)"
WORK="$B/runs/$ROUND/kiso-T6C-$SEQ"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-t6/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
cd "$WORK/repo"
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t6.json','utf8'))[$1-1])"; }
BUCKET() { # $1=1..4 — the turn range's start and end
  P=$1; S=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 ))
  i=$S; while [ "$i" -le "$E" ]; do TURN $i; i=$((i + 1)); done
}
EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
WIN=${KISO_CONTEXT_WINDOW:-200000}
KENV="OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=$DEEPSEEK_API_KEY OPENAI_MODEL=deepseek-v4-flash KISO_EXTENSIONS_DIR=$EXTDIR KISO_HOME=$WORK/kiso-home KISO_CONTEXT_WINDOW=$WIN"
for P in 1 2 3 4; do
  S=$(date +%s)
  BUCKET $P | env $KENV kiso --mode bypass "bench-t6c-$ROUND-$SEQ" > "$WORK/stdout-$P.log" 2>&1 || true
  E=$(date +%s); echo $((E - S)) > "$WORK/wall_$P"
done
VERIFY=$("$B/t6-verify.sh" "$WORK/repo")
echo "$VERIFY" > "$WORK/verify"
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: 'T6C', seq: '$SEQ', round: '$ROUND',
  model: process.env.OPENAI_MODEL || 'deepseek-v4-flash',
  kisoVersion: require('$B/../apps/cli/package.json').version,
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  contextWindow: Number('$WIN'),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
echo "DONE T6C round=$ROUND seq=$SEQ verify=$VERIFY"
