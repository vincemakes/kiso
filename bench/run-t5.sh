#!/bin/sh
# run-t5.sh <tool: kiso|pi|claude> <run-id>
# The long-session scenario: 8 progressive turns on fixture-t5, then the
# final verify. Each tool drives the session with its NATIVE mechanism:
#   kiso   — 3 processes on one durable session: turns 1-5, then the
#            /compact line (the round's subject — the mid-way model
#            summary), then turns 6-8. The session log is the durable
#            thread; EOF ends each process.
#   pi     — 8 `-p` invocations sharing one --session file (its native
#            session continuation).
#   claude — 8 `-p` invocations sharing one --resume session (its native;
#            CC auto-compacts on its own threshold if it ever fires).
# Wall = the sum of the per-process seconds. Usage is extracted per tool
# from its own records by extract-t5.py.
set -eu
TOOL=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
# E4-e: KISO_ROUND scopes the runs under runs/<round>/ (the run-hygiene
# discipline — a round never reuses a historical run name); absent = the
# historical flat layout.
WORK="$B/runs/${KISO_ROUND:+$KISO_ROUND/}$TOOL-T5-$RUN"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -R "$B/fixture-t5/" "$WORK/repo/"
rm -rf "$WORK/repo/.git"
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
TOT=0
cd "$WORK/repo"
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t5.json','utf8'))[$1-1])"; }

case "$TOOL" in
  kiso)
    EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
    KENV="OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=$DEEPSEEK_API_KEY OPENAI_MODEL=deepseek-v4-flash KISO_EXTENSIONS_DIR=$EXTDIR KISO_HOME=$WORK/kiso-home"
    S=$(date +%s)
    printf '%s\n' "$(TURN 1)" "$(TURN 2)" "$(TURN 3)" "$(TURN 4)" "$(TURN 5)" |
      env $KENV kiso --mode bypass "bench-t5-$TOOL-$RUN" > "$WORK/stdout-1.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    S=$(date +%s)
    printf '/compact\n' |
      env $KENV kiso --mode bypass "bench-t5-$TOOL-$RUN" > "$WORK/stdout-2.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    S=$(date +%s)
    printf '%s\n' "$(TURN 6)" "$(TURN 7)" "$(TURN 8)" |
      env $KENV kiso --mode bypass "bench-t5-$TOOL-$RUN" > "$WORK/stdout-3.log" 2>&1 || true
    E=$(date +%s); TOT=$((TOT + E - S))
    ;;
  pi)
    for i in 1 2 3 4 5 6 7 8; do
      S=$(date +%s)
      env DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
        pi --provider deepseek --model deepseek-v4-flash -p --mode json \
        --session "$WORK/pi-session" "$(TURN $i)" > "$WORK/stdout-$i.log" 2>&1 || true
      E=$(date +%s); TOT=$((TOT + E - S))
    done
    ;;
  claude)
    CENV="ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY ANTHROPIC_MODEL=deepseek-v4-flash ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash"
    SID=""
    for i in 1 2 3 4 5 6 7 8; do
      S=$(date +%s)
      if [ -z "$SID" ]; then
        env $CENV claude -p "$(TURN $i)" --output-format json --dangerously-skip-permissions \
          > "$WORK/stdout-$i.log" 2>&1 || true
        SID=$(python3 -c "import json;print(json.load(open('$WORK/stdout-$i.log')).get('session_id',''))" 2>/dev/null || true)
      else
        env $CENV claude -p "$(TURN $i)" --resume "$SID" --output-format json --dangerously-skip-permissions \
          > "$WORK/stdout-$i.log" 2>&1 || true
      fi
      E=$(date +%s); TOT=$((TOT + E - S))
    done
    ;;
esac
echo "$TOT" > "$WORK/wall_seconds"
VERIFY=$("$B/t5-verify.sh" "$WORK/repo")
echo "$VERIFY" > "$WORK/verify"
echo "DONE T5 $TOOL run=$RUN wall=${TOT}s verify=$VERIFY"
