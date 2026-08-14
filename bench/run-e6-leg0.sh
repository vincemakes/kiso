#!/bin/sh
# run-e6-leg0.sh <arm: off|on|auto> <seq>
# E6 Leg 0 (the long-session leg, the order's "长会话腿:Leg-0 rig
# (fixture-t6/T6S 那台 88 请求机器)策略 ON vs OFF,payback 形状"): the
# T6S long session (4 buckets x 6 turns on ONE durable session) with the
# context policy OFF (the baseline arm) vs ON (the policy armed:
# trigger 1300, keepRounds 2) vs AUTO (the summary arm — the policy
# armed WITHOUT the drop env; KISO_POLICY_DROP explicitly unset so the
# summary mechanism runs — the 2026-08-15 re-adjudication experiment).
# Arms are self-contained (no ambient policy env leakage). Calibration:
# 1752 projected at the bucket-2 start, so the first fire lands there,
# covering turns 1-4 and keeping 5-6; fires again at each later bucket
# start — the payback accumulates.
# Verify: t6-verify.
# Runs land in runs/<round>/kiso-E6L0-<arm>-T6S-<seq>/ with meta.json.
set -eu
ARM=$1; SEQ=$2
B="$(cd "$(dirname "$0")" && pwd)"
ROUND=${KISO_ROUND:-e6ab}
WORK="$B/runs/$ROUND/kiso-E6L0-$ARM-T6S-$SEQ"
KISO_BIN=${KISO_BIN:-node "$B/../apps/cli/dist/index.js"}
rm -rf "$WORK"; mkdir -p "$WORK"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"
cp "$B/bench-allow.mjs" "$EXTDIR/"
S=$(date +%s)
rm -rf "$WORK/repo"; cp -R "$B/fixture-t6/" "$WORK/repo"; rm -rf "$WORK/repo/.git"
cd "$WORK/repo"
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t6.json','utf8'))[$1-1])"; }
POL=""; UNSET=""
case "$ARM" in
  on)   POL="KISO_POLICY_SUMMARY_TRIGGER=1300 KISO_POLICY_SUMMARY_KEEP=2 KISO_POLICY_DROP=1" ;;
  auto) POL="KISO_POLICY_SUMMARY_TRIGGER=1300 KISO_POLICY_SUMMARY_KEEP=2"; UNSET="-u KISO_POLICY_DROP" ;;
esac
for P in 1 2 3 4; do
  i=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 ))
  while [ "$i" -le "$E" ]; do TURN $i; i=$((i + 1)); done \
    | env $UNSET \
        OPENAI_BASE_URL="https://api.deepseek.com" \
        OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
        OPENAI_MODEL="deepseek-v4-flash" \
        KISO_EXTENSIONS_DIR="$EXTDIR" \
        KISO_HOME="$WORK/kiso-home" \
        $POL \
        $KISO_BIN --mode bypass "bench-e6-leg0-$ARM-$SEQ" > "$WORK/stdout-$P.log" 2>&1 || true
done
"$B/t6-verify.sh" "$WORK/repo" > "$WORK/verify"
E=$(date +%s); echo $((E - S)) > "$WORK/wall_seconds"
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: 'T6S', leg: 'e6', arm: '$ARM', seq: '$SEQ', round: '$ROUND',
  model: 'deepseek-v4-flash',
  kisoVersion: require('$B/../apps/cli/package.json').version,
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
echo "DONE E6-L0 arm=$ARM round=$ROUND seq=$SEQ wall=$((E - S))s verify=$(cat "$WORK/verify")"
