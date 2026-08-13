#!/usr/bin/env python3
"""Extract per-run metrics from each tool's own durable records.

ACCOUNTING (the 0.1.23 fresh-mystery round fixed a mislabeling here; E2
1.3.0 switched kiso to the CANONICAL schema — T7): the three tools report
"input" differently, and the extractor reduces EVERY line to the uniform
primitives fresh / cache_read / output before summing —
  kiso (1.3.0+): the per-request usage rides the TRACE SIDECAR
          (sessions/traces/<sid>.jsonl). The canonical block's input is
          FRESH-ONLY on BOTH routes (the pinned sentence); a v1 sidecar
          (pre-1.3.0) has no canonical block — its freshInput IS the
          guard's route-derived fresh (read as defaults, never a crash,
          R1d-1). A session with NO sidecar (the writer soft-failed)
          falls back to its session-log raw events: the legacy
          openai-compat derivation fresh = inputTokens − cache_read,
          captured once per line.
  pi:     usage.input = fresh-only (its cache read is reported separately)
          → fresh = input, total = input + cache_read.
  claude: input_tokens = fresh-only (Anthropic convention: cache reads are
          separate) → fresh = input, total = input + cache_read.
The output rows carry the uniform fields: input = fresh, fresh, total =
fresh + cache_read, cost_weighted = fresh + 0.1 × cache_read (0.1 is
DeepSeek's cache-hit price ratio,
https://api-docs.deepseek.com/quick_start/pricing). The v8-and-older kiso
tables kept the openai-compat raw shape (input = total) — on healthy data
the numbers are identical; the canonical switch fixes the >100% disease
(cache_read > inputTokens: the old fresh went NEGATIVE).

first_prompt = the first request's TRUE total (fresh + cache_read), the
pi shape. The v8-and-older value was inputTokens + cache_read — the
DeepSeek raw already includes the cache hit, so the cache was counted
twice; no README table ever rendered it, but the fix is pinned in
tests/test_extract.py so it stays honest.
"""
import json, os, sys, glob

def kiso(work):
    # The traced set: sessions whose ledger the trace dir covers — their
    # session logs are NOT also read (no double counting); untraced
    # sessions fall back to the session-log path.
    sessions = f"{work}/kiso-home/sessions"
    traced = set()
    for p in glob.glob(f"{sessions}/traces/*.jsonl"):
        traced.add(os.path.basename(p)[:-6])
    files = sorted(glob.glob(f"{sessions}/traces/*.jsonl") +
                   [p for p in glob.glob(f"{sessions}/*.jsonl")
                    if os.path.basename(p)[:-6] not in traced])
    fresh = out = cache = reqs = 0
    first = None
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
                    continue                          # header/run_end/crash, non-usage
                i = e.get("inputTokens") or 0
                ca = e.get("cacheRead") or 0
                o = e.get("outputTokens") or 0
                fr = i - ca                           # legacy session log: the 0.1.23 derivation
            reqs += 1
            fresh += fr; cache += ca; out += o
            if first is None: first = fr + ca
    return dict(input=fresh, cache_read=cache, output=out, requests=reqs,
                fresh=fresh, total=fresh + cache, cost_weighted=fresh + 0.1 * cache,
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
