#!/usr/bin/env python3
"""Extract T5 metrics: the long-session runs aggregate MULTIPLE processes
per tool (kiso: 3 stdout logs + one durable session; pi: 8 -p logs; claude:
8 -p logs). Wall is the runner's summed seconds; usage is the SUM across
each tool's own records.

ACCOUNTING (0.1.23, canonical since E2 1.3.0 — same switch as extract.py,
T7): kiso reads the TRACE SIDECAR (sessions/traces/<sid>.jsonl); the
canonical block's input is FRESH-ONLY on BOTH routes; a v1 sidecar's
freshInput IS the guard's route-derived fresh (read as defaults, never a
crash); an untraced session falls back to the session-log raw (fresh =
inputTokens − cache_read, the legacy openai-compat derivation). Rows
carry the uniform canonical shape: input = fresh, total = fresh + cache,
cost_weighted = fresh + 0.1 × cache (the pi/claude shape).
"""
import json, os, sys, glob

def kiso(work):
    sessions = f"{work}/kiso-home/sessions"
    traced = set()
    for p in glob.glob(f"{sessions}/traces/*.jsonl"):
        traced.add(os.path.basename(p)[:-6])
    files = sorted(glob.glob(f"{sessions}/traces/*.jsonl") +
                   [p for p in glob.glob(f"{sessions}/*.jsonl")
                    if os.path.basename(p)[:-6] not in traced])
    fresh = out = cache = reqs = 0
    for f in files:
        for line in open(f):
            r = json.loads(line)
            if "canonical" in r:                      # v2 ledger: the canonical block
                c = r["canonical"]
                fr, ca, o = c["input"], c["cacheRead"], c["output"]
            elif r.get("kind") == "request":          # v1 ledger: the guard's fresh
                fr, ca, o = r["freshInput"], r["cacheRead"], r["output"]
            else:
                e = r.get("event")
                if not isinstance(e, dict) or e.get("type") != "usage":
                    continue
                i = e.get("inputTokens") or 0
                ca = e.get("cacheRead") or 0
                o = e.get("outputTokens") or 0
                fr = i - ca                           # legacy session log
            reqs += 1
            fresh += fr; cache += ca; out += o
    return dict(input=fresh, cache_read=cache, output=out, requests=reqs,
                fresh=fresh, total=fresh + cache, cost_weighted=fresh + 0.1 * cache)

def pi(work):
    inp = out = cache = reqs = 0
    for i in range(1, 9):
        path = f"{work}/stdout-{i}.log"
        if not os.path.exists(path):
            continue
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(ev, dict) or ev.get("type") != "message_end":
                continue
            u = ((ev.get("message") or {}).get("usage") or {}) if isinstance(ev.get("message"), dict) else {}
            if u and isinstance(u, dict) and "input" in u:
                reqs += 1
                inp += u.get("input") or 0
                cache += u.get("cacheRead") or 0
                out += u.get("output") or 0
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache)

def claude(work):
    # CC ≥2.1.233 prints warning lines that carry a JSON fragment
    # (`[claude-code:...] {...}`) — whole-file json.load fails and the old
    # `except: continue` silently ZEROED the run. Parse per line; keep the
    # last object with a usage block; loud failure when no turn parses.
    inp = out = cache = reqs = seen = 0
    for i in range(1, 9):
        path = f"{work}/stdout-{i}.log"
        if not os.path.exists(path):
            continue
        d = None
        for line in open(path):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if "usage" in o:
                d = o
        if d is None:
            continue
        seen += 1
        u = d.get("usage", {})
        i_ = u.get("input_tokens", 0)
        c_ = u.get("cache_read_input_tokens", 0)
        inp += i_; cache += c_
        out += u.get("output_tokens", 0)
        reqs += d.get("num_turns", 0)
    if seen == 0:
        raise ValueError("no usage JSON line in any stdout-N.log")
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache)

def main(workdir):
    rows = []
    for work in sorted(glob.glob(workdir + "/runs/*T5*")):
        name = os.path.basename(work)
        if name.count("-") < 2:
            continue  # not a <tool>-<task>-<run> dir (notes, reports)
        tool, task, run = name.split("-", 2)
        if not os.path.exists(f"{work}/wall_seconds"):
            continue
        try:
            m = {"kiso": kiso, "pi": pi, "claude": claude}[tool](work)
        except Exception as ex:
            m = dict(error=str(ex)[:80])
        m.update(tool=tool, task=task, run=run,
                 wall=int(open(f"{work}/wall_seconds").read().strip()),
                 verify=open(f"{work}/verify").read().strip())
        if "input" in m:
            m["cost_weighted"] = m["fresh"] + 0.1 * m["cache_read"]
        rows.append(m)
    print(json.dumps(rows, indent=1))
    return rows

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
