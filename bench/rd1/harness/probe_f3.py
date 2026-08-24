#!/usr/bin/env python3
"""RD1B-F3 diagnostic probe — runner.

Spec: kiso-doc/kiso-rd1b-f3-probe-spec.md (frozen, Amendment 1).
NOT SCORED. No axes, no grid, no PASS/FAIL. Its output shapes the RD-1C
protocol and rewrites nothing in RD-1B.

Two arms over c9, interleaved so provider drift lands on both:

  A  the RD-1B condition — nothing answers the ask, which is what an
     unattended run does when the surface says the question is declined
  B  the ask is UNBLOCKED — a line is sent; its content cannot reach the
     model (RD1B-F6: askUi discards it and returns `declined`), so this
     measures whether the agent finishes once the surface lets go

Per leg it records the ask count, schema-rejected calls (they are
retries, not repeats — the distinction that corrected this finding
once), turns to first ask, completion, effect attempts, usage, and the
verbatim question text for the blind evaluator pass.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER = os.path.join(RD1, "drivers", "kiso", "drive.py")
SCENARIO = os.path.join(RD1, "scenarios", "c9.json")


def leg_metrics(cell):
    """Read one leg's durable log and ledger. Every field is a count of
    something recorded, never an interpretation of it."""
    m = {"asks": 0, "schemaRejected": 0, "questions": [], "firstAskAfterTurns": None,
         "completed": False, "statusClaim": None, "effectStarts": 0, "effectEnds": 0,
         "requests": 0, "costWeighted": 0.0, "needlesHeld": None}
    sess = glob.glob(os.path.join(cell, "home/sessions/*.jsonl"))
    if sess:
        rows = []
        for line in open(sess[0]):
            try:
                rows.append(json.loads(line)["event"])
            except Exception:
                continue
        results = {r.get("callId"): r for r in rows if r.get("type") == "tool_result"}
        tool_calls = 0
        for e in rows:
            if e.get("type") == "tool_call_end":
                tool_calls += 1
                if e.get("name") != "ask_user":
                    continue
                res = results.get(e.get("callId"))
                # A schema rejection is kiso refusing the CALL, not the
                # human refusing the question. Counting it as an ask is
                # what turned one corrected question into "asked twice".
                if res and res.get("isError") and "schema validation" in json.dumps(res.get("content", "")):
                    m["schemaRejected"] += 1
                    continue
                m["asks"] += 1
                if m["firstAskAfterTurns"] is None:
                    m["firstAskAfterTurns"] = tool_calls
                try:
                    m["questions"].append(e["input"]["questions"][0]["question"])
                except Exception:
                    m["questions"].append("<unparsed>")
    for f in glob.glob(os.path.join(cell, "home/sessions/traces/*.jsonl")):
        for line in open(f):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("kind") != "request":
                continue
            m["requests"] += 1
            m["costWeighted"] += (r.get("freshInput") or 0) + 0.1 * (r.get("cacheRead") or 0) + (r.get("output") or 0)
    led = os.path.join(cell, "ledger.jsonl")
    if os.path.exists(led):
        for line in open(led):
            try:
                r = json.loads(line)
            except Exception:
                continue
            m["effectStarts"] += r.get("phase") == "start"
            m["effectEnds"] += r.get("phase") == "end"
    status = os.path.join(cell, "work", "STATUS.md")
    if os.path.exists(status):
        txt = open(status).read().strip()
        m["completed"] = "deployed:" in txt
        m["statusClaim"] = txt.splitlines()[0][:40] if txt else None
    scn = json.load(open(SCENARIO))
    held = []
    for n in scn["requiredNeedles"]:
        p = os.path.join(cell, "work", n["path"])
        held.append(os.path.exists(p) and n["needle"] in open(p, errors="replace").read())
    m["needlesHeld"] = f"{sum(held)}/{len(held)}"
    m["costWeighted"] = round(m["costWeighted"], 1)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--model", default="deepseek-v4-flash")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    results = []
    for i in range(a.n):
        for arm in ("A", "B"):          # interleaved: drift lands on both
            cell = os.path.join(a.out, f"{arm}-{i + 1}")
            policy = "none" if arm == "A" else "unblock"
            t0 = time.time()
            r = subprocess.run([sys.executable, DRIVER, "--scenario", SCENARIO, "--cli", a.cli,
                                "--out", cell, "--model", a.model, "--ask-policy", policy],
                               capture_output=True, text=True)
            m = leg_metrics(cell)
            arc = {}
            try:
                arc = json.load(open(os.path.join(cell, "run.json"))).get("arc", {})
            except Exception:
                pass
            row = {"arm": arm, "run": i + 1, "policy": policy, "leg1": arc.get("leg1"),
                   "wallSeconds": round(time.time() - t0, 1), **m}
            results.append(row)
            print(f"[probe {arm}-{i+1}] leg={row['leg1']} asks={m['asks']} "
                  f"(schemaRejected={m['schemaRejected']}) completed={m['completed']} "
                  f"needles={m['needlesHeld']} effects={m['effectStarts']}/{m['effectEnds']} "
                  f"cw={m['costWeighted']:.0f} wall={row['wallSeconds']}s", flush=True)
            json.dump(results, open(os.path.join(a.out, "probe-results.json"), "w"), indent=1)
    print("\n[probe] arm summary (counts only — this probe has no verdict)")
    for arm in ("A", "B"):
        rows = [r for r in results if r["arm"] == arm]
        asked = [r for r in rows if r["asks"] > 0]
        print(f"  arm {arm}: legs={len(rows)}  asked={len(asked)}  completed={sum(r['completed'] for r in rows)}"
              f"  effectStarts>1={sum(r['effectStarts'] > 1 for r in rows)}"
              f"  medianCw={sorted(r['costWeighted'] for r in rows)[len(rows)//2]:.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
