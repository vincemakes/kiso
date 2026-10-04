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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usage_marker import usage_marker, unmeasured, MISSING, MALFORMED  # F33-RR3

def unknown_in_session_log(path):
    """How many requests in a PLAIN session log had no reported usage.

    F33-1: pre-v5 sidecars cannot tell an unmeasured request from a free
    one — the writer's own convention is "0 = unknown". The plain log kept
    the flag, so for those generations it is the surviving source of
    known-ness. A session whose plain log is gone is UNDECIDABLE, which is
    reported as incomplete rather than as complete.
    """
    n = 0
    if not os.path.exists(path):
        return None
    for line in open(path):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        e = r.get("event")
        if not isinstance(e, dict) or e.get("type") != "usage":
            continue
        i, ca, o = e.get("inputTokens"), e.get("cacheRead"), e.get("outputTokens")
        if e.get("known") is False or i is None or ca is None or o is None:
            n += 1
    return n


def kiso(work):
    sessions = f"{work}/kiso-home/sessions"
    traced = set()
    for p in glob.glob(f"{sessions}/traces/*.jsonl"):
        traced.add(os.path.basename(p)[:-6])
    files = sorted(glob.glob(f"{sessions}/traces/*.jsonl") +
                   [p for p in glob.glob(f"{sessions}/*.jsonl")
                    if os.path.basename(p)[:-6] not in traced])
    fresh = out = cache = reqs = unknown = 0
    reasoning = reasoning_reported = 0
    pre_v5_sessions = set()
    for f in files:
        for line in open(f):
            r = json.loads(line)
            if "canonical" in r:                      # v2 ledger: the canonical block
                # F33-1: a v5 record SAYS whether the provider reported;
                # before v5 an unmeasured request and a free one are the
                # same four zeros, so the sibling plain log decides.
                mk = usage_marker(r)
                if unmeasured(mk):
                    reqs += 1
                    unknown += 1
                    if mk == MALFORMED:
                        print(f"[extract] {f}: usageKnown is {r['usageKnown']!r}, not a boolean"
                              " — counted as UNMEASURED", file=sys.stderr)
                    continue
                if r.get("kind") == "request" and mk == MISSING:
                    pre_v5_sessions.add(os.path.basename(f)[:-6])
                c = r["canonical"]
                fr, ca, o = c["input"], c["cacheRead"], c["output"]
            elif r.get("kind") == "request":          # v1 ledger: the guard's fresh
                mk = usage_marker(r)
                if unmeasured(mk):
                    reqs += 1
                    unknown += 1
                    if mk == MALFORMED:
                        print(f"[extract] {f}: usageKnown is {r['usageKnown']!r}, not a boolean"
                              " — counted as UNMEASURED", file=sys.stderr)
                    continue
                if mk == MISSING:
                    pre_v5_sessions.add(os.path.basename(f)[:-6])
                fr, ca, o = r["freshInput"], r["cacheRead"], r["output"]
            else:
                e = r.get("event")
                if not isinstance(e, dict) or e.get("type") != "usage":
                    continue
                # UNKNOWN IS NOT ZERO — the runtime keeps null out of the
                # token fields on purpose (Area 6); reading them as `or 0`
                # spends an unmeasured request as a free one.
                i, ca, o = e.get("inputTokens"), e.get("cacheRead"), e.get("outputTokens")
                if e.get("known") is False or i is None or ca is None or o is None:
                    reqs += 1
                    unknown += 1
                    continue
                fr = i - ca                           # legacy session log
            reqs += 1
            fresh += fr; cache += ca; out += o
            # THE REASONING SPLIT. This extractor never read it, so every T5
            # row reported reasoning as 0 for BOTH arms — and 0 that was
            # never read is not 0 that was measured. The T6 extractor has
            # read it since schema 6; this is the same field, the same rule:
            # summed only where STATED, with a count of how many requests
            # stated it, because an absent split is not a split of zero.
            _rsn = (r.get("canonical", {}).get("reasoning") if isinstance(r.get("canonical"), dict) else None)
            if _rsn is None:
                _rsn = r.get("reasoningTokens")
            if _rsn is None and isinstance(r.get("event"), dict):
                _rsn = r["event"].get("reasoningTokens")
            if isinstance(_rsn, int):
                reasoning += _rsn
                reasoning_reported += 1
    undecidable = 0
    for sid in sorted(pre_v5_sessions):
        n = unknown_in_session_log(f"{sessions}/{sid}.jsonl")
        if n is None:
            undecidable += 1
        else:
            unknown += n
    return dict(input=fresh, cache_read=cache, output=out, requests=reqs,
                fresh=fresh, total=fresh + cache, cost_weighted=fresh + 0.1 * cache,
                cost_equivalent=fresh + 0.02 * cache + 4 * out,
                reasoning=reasoning, reasoning_reported=reasoning_reported,
                unknown_requests=unknown,
                usage_incomplete=unknown > 0 or undecidable > 0,
                undecidable_sessions=undecidable)

def completion_role(ev):
    """What a pi `message_end` IS: "assistant", another role, or unknown.

    F33-R2: pi emits message_end for user messages and tool results too —
    the real calibration archive holds 8 user, 32 assistant and 24
    toolResult — and counting all of them doubled a fully measured
    32-request leg to 64 with 32 "unknown".

    A MISSING role is its own answer and neither of the two convenient
    ones. Calling it assistant re-admits the events R2 exists to exclude;
    dropping it makes a request vanish, which is the same error one level
    earlier. So it is counted as a completion whose usage is UNKNOWN: the
    leg goes incomplete and says so, rather than being silently inflated or
    silently shrunk.

    The request COUNTER shares this predicate. Two definitions of "a
    request" is how a leg's count and its ledger stop agreeing.
    """
    msg = ev.get("message")
    if not isinstance(msg, dict):
        return None
    role = msg.get("role")
    return role if isinstance(role, str) and role != "" else None


def pi(work):
    inp = out = cache = reqs = unknown = 0
    reasoning = reasoning_reported = 0
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
            # F33-R2: only an ASSISTANT completion is a model request.
            # Native pi emits message_end for user messages and tool results
            # too — the real calibration archive holds 8 user, 32 assistant
            # and 24 toolResult — and counting all of them doubled a fully
            # measured 32-request leg to 64 with 32 "unknown".
            #
            # F33-2's rule stands and simply applies to completions: one
            # nobody measured is still one, so the role is checked before
            # the usage and the usage after.
            _role = completion_role(ev)
            if _role is not None and _role != "assistant":
                continue
            reqs += 1
            if _role is None:
                unknown += 1
                continue
            m = ev.get("message")
            u = (m.get("usage") if isinstance(m, dict) else None) or {}
            i, ca, o = (u.get("input"), u.get("cacheRead"), u.get("output")) if isinstance(u, dict) else (None, None, None)
            if i is None or ca is None or o is None:
                unknown += 1
                continue
            inp += i; cache += ca; out += o
            # The other arm reports its split under `reasoning`, not our
            # spelling. Reading only ours made it look as though that
            # product reported no thinking at all — the shape of a false
            # comparison, and the same mistake the T6 extractor already
            # had corrected.
            _rsn = u.get("reasoning")
            if isinstance(_rsn, int):
                reasoning += _rsn
                reasoning_reported += 1
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache,
                cost_equivalent=inp + 0.02 * cache + 4 * out,
                reasoning=reasoning, reasoning_reported=reasoning_reported,
                unknown_requests=unknown, usage_incomplete=unknown > 0)

def claude(work):
    # CC ≥2.1.233 prints warning lines that carry a JSON fragment
    # (`[claude-code:...] {...}`) — whole-file json.load fails and the old
    # `except: continue` silently ZEROED the run. Parse per line; keep the
    # last object with a usage block; loud failure when no turn parses.
    inp = out = cache = reqs = seen = unknown = 0
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
            # F33-2: the LAST result line is this leg's completion, with or
            # without a usage block. Keeping only lines that carry one meant
            # a turn whose usage went missing was not counted at all, and a
            # leg with one good turn reported "usage complete".
            if o.get("type") == "result" or "usage" in o:
                d = o
        if d is None:
            continue
        seen += 1
        u = d.get("usage") or {}
        i_, c_, o_ = u.get("input_tokens"), u.get("cache_read_input_tokens"), u.get("output_tokens")
        # a completion with no turn count is still one completion
        reqs += d.get("num_turns", 0) or 1
        if i_ is None or c_ is None or o_ is None:
            unknown += 1
            continue
        inp += i_; cache += c_; out += o_
    if seen == 0:
        raise ValueError("no usage JSON line in any stdout-N.log")
    return dict(input=inp, cache_read=cache, output=out, requests=reqs,
                fresh=inp, total=inp + cache, cost_weighted=inp + 0.1 * cache,
                cost_equivalent=inp + 0.02 * cache + 4 * out,
                unknown_requests=unknown, usage_incomplete=unknown > 0)

def main(workdir, task=None):
    """`task` (the 0.46.0 evaluation): the legs of THAT task anywhere under
    `workdir` — a round directory included (`kiso-<task>-<run>`). Without
    it, the T5 legs under `workdir/runs/`, as before."""
    rows = []
    legs = (sorted(glob.glob(workdir + f"/**/kiso-{task}-*", recursive=True)) if task
            else sorted(glob.glob(workdir + "/runs/*T5*")))
    for work in legs:
        if not os.path.isdir(work):
            continue
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
    main(sys.argv[1] if len(sys.argv) > 1 else ".", sys.argv[2] if len(sys.argv) > 2 else None)
