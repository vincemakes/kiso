#!/usr/bin/env python3
"""Extract T5 metrics: the long-session runs aggregate MULTIPLE processes
per tool (kiso: 3 stdout logs + one durable session; pi: 8 -p logs; claude:
8 -p logs). Wall is the runner's summed seconds; usage is the SUM across
each tool's own records.

ACCOUNTING (0.1.23): same per-tool input conventions as extract.py —
kiso's inputTokens INCLUDES the cache-hit prefix (fresh = input − cache);
pi/claude report fresh-only input (fresh = input; total = input + cache).
Rows carry the uniform fresh/total/cost_weighted derived fields.
"""
import json, os, sys, glob

def kiso(work):
    files = glob.glob(f"{work}/kiso-home/sessions/*.jsonl")
    inp = out = cache = reqs = 0
    for f in files:
        for line in open(f):
            e = json.loads(line)["event"]
            if e["type"] == "usage":
                reqs += 1
                inp += e.get("inputTokens") or 0
                cache += e.get("cacheRead") or 0
                out += e.get("outputTokens") or 0
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp - cache, total=inp, cost_weighted=(inp - cache) + 0.1 * cache)

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
    inp = out = cache = reqs = 0
    for i in range(1, 9):
        path = f"{work}/stdout-{i}.log"
        if not os.path.exists(path):
            continue
        try:
            d = json.load(open(path))
        except Exception:
            continue
        u = d.get("usage", {})
        i_ = u.get("input_tokens", 0)
        c_ = u.get("cache_read_input_tokens", 0)
        inp += i_; cache += c_
        out += u.get("output_tokens", 0)
        reqs += d.get("num_turns", 0)
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache)

def main(workdir):
    rows = []
    for work in sorted(glob.glob(workdir + "/runs/*T5*")):
        name = os.path.basename(work)
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
