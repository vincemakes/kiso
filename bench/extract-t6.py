#!/usr/bin/env python3
"""Extract T6 metrics: the long-curve scenario — 24 progressive turns in
FOUR 6-turn buckets. The DIVERGENCE CURVE needs per-bucket cost, not just
the total: each bucket carries the tool's own usage records summed over
the bucket's turns plus the bucket's wall seconds (kiso: wall_1..wall_4,
the per-process walls — the process boundaries ARE the bucket boundaries;
pi: the runner sums its per-invocation walls into the same files).

ACCOUNTING: the uniform definitions of extract.py / extract-t5.py —
kiso's inputTokens INCLUDES the cache-hit prefix (fresh = input − cache,
total = input); pi reports fresh-only input (fresh = input, total =
input + cache); cost_weighted = fresh + 0.1 × cache_read (DeepSeek's
cache-hit price ratio). Pinned by bench/tests/test_extract.py.

kiso's per-turn split: the durable session log, cut at user_input events
(each turn = one input; the FIRST usage after a turn's input belongs to
that turn; usage before any input — none, the log always opens with the
input). pi: each stdout-N.log is one turn (one -p invocation).
"""
import json, os, sys, glob

BUCKETS = 4
TURNS_PER_BUCKET = 6


def _sum_usage(events):
    d = dict(input=0, cache=0, output=0, requests=0)
    for u in events:
        d["requests"] += 1
        d["cache"] += u.get("cacheRead") or 0
        d["output"] += u.get("outputTokens") or 0
        d["input"] += u.get("inputTokens") or 0
    return d


def kiso(work):
    # The durable log orders input-then-usage: each user_input STARTS a turn
    # and the usage events that follow it belong to that turn (verified
    # against kiso-T5-1's session log). One entry per input, in log order.
    turns = []
    turn_usage = []
    for f in glob.glob(f"{work}/kiso-home/sessions/*.jsonl"):
        for line in open(f):
            e = json.loads(line)["event"]
            if e["type"] == "user_input":
                turn_usage = []
                turns.append(turn_usage)
            elif e["type"] == "usage":
                turn_usage.append(e)
    buckets = []
    for p in range(BUCKETS):
        slice_ = turns[p * TURNS_PER_BUCKET:(p + 1) * TURNS_PER_BUCKET]
        u = _sum_usage([u for t in slice_ for u in t])
        b = dict(fresh=u["input"] - u["cache"], cache_read=u["cache"],
                 output=u["output"], requests=u["requests"])
        b["total"] = u["input"]
        b["cost_weighted"] = b["fresh"] + 0.1 * b["cache_read"]
        b["wall"] = int(open(f"{work}/wall_{p + 1}").read().strip())
        buckets.append(b)
    return buckets


def pi(work):
    buckets = []
    for p in range(BUCKETS):
        u = dict(input=0, cache=0, output=0, requests=0)
        for i in range(p * TURNS_PER_BUCKET + 1, (p + 1) * TURNS_PER_BUCKET + 1):
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
                m = ev.get("message") or {}
                u2 = m.get("usage") or {}
                if isinstance(u2, dict) and "input" in u2:
                    u["requests"] += 1
                    u["input"] += u2.get("input") or 0
                    u["cache"] += u2.get("cacheRead") or 0
                    u["output"] += u2.get("output") or 0
        b = dict(fresh=u["input"], cache_read=u["cache"], output=u["output"],
                 requests=u["requests"])
        b["total"] = u["input"] + u["cache"]
        b["cost_weighted"] = u["input"] + 0.1 * u["cache"]
        b["wall"] = int(open(f"{work}/wall_{p + 1}").read().strip())
        buckets.append(b)
    return buckets


def main(workdir):
    rows = []
    for work in sorted(glob.glob(workdir + "/runs/*T6*")):
        name = os.path.basename(work)
        tool, task, run = name.split("-", 2)
        if not os.path.exists(f"{work}/wall_1"):
            continue
        try:
            buckets = {"kiso": kiso, "pi": pi}[tool](work)
            m = dict(tool=tool, task=task, run=run, buckets=buckets,
                     verify=open(f"{work}/verify").read().strip())
        except Exception as ex:
            m = dict(tool=tool, task=task, run=run, error=str(ex)[:80])
        rows.append(m)
    print(json.dumps(rows, indent=1))
    return rows


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
