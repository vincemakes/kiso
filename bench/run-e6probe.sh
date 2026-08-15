#!/bin/sh
# run-e6probe.sh — the 2026-08-15 re-adjudication experiment (the
# owner's order after the dogfood's E6-F4/F5): the long T6S leg run
# with the SUMMARY arm (A: trigger 1300 / keepRounds 2, KISO_POLICY_DROP
# explicitly absent) vs the OFF control, n>=3 each, interleaved. The
# fixture now exits 1 on unwired flags (the exit-0 junk trap is dead —
# the 2026-08-15 fixture ruling).
# Report per run: verify, wall, cost (fresh/cached/cost-wtd — the
# kind:summary lines' canonical blocks COUNTED on both arms, the
# extraction-fix); fires (type:"summarized" events); per A-run the
# summarized bodies dumped to summarized-bodies.txt AND the six-flag
# presence table (the owner's criteria: does the summary preserve the
# --count/--span/--sum/--merged/--distinct/--pairs surface?).
# Runs land in runs/e6probe/; the owner probes the bodies personally.
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
OUT="$B/runs/e6probe"
rm -rf "$OUT"; mkdir -p "$OUT"
N=${E6_PROBE_N:-4}
for SEQ in 1 2 3 4; do
  KISO_ROUND=e6probe "$B/run-e6-leg0.sh" auto "$SEQ" > "$OUT/auto-$SEQ.done" 2>&1 &
  KISO_ROUND=e6probe "$B/run-e6-leg0.sh" off "$SEQ" > "$OUT/off-$SEQ.done" 2>&1 &
  wait
done
python3 - "$OUT" <<'PYEOF'
import json, os, re, sys, statistics as st
out = sys.argv[1]
FLAGS = ["--count", "--span", "--sum", "--merged", "--distinct", "--pairs"]
RX = {f: re.compile(re.escape(f) + r"(?![A-Za-z])") for f in FLAGS}
rows = []
for arm in ("auto", "off"):
    for seq in (1, 2, 3, 4):
        w = f"{out}/kiso-E6L0-{arm}-T6S-{seq}"
        verify = open(f"{w}/verify").read().strip()
        wall = open(f"{w}/wall_seconds").read().strip()
        home = f"{w}/kiso-home"
        sid = f"bench-e6-leg0-{arm}-{seq}"
        trace = f"{home}/sessions/traces/{sid}.jsonl"
        log = f"{home}/sessions/{sid}.jsonl"
        fresh = cached = 0; reqs = 0; sumFresh = sumCached = sumLines = 0
        fires = []; terminals = []
        if os.path.exists(trace):
            for line in open(trace):
                r = json.loads(line)
                c = r.get("canonical") or {}
                if not isinstance(c, dict): c = {}  # a half-appended line read guard
                if r.get("kind") == "request":
                    reqs += 1
                    fresh += c.get("input", 0); cached += c.get("cacheRead", 0) or 0
                elif r.get("kind") == "summary":
                    sumLines += 1
                    sumFresh += c.get("input", 0); sumCached += c.get("cacheRead", 0) or 0
        if os.path.exists(log):
            for line in open(log):
                r = json.loads(line); e = r.get("event") or {}
                if not isinstance(e, dict): continue  # ditto
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
        if arm == "auto":
            bodies = []
            if os.path.exists(log):
                for line in open(log):
                    r = json.loads(line); e = r.get("event") or {}
                    s = e.get("summary")
                    # the event's summary field IS the body string (the
                    # usage-manual convention; empirically verified on
                    # the first fire, 2026-08-15)
                    if e.get("type") == "summarized" and isinstance(s, str):
                        bodies.append(s)
            with open(f"{w}/summarized-bodies.txt", "w") as fh:
                for i, b in enumerate(bodies, 1):
                    fh.write(f"=== summarized fact #{i} ===\n{b}\n\n")
            for f in FLAGS:
                row["flagCounts"][f] = sum(1 for b in bodies if RX[f].search(b))
        rows.append(row)
for r in rows:
    extra = ""
    if r["arm"] == "auto":
        present = [f for f in FLAGS if r["flagCounts"][f] > 0]
        extra = (f" sumCalls={r['sumLines']} sumCostWtd={r['scw']} "
                 f"flagsInBodies={len(present)}/6 ({','.join(present) if present else 'none'})")
    print(f"{r['arm']}-{r['seq']}: verify={r['verify']} wall={r['wall']}s reqs={r['reqs']} "
          f"fresh={r['fresh']} cached={r['cached']} costWtd={r['cw']} fires={r['fires']} "
          f"terminal={r['terminal']}{extra}")
    for f in FLAGS:
        if r["arm"] == "auto" and r["flagCounts"][f]:
            print(f"    body-mentions {f}: {r['flagCounts'][f]}")
for arm in ("auto", "off"):
    rs = [r for r in rows if r["arm"] == arm]
    passes = sum(1 for r in rs if r["verify"] == "pass")
    med = st.median(r["cw"] for r in rs)
    print(f"{arm}: verify {passes}/{len(rs)}  median costWtd {med:.0f}")
PYEOF
echo "=== e6probe complete ==="
