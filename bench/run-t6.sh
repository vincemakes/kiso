#!/bin/sh
# run-t6.sh <tool: kiso|pi> <run-id>
# The long-curve scenario: 24 progressive turns on fixture-t6, split into
# FOUR 6-turn buckets. Each tool drives the session with its NATIVE
# mechanism (the T5 pattern, scaled):
#   kiso — 4 processes on one durable session, 6 piped prompts each. The
#          process boundaries ARE the bucket boundaries, so each process's
#          wall is the bucket's wall; the resume cost of a process lands
#          in its bucket's first turn (the mechanism's honest price).
#   pi   — 24 `-p` invocations sharing one --session file; the runner sums
#          the per-invocation walls into the same per-bucket wall files.
# Wall is per-bucket (wall_1..wall_4); usage extraction is per-bucket too
# (extract-t6.py): the divergence curve needs the cost GROWTH over the
# session, not just the total.
set -eu
TOOL=$1; RUN=$2
B="$(cd "$(dirname "$0")" && pwd)"
WORK="$B/runs/$TOOL-T6-$RUN"
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
case "$TOOL" in
  kiso)
    EXTDIR="$WORK/ext"; mkdir -p "$EXTDIR"; cp "$B/bench-allow.mjs" "$EXTDIR/"
    KENV="OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=$DEEPSEEK_API_KEY OPENAI_MODEL=deepseek-v4-flash KISO_EXTENSIONS_DIR=$EXTDIR KISO_HOME=$WORK/kiso-home"
    for P in 1 2 3 4; do
      S=$(date +%s)
      BUCKET $P | env $KENV kiso --mode bypass "bench-t6-$TOOL-$RUN" > "$WORK/stdout-$P.log" 2>&1 || true
      E=$(date +%s); echo $((E - S)) > "$WORK/wall_$P"
    done
    ;;
  pi)
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
      S=$(date +%s)
      env DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
        pi --provider deepseek --model deepseek-v4-flash -p --mode json \
        --session "$WORK/pi-session" "$(TURN $i)" > "$WORK/stdout-$i.log" 2>&1 || true
      E=$(date +%s); echo $((E - S)) > "$WORK/wall_turn_$i"
    done
    for P in 1 2 3 4; do # per-bucket wall (uniform with kiso's wall_N)
      TOT=0; i=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 ))
      while [ "$i" -le "$E" ]; do
        TOT=$((TOT + $(cat "$WORK/wall_turn_$i")))
        rm -f "$WORK/wall_turn_$i" # ONLY this turn — a glob here would
        i=$((i + 1))               # wipe later buckets' walls (the run bug)
      done
      echo "$TOT" > "$WORK/wall_$P"
    done
    ;;
  *)
    echo "usage: run-t6.sh <kiso|pi> <run-id>" >&2; exit 1
    ;;
esac
VERIFY=$("$B/t6-verify.sh" "$WORK/repo")
echo "$VERIFY" > "$WORK/verify"
echo "DONE T6 $TOOL run=$RUN verify=$VERIFY"
