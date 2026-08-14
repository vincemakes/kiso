#!/bin/sh
# dogfood-e6.sh — the E6 execution-side dogfood double-run (real model,
# tree dist, real task, the 2026-08-14 order's "dogfood 双跑"):
#   long  — the T6S long-session rig (fixture-t6, 24 progressive turns in
#           4 processes on one durable session) with the shipping policy
#           armed (drop: trigger 1300, keepRounds 2, KISO_POLICY_DROP=1).
#           Must verify green AND fire (summarized facts in the ledger —
#           the savings the order's "长会话见省" asks to SEE live) — the
#           cost lands vs the A/B off-arm median (the payback reference).
#   short — a ONE-shot real task (fixture-e5's single-prompt refactor —
#           one user input, one run) with the same policy env. Must
#           verify green AND NOT fire (zero summarized facts — the
#           keepRounds floor blocks a single-input run; the order's
#           "证不 fire、不回归").
# Both legs: the tree dist (KISO_BIN override honored), the same
# credentials and ext harness as the bench. Runs land in runs/e6dog/.
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
BIN=${KISO_BIN:-node "$B/../apps/cli/dist/index.js"}
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
OUT="${E6_DOG_OUT:-$B/runs/e6dog}"
rm -rf "$OUT"; mkdir -p "$OUT"
POL="KISO_POLICY_SUMMARY_TRIGGER=${KISO_POLICY_SUMMARY_TRIGGER:-1300} KISO_POLICY_SUMMARY_KEEP=${KISO_POLICY_SUMMARY_KEEP:-2} KISO_POLICY_DROP=1"

# --- long leg: the T6S rig, 4 buckets x 6 turns, policy ON ---
SID="${E6_DOG_SID_LONG:-e6-dog-long}"
mkdir -p "$OUT/$SID/ext"; cp "$B/bench-allow.mjs" "$OUT/$SID/ext/"
cp -R "$B/fixture-t6/" "$OUT/$SID/repo"; rm -rf "$OUT/$SID/repo/.git"
TURN() { node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-t6.json','utf8'))[$1-1])"; }
S=$(date +%s)
( cd "$OUT/$SID/repo"
  for P in 1 2 3 4; do
    i=$(( (P - 1) * 6 + 1 )); E=$(( P * 6 ))
    while [ "$i" -le "$E" ]; do TURN $i; i=$((i + 1)); done \
      | env OPENAI_BASE_URL="https://api.deepseek.com" \
          OPENAI_API_KEY="$DEEPSEEK_API_KEY" OPENAI_MODEL="deepseek-v4-flash" \
          KISO_EXTENSIONS_DIR="$OUT/$SID/ext" KISO_HOME="$OUT/$SID/kiso-home" \
          $POL $BIN --mode bypass "$SID" > "$OUT/$SID/stdout-$P.log" 2>&1 || true
  done
)
E=$(date +%s); echo $((E - S)) > "$OUT/$SID/wall_seconds"
"$B/t6-verify.sh" "$OUT/$SID/repo" > "$OUT/$SID/verify"

# --- short leg: the E5 one-shot refactor, policy ON ---
SID2="${E6_DOG_SID_SHORT:-e6-dog-short}"
mkdir -p "$OUT/$SID2/ext"; cp "$B/bench-allow.mjs" "$OUT/$SID2/ext/"
cp -R "$B/fixture-e5/" "$OUT/$SID2/repo"; rm -rf "$OUT/$SID2/repo/.git"
PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-e5.json','utf8'))['T5S'])")
S=$(date +%s)
( cd "$OUT/$SID2/repo"
  printf '%s\nexit\n' "$PROMPT" | env OPENAI_BASE_URL="https://api.deepseek.com" \
      OPENAI_API_KEY="$DEEPSEEK_API_KEY" OPENAI_MODEL="deepseek-v4-flash" \
      KISO_EXTENSIONS_DIR="$OUT/$SID2/ext" KISO_HOME="$OUT/$SID2/kiso-home" \
      $POL $BIN --mode bypass "$SID2" > "$OUT/$SID2/stdout.log" 2>&1 || true
  node tests/range.test.js >/dev/null 2>&1 \
    && [ "$(node src/cli.js --min '1-2,9-10' 2>/dev/null | tail -1)" = "1" ] \
    && echo pass || echo fail
) > "$OUT/$SID2/verify"
E=$(date +%s); echo $((E - S)) > "$OUT/$SID2/wall_seconds"

python3 - "$OUT" "${E6_DOG_SID_LONG:-e6-dog-long}" "${E6_DOG_SID_SHORT:-e6-dog-short}" <<'PYEOF'
import json, os, sys
out = sys.argv[1]
for sid in (sys.argv[2], sys.argv[3]):
    home = f"{out}/{sid}/kiso-home"
    verify = open(f"{out}/{sid}/verify").read().strip()
    wall = open(f"{out}/{sid}/wall_seconds").read().strip()
    trace = f"{home}/sessions/traces/{sid}.jsonl"
    facts = []
    fresh = cached = reqs = 0
    terminals = []
    if os.path.exists(trace):
        for line in open(trace):
            r = json.loads(line)
            if r.get("kind") == "request":
                c = r.get("canonical") or {}
                fresh += c.get("input", 0); cached += c.get("cacheRead", 0) or 0
                reqs += 1
        log = f"{home}/sessions/{sid}.jsonl"
        if os.path.exists(log):
            for line in open(log):
                r = json.loads(line)
                e = r.get("event") or {}
                if e.get("type") == "summarized":
                    facts.append(e.get("coversToSeq"))
                if e.get("type") == "terminal":
                    terminals.append(e.get("outcome", {}).get("kind"))
    cw = fresh + 0.1 * cached
    print(f"--- {sid}: verify={verify} wall={wall}s reqs={reqs} fresh={fresh} cached={cached} costWtd={cw:.0f} facts={len(facts)} terminal={terminals[-1] if terminals else 'none'}")
    ok = verify == "pass" and (len(facts) >= 1 if sid == sys.argv[2] else len(facts) == 0)
    print(f"    {'OK' if ok else 'LEG FAIL'}")
PYEOF
echo "=== e6 dogfood complete ==="
