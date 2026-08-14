#!/bin/sh
# dogfood-e5.sh — the E5 execution-side dogfood double-run (real model,
# tree dist, real task):
#   default — the new default composition: NO task extension. The session
#             must complete the 5-step refactor (verify green) and its rent
#             must carry NO task surfaces (the OFF-arm proof, live).
#   opt-in   — the task extension loaded via KISO_EXTENSIONS_DIR. The
#             session must complete the same task (verify green), its rent
#             MUST carry system:ext:task + tool:task_set (the extension
#             loaded into the composition), and the script reports whether
#             the model actually CALLED task_set (finding E5-F2 says the
#             designed trigger zero-activates — the callability is the
#             gate's proof, the loadability is this leg's).
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
BIN=${KISO_BIN:-node "$B/../apps/cli/dist/index.js"}
. "${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
PROMPT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B/tasks-e5.json','utf8'))['T5S'])")
OUT="$B/runs/e5dog"
rm -rf "$OUT"; mkdir -p "$OUT"

run_leg() { # run_leg <sid> <extdir>
  SID=$1; EXTDIR=$2
  mkdir -p "$OUT/$SID/repo"
  cp -R "$B/fixture-e5/" "$OUT/$SID/repo/"
  rm -rf "$OUT/$SID/repo/.git"
  ( cd "$OUT/$SID/repo"
    printf '%s\nexit\n' "$PROMPT" | env \
      OPENAI_BASE_URL="https://api.deepseek.com" \
      OPENAI_API_KEY="$DEEPSEEK_API_KEY" \
      OPENAI_MODEL="deepseek-v4-flash" \
      KISO_EXTENSIONS_DIR="$EXTDIR" \
      KISO_HOME="$OUT/$SID/kiso-home" \
      $BIN --mode bypass "$SID" > "$OUT/$SID/stdout.log" 2>&1 || true
    node tests/range.test.js >/dev/null 2>&1 \
      && [ "$(node src/cli.js --min '1-2,9-10' 2>/dev/null | tail -1)" = "1" ] \
      && echo pass || echo fail
  ) > "$OUT/$SID/verify"
}

EXTDEF="$OUT/ext-default"; mkdir -p "$EXTDEF"; cp "$B/bench-allow.mjs" "$EXTDEF/"
run_leg e5-dog-default "$EXTDEF"

EXTIN="$OUT/ext-optin"; mkdir -p "$EXTIN"
cp "$B/bench-allow.mjs" "$EXTIN/"
cp "$B/../extensions/task/src/kiso-task.mjs" "$EXTIN/"

run_leg e5-dog-optin "$EXTIN"

python3 - "$OUT" <<'PYEOF'
import json, os, sys, glob
out = sys.argv[1]
for sid in ("e5-dog-default", "e5-dog-optin"):
    home = f"{out}/{sid}/kiso-home"
    verify = open(f"{out}/{sid}/verify").read().strip()
    trace = f"{home}/sessions/traces/{sid}.jsonl"
    rents = []
    task_calls = 0
    fresh = 0
    if os.path.exists(trace):
        for line in open(trace):
            r = json.loads(line)
            if r.get("kind") == "request":
                rents.extend(l["surface"] for l in r.get("rent", []))
                c = r.get("canonical") or {}
                # the canonical block's "input" is FRESH-ONLY (the pinned
                # sentence, extract.py T7) — never "freshInput", which is
                # a different (top-level) field
                fresh += c.get("input", 0)
            if r.get("type") == "tool_call_end" and r.get("name") == "task_set":
                task_calls += 1
    has_task = any(s.startswith(("system:ext:task", "tool:task_set")) for s in rents)
    print(f"--- {sid}: verify={verify} fresh={fresh} task_surfaces={has_task} task_set_calls={task_calls}")
    ok = (verify == "pass" and has_task == (sid == "e5-dog-optin"))
    print(f"    {'OK' if ok else 'LEG FAIL'}")
PYEOF
echo "=== e5 dogfood complete ==="
