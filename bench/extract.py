#!/usr/bin/env python3
"""Extract per-run metrics from each tool's own durable records."""
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
    return dict(input=inp, cache_read=cache, output=out, requests=reqs, first_prompt=first)

def pi(work):
    # pi --mode json emits JSONL: one event per line; usage lives on
    # assistant "message"/"message_end" events' message.usage.
    inp = out = cache = reqs = 0
    first = None
    seen = set()
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
    return dict(input=inp, cache_read=cache, output=out, requests=reqs, first_prompt=first)

def claude(work):
    d = json.load(open(f"{work}/stdout.log"))
    u = d.get("usage", {})
    return dict(
        input=u.get("input_tokens", 0),
        cache_read=u.get("cache_read_input_tokens", 0),
        output=u.get("output_tokens", 0),
        requests=d.get("num_turns", 0),
        first_prompt=None,  # aggregate-only output
    )

rows = []
for work in sorted(glob.glob(sys.argv[1] + "/runs/*")):
    name = os.path.basename(work)
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
