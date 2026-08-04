#!/bin/sh
# run-one.sh <tool: kiso|pi|claude> <task: T1|T2|T3> <run-id>
# Copies the fixture fresh, runs the tool headless on the task, records
# wall time + exit code + the tool's own transcript for usage extraction.
set -eu
TOOL=$1; TASK=$2; RUN=$3
B="$(cd "$(dirname "$0")" && pwd)"
WORK="$B/runs/$TOOL-$TASK-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-v1/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks.json','utf8'))['$TASK'])")
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"

START=$(date +%s)
cd "$WORK/repo"
case "$TOOL" in
  kiso)
    EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
    printf '%s\nexit\n' "$PROMPT" | env \
      OPENAI_BASE_URL="https://api.deepseek.com" \
      OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
      OPENAI_MODEL="deepseek-v4-flash" \
      KISO_EXTENSIONS_DIR="$EXTDIR" \
      KISO_HOME="$WORK/kiso-home" \
      kiso "bench-$TOOL-$TASK-$RUN" > "$WORK/stdout.log" 2>&1 || true
    ;;
  pi)
    env DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
      pi --provider deepseek --model deepseek-v4-flash -p --mode json \
      "$PROMPT" > "$WORK/stdout.log" 2>&1 || true
    ;;
  claude)
    env ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic" \
      ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
      ANTHROPIC_MODEL="deepseek-v4-flash" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash" \
      claude -p "$PROMPT" --output-format json --dangerously-skip-permissions \
      > "$WORK/stdout.log" 2>&1 || true
    ;;
esac
END=$(date +%s)
echo "$((END-START))" > "$WORK/wall_seconds"

# verification per task
VERIFY="n/a"
case "$TASK" in
  T2) (node tests/clamp.test.js >/dev/null 2>&1 && VERIFY=pass) || VERIFY=fail ;;
  T3) (node tests/user.test.js >/dev/null 2>&1 && node src/cli.js >/dev/null 2>&1 && VERIFY=pass) || VERIFY=fail ;;
esac
echo "$VERIFY" > "$WORK/verify"
echo "DONE $TOOL $TASK run=$RUN wall=$(cat "$WORK/wall_seconds")s verify=$VERIFY"
