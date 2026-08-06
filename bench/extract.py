#!/usr/bin/env python3
"""Extract per-run metrics from each tool's own durable records.

ACCOUNTING (the 0.1.23 fresh-mystery round fixed a mislabeling here): the
three tools report "input" differently —
  kiso:   inputTokens = TOTAL input INCLUDING the cache-hit prefix
          (DeepSeek convention) → fresh = input − cache_read, total = input.
  pi:     usage.input = fresh-only (its cache read is reported separately)
          → fresh = input, total = input + cache_read.
  claude: input_tokens = fresh-only (Anthropic convention: cache reads are
          separate) → fresh = input, total = input + cache_read.
The output rows carry BOTH the raw fields (input/cache_read) and the
uniform derived fields (fresh/total/cost_weighted) so the README tables
compare like with like. cost_weighted = fresh + 0.1 × cache_read (0.1 is
DeepSeek's cache-hit price ratio, https://api-docs.deepseek.com/quick_start/pricing).
"""
import json, os, sys, glob

def kiso(work):
    files = glob.glob(f"{work}/kiso-home/sessions/*.jsonl")
    inp = out = cache = reqs = 0
    first = None
    for f in files:
        for line in open(f):
            r = json.loads(line)
            e = r["event"]
            if e["type"] == "usage":
                reqs += 1
                i = e.get("inputTokens") or 0
                c = e.get("cacheRead") or 0
                o = e.get("outputTokens") or 0
                inp += i; cache += c; out += o
                if first is None: first = i + c
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp - cache, total=inp, cost_weighted=(inp - cache) + 0.1 * cache,
                first_prompt=first)

def pi(work):
    # pi --mode json emits JSONL: one event per line; usage lives on
    # assistant "message"/"message_end" events' message.usage.
    inp = out = cache = reqs = 0
    first = None
    for line in open(f"{work}/stdout.log"):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict) or ev.get("type") != "message_end":
            continue  # only the final per-request usage is real
        msg = ev.get("message")
        u = (msg or {}).get("usage") if isinstance(msg, dict) else None
        if u and isinstance(u, dict) and "input" in u:
            reqs += 1
            inp += u.get("input") or 0
            cache += u.get("cacheRead") or 0
            out += u.get("output") or 0
            if first is None: first = (u.get("input") or 0) + (u.get("cacheRead") or 0)
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache,
                first_prompt=first)

def claude(work):
    text = open(f"{work}/stdout.log").read()
    # CC may print warnings (e.g. the stdin notice) before the JSON — parse
    # from the first "{".
    d = json.loads(text[text.index("{"):])
    u = d.get("usage", {})
    inp = u.get("input_tokens", 0)
    cache = u.get("cache_read_input_tokens", 0)
    return dict(input=inp, cache_read=cache,
                output=u.get("output_tokens", 0),
                requests=d.get("num_turns", 0),
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache,
                first_prompt=None)

def main(workdir):
    rows = []
    for work in sorted(glob.glob(workdir + "/runs/*")):
        name = os.path.basename(work)
        if "T5" in name:
            continue  # T5 is the long-session scenario — extract-t5.py's job
        tool, task, run = name.split("-", 2)
        if not os.path.exists(f"{work}/wall_seconds"):
            continue  # in progress
        try:
            m = {"kiso": kiso, "pi": pi, "claude": claude}[tool](work)
        except Exception as ex:
            m = dict(error=str(ex)[:80])
        m.update(tool=tool, task=task, run=run,
                 wall=int(open(f"{work}/wall_seconds").read().strip()),
                 verify=open(f"{work}/verify").read().strip())
        rows.append(m)
    print(json.dumps(rows, indent=1))
    return rows

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
