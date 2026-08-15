#!/bin/sh
# run-e6hard.sh — the E6 decisive experiment (the 2026-08-15 order, item
# 3, pre-registered in /tmp/e6-hardening-design.md): the hardened summary
# arm (A-hard, the OFF-by-default product shape) vs the OFF control on
# the T6S long-session rig, n>=4 per arm interleaved.
# Round dir runs/e6hard — a NEW dir; the e6probe dir is NEVER reused
# (run-e6probe.sh:18 rm -rf would destroy the completed probe).
# Pre-registered env: KISO_CONTEXT_WINDOW=34000 (-> trigger 2000 =
# 34000 - POLICY_RESERVE 32000), KISO_POLICY_SUMMARY_KEEP=4 (default),
# KISO_POLICY_SUMMARY_KEEP_TOKENS=2000 (the 20k floor lowered for the
# ~5k rig — the exercised override, documented in the design), the drop
# env explicitly absent.
# One calibration leg FIRST — the fires must land at 1-2x — then the env
# is FROZEN before the n>=4 arms; no mid-run tuning (pre-registration).
# Metrics per run: verify (FAIL=0 mandatory), wall, cost-wtd (the
# kind:summary lines' canonical blocks COUNTED on both arms), fires
# (type:"summarized" count), per A-run the summarized bodies dumped to
# summarized-bodies.txt AND the six-flag presence table (--count/--span/
# --sum/--merged/--distinct/--pairs — the owner's 判据).
# Verdict (pre-registered): cost-wtd <= the off band with FAIL=0 on
# every run -> A is eligible for future default-arming as ANOTHER owner
# decision; this round ships OFF-by-default regardless. FAIL>0 anywhere
# aborts the verdict (a precondition, not a tuning signal).
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
OUT="$B/runs/e6hard"
rm -rf "$OUT"; mkdir -p "$OUT"
N=${E6_HARD_N:-4}

# ── the calibration leg (fires must land at 1-2x) ────────────────────────
KISO_ROUND=e6hard KISO_SID="bench-e6hard-calb" "$B/run-e6-leg0.sh" ahard calb > "$OUT/calibration.done" 2>&1
CALB_FIRES=$(python3 - "$OUT" <<'PYEOF'
import json, os, sys
home = f"{sys.argv[1]}/kiso-E6L0-ahard-T6S-calb/kiso-home"
log = f"{home}/sessions/bench-e6hard-calb.jsonl"
fires = 0
if os.path.exists(log):
    for line in open(log):
        r = json.loads(line); e = r.get("event") or {}
        if isinstance(e, dict) and e.get("type") == "summarized":
            fires += 1
print(fires)
PYEOF
)
echo "calibration: fires=$CALB_FIRES (target 1-2x; env is FROZEN regardless)"

# ── the interleaved arms (the env is FROZEN — no mid-run tuning) ─────────
for SEQ in $(seq 1 "$N"); do
  KISO_ROUND=e6hard KISO_SID="bench-e6hard-ahard-$SEQ" "$B/run-e6-leg0.sh" ahard "$SEQ" > "$OUT/ahard-$SEQ.done" 2>&1 &
  KISO_ROUND=e6hard KISO_SID="bench-e6hard-off-$SEQ" "$B/run-e6-leg0.sh" off "$SEQ" > "$OUT/off-$SEQ.done" 2>&1 &
  wait
done

python3 - "$OUT" "$N" <<'PYEOF'
import json, os, re, statistics as st, sys
out, n = sys.argv[1], int(sys.argv[2])
FLAGS = ["--count", "--span", "--sum", "--merged", "--distinct", "--pairs"]
RX = {f: re.compile(re.escape(f) + r"(?![A-Za-z])") for f in FLAGS}
rows = []
for arm in ("ahard", "off"):
    for seq in range(1, n + 1):
        w = f"{out}/kiso-E6L0-{arm}-T6S-{seq}"
        verify = open(f"{w}/verify").read().strip()
        wall = open(f"{w}/wall_seconds").read().strip()
        home = f"{w}/kiso-home"
        sid = f"bench-e6hard-{arm}-{seq}"
        trace = f"{home}/sessions/traces/{sid}.jsonl"
        log = f"{home}/sessions/{sid}.jsonl"
        fresh = cached = 0; reqs = 0; sumFresh = sumCached = sumLines = 0
        fires = []; terminals = []
        if os.path.exists(trace):
            for line in open(trace):
                r = json.loads(line)
                c = r.get("canonical") or {}
                if not isinstance(c, dict): c = {}
                if r.get("kind") == "request":
                    reqs += 1
                    fresh += c.get("input", 0); cached += c.get("cacheRead", 0) or 0
                elif r.get("kind") == "summary":
                    sumLines += 1
                    sumFresh += c.get("input", 0); sumCached += c.get("cacheRead", 0) or 0
        if os.path.exists(log):
            for line in open(log):
                r = json.loads(line); e = r.get("event") or {}
                if not isinstance(e, dict): continue
                if e.get("type") == "summarized":
                    fires.append(e.get("coversToSeq"))
                if e.get("type") == "terminal":
                    o = e.get("outcome") or {}
                    terminals.append(o.get("kind") if isinstance(o, dict) else str(o))
        cw = (fresh + sumFresh) + 0.1 * (cached + sumCached)
        scw = sumFresh + 0.1 * sumCached
        row = dict(arm=arm, seq=seq, verify=verify, wall=wall, reqs=reqs,
                   fresh=fresh, cached=cached, sumLines=sumLines, scw=round(scw),
                   cw=round(cw), fires=len(fires),
                   terminal=terminals[-1] if terminals else "none",
                   flagCounts={})
        if arm == "ahard":
            bodies = []
            if os.path.exists(log):
                for line in open(log):
                    r = json.loads(line); e = r.get("event") or {}
                    s = e.get("summary")
                    if e.get("type") == "summarized" and isinstance(s, str):
                        bodies.append(s)
            with open(f"{w}/summarized-bodies.txt", "w") as fh:
                for i, b in enumerate(bodies, 1):
                    fh.write(f"=== summarized fact #{i} ===\n{b}\n\n")
            for f in FLAGS:
                row["flagCounts"][f] = sum(1 for b in bodies if RX[f].search(b))
        rows.append(row)

print("=== e6hard per-run rows ===")
for r in rows:
    extra = ""
    if r["arm"] == "ahard":
        present = [f for f in FLAGS if r["flagCounts"][f] > 0]
        extra = (f" sumCalls={r['sumLines']} sumCostWtd={r['scw']} "
                 f"flagsInBodies={len(present)}/6 ({','.join(present) if present else 'none'})")
    print(f"{r['arm']}-{r['seq']}: verify={r['verify']} wall={r['wall']}s reqs={r['reqs']} "
          f"fresh={r['fresh']} cached={r['cached']} costWtd={r['cw']} fires={r['fires']} "
          f"terminal={r['terminal']}{extra}")
    for f in FLAGS:
        if r["arm"] == "ahard" and r["flagCounts"][f]:
            print(f"    body-mentions {f}: {r['flagCounts'][f]}")

a = [r for r in rows if r["arm"] == "ahard"]
o = [r for r in rows if r["arm"] == "off"]
def band(rs):
    med = st.median(r["cw"] for r in rs)
    lo, hi = min(r["cw"] for r in rs), max(r["cw"] for r in rs)
    return med, lo, hi
am, alo, ahi = band(a)
om, olo, ohi = band(o)
print("=== e6hard verdict (pre-registered) ===")
print(f"verify: ahard {sum(1 for r in a if r['verify'] == 'pass')}/{len(a)}  "
      f"off {sum(1 for r in o if r['verify'] == 'pass')}/{len(o)}")
print(f"off band costWtd: median {om:.0f} [{olo:.0f}, {ohi:.0f}]   "
      f"ahard median costWtd: {am:.0f} [{alo:.0f}, {ahi:.0f}]")
print(f"fires per ahard run: {[r['fires'] for r in a]}  "
      f"sumCalls per ahard run: {[r['sumLines'] for r in a]}")
fails = sum(1 for r in rows if r["verify"] != "pass")
if fails:
    print(f"VERDICT: NONE — {fails} run(s) FAILed (FAIL=0 is a precondition)")
elif am <= ohi:
    print(f"VERDICT: A-hard cost-wtd {am:.0f} <= off band top {ohi:.0f} -> "
          f"ELIGIBLE for future default-arming as ANOTHER owner decision")
else:
    print(f"VERDICT: A-hard cost-wtd {am:.0f} ABOVE off band top {ohi:.0f} -> "
          f"A ships only as the lifeline layer, no cheaper claims")
print("(ships OFF-by-default regardless; the adjudication is the owner's)")
PYEOF
echo "=== e6hard complete ==="
