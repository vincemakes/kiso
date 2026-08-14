#!/bin/sh
# run-e5-leg0.sh <round> <task: T5S|T6S> <seq>
# E5 Leg 0 — the FLAT-composition measurement (runs BEFORE any E5 code):
#   T5S — the planning-designed 5-step refactor on fixture-e5, ONE run in its
#         own durable session (the guidance's own trigger: "3+ steps → call
#         task_set once up front"). Verify: tests/range.test.js + the
#         --min cli check.
#   T6S — the T6-class long session (4 buckets x 6 turns on fixture-t6, 4
#         processes on ONE durable session) — the long-curve activation
#         probe. Verify: the T6 verify (t6-verify.sh).
# The composition is FLAT: bench-allow + the built-in task extension (the
# default bench composition — the E4 planning ON arm's shape; the rent
# ledger's system:ext:task line is the arm proof). KISO_BIN overrides the
# kiso command (default: the LOCAL build — pass the published bin for a
# bin-vs-tree comparison with KISO_BIN="npx -y @vincemakes/kiso-code@0.2.2").
# Runs land in runs/<round>/kiso-E5L0-<task>-<seq>/ with meta.json;
# extract-e5-leg0.py refuses an unlabeled run.
set -eu
ROUND=$1; TASK=$2; SEQ=$3
B="$(cd "$(dirname "$0")" && pwd)"
WORK="$B/runs/$ROUND/kiso-E5L0-$TASK-$SEQ"
KISO_BIN=${KISO_BIN:-node "$B/../apps/cli/dist/index.js"}
rm -rf "$WORK"; mkdir -p "$WORK"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"
cp "$B/bench-allow.mjs" "$EXTDIR/"
S=$(date +%s)
case "$TASK" in
  T5S)
    rm -rf "$WORK/repo"; cp -R "$B/fixture-e5/" "$WORK/repo"; rm -rf "$WORK/repo/.git"
    PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-e5.json','utf8'))['T5S'])")
    ( cd "$WORK/repo"
      printf '%s\nexit\n' "$PROMPT" | env \
        OPENAI_BASE_URL="https://api.deepseek.com" \
        OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
        OPENAI_MODEL="deepseek-v4-flash" \
        KISO_EXTENSIONS_DIR="$EXTDIR" \
        KISO_HOME="$WORK/kiso-home" \
        $KISO_BIN --mode bypass "bench-e5-leg0-$TASK-$SEQ" > "$WORK/stdout.log" 2>&1 || true
    )
    ( cd "$WORK/repo"
      node tests/range.test.js >/dev/null 2>&1 \
        && [ "$(node src/cli.js --min '1-2,9-10' 2>/dev/null | tail -1)" = "1" ] \
        && echo pass || echo fail
    ) > "$WORK/verify"
    ;;
  T6S)
    rm -rf "$WORK/repo"; cp -R "$B/fixture-t6/" "$WORK/repo"; rm -rf "$WORK/repo/.git"
    cd "$WORK/repo"
    TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t6.json','utf8'))[$1-1])"; }
    for P in 1 2 3 4; do
      i=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 ))
      while [ "$i" -le "$E" ]; do TURN $i; i=$((i + 1)); done \
        | env \
            OPENAI_BASE_URL="https://api.deepseek.com" \
            OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
            OPENAI_MODEL="deepseek-v4-flash" \
            KISO_EXTENSIONS_DIR="$EXTDIR" \
            KISO_HOME="$WORK/kiso-home" \
            $KISO_BIN --mode bypass "bench-e5-leg0-$TASK-$SEQ" > "$WORK/stdout-$P.log" 2>&1 || true
    done
    "$B/t6-verify.sh" "$WORK/repo" > "$WORK/verify"
    ;;
  *)
    echo "usage: run-e5-leg0.sh <round> <T5S|T6S> <seq>" >&2; exit 1
    ;;
esac
E=$(date +%s); echo $((E - S)) > "$WORK/wall_seconds"
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: '$TASK', leg: '0', arm: 'flat', seq: '$SEQ', round: '$ROUND',
  model: 'deepseek-v4-flash',
  kisoVersion: require('$B/../apps/cli/package.json').version,
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
echo "DONE E5-L0 task=$TASK round=$ROUND seq=$SEQ wall=$((E - S))s verify=$(cat "$WORK/verify")"
