#!/bin/sh
# run-planning.sh <round> <arm: on|off> <seq>
# E4-b — the planning eval arm: the SAME task set (T2: the clamp fix,
# T3: the formatUser→renderUser rename — fixture-v1, verifies existing)
# under two compositions:
#   on  — the default bench composition (bench-allow + the four built-in
#         extensions incl. task);
#   off — bench-allow + a name-only "task" shell (bench-task-shell.mjs)
#         that SHADOWS the built-in task extension (the builtInLayer
#         rule) — no tools, no plan-guidance append.
# Each task runs in its OWN durable session (task isolation: no turn of
# one task contaminates the next — the ON/OFF contrast is the point), and
# its verify is recorded per task (verify-T2 / verify-T3). Interleaving
# is the caller's job: run on-1, off-1, on-2, off-2, … (the bandwidth
# rule). E4-e: runs land in runs/<round>/kiso-PLN-<arm>-<seq>/ with
# meta.json; the extractor (extract-planning.py) refuses an unlabeled run.
set -eu
ROUND=$1; ARM=$2; SEQ=$3
B="$(cd "$(dirname "$0")" && pwd)"
WORK="$B/runs/$ROUND/kiso-PLN-$ARM-$SEQ"
# KISO_BIN overrides the kiso command (the arm detector reads the rent
# ledger, written by the E1+/E3 tracer — pass the LOCAL build:
# KISO_BIN="node $B/../apps/cli/dist/index.js")
KISO_BIN=${KISO_BIN:-kiso}
rm -rf "$WORK"; mkdir -p "$WORK"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"
cp "$B/bench-allow.mjs" "$EXTDIR/"
[ "$ARM" = "off" ] && cp "$B/bench-task-shell.mjs" "$EXTDIR/"
TASK_PROMPT() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks.json','utf8'))['$1'])"; }
VERIFY() { # $1=task — run the task's own verify, print pass|fail
  case "$1" in
    T2) node tests/clamp.test.js >/dev/null 2>&1 && echo pass || echo fail ;;
    T3) node tests/user.test.js >/dev/null 2>&1 && node src/cli.js >/dev/null 2>&1 && echo pass || echo fail ;;
  esac
}
TOT=0
for TASK in T2 T3; do
  rm -rf "$WORK/repo"; cp -R "$B/fixture-v1/" "$WORK/repo"; rm -rf "$WORK/repo/.git"
  S=$(date +%s)
  ( cd "$WORK/repo"
    printf '%s\nexit\n' "$(TASK_PROMPT $TASK)" | env \
      OPENAI_BASE_URL="https://api.deepseek.com" \
      OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
      OPENAI_MODEL="deepseek-v4-flash" \
      KISO_EXTENSIONS_DIR="$EXTDIR" \
      KISO_HOME="$WORK/kiso-home" \
      $KISO_BIN --mode bypass "bench-planning-$ARM-$SEQ-$TASK" > "$WORK/stdout-$TASK.log" 2>&1 || true
  )
  E=$(date +%s); TOT=$((TOT + E - S))
  ( cd "$WORK/repo" && VERIFY $TASK ) > "$WORK/verify-$TASK"
done
echo "$TOT" > "$WORK/wall_seconds"
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const meta = {
  tool: 'kiso', task: 'PLN', arm: '$ARM', seq: '$SEQ', round: '$ROUND',
  model: process.env.OPENAI_MODEL || 'deepseek-v4-flash',
  kisoVersion: require('$B/../apps/cli/package.json').version,
  commit: execSync('git -C $B/.. rev-parse --short HEAD').toString().trim(),
  createdAt: Date.now(),
};
fs.writeFileSync('$WORK/meta.json', JSON.stringify(meta, null, 1) + '\n');
"
echo "DONE PLN arm=$ARM round=$ROUND seq=$SEQ wall=${TOT}s verify-T2=$(cat "$WORK/verify-T2") verify-T3=$(cat "$WORK/verify-T3")"
