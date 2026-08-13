#!/usr/bin/env python3
"""E4-a — the T6-compact per-request curve (extract-t6c.py).

The long-session cost question needs the per-REQUEST curve, not the
per-bucket sums: does the cache-hit prefix grow faster than the fresh
input as the session accumulates ("longer = cheaper?")? The trace sidecar
carries fresh/cacheRead/cacheWrite/output + contextHash per request; the
session event log carries the microcompact BOUNDARIES. One row per
request: the usage quartet, contextHash, the bucket/turn it belongs to
(cut at user_input events, 6-turn windows per bucket), and the R3
boundary flag.

The R3 rule, adjudicated: a `microcompacted` event between two requests
IS the boundary — the event is the mechanism's own word; the contextHash
divergence is the CROSS-CHECK (the hash alone cannot distinguish a
boundary from a genuinely new prefix). A boundary whose contextHash did
not change is a boundary_mismatch — a FINDING, listed in the report,
never silently accepted.

E4-e guards, hard: a run without meta.json, an empty run, or a repeated
run identity within a round is REFUSED with an error — the extractor
never silently merges or invents evidence.

Run: python3 -m unittest tests/test_e4_t6c.py   (from bench/)
"""
import json, os, sys, glob

TURNS_PER_BUCKET = 6


def _events(run):
    """All event-log entries across the run's session logs (the traces
    sidecar lives under sessions/traces/ — excluded by the glob)."""
    out = []
    for f in glob.glob(f"{run}/kiso-home/sessions/*.jsonl"):
        if "/traces/" in f:
            continue
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            line_obj = json.loads(line)
            e = line_obj.get("event")
            if isinstance(e, dict):
                # the envelope carries ts; the event dict may not (real
                # session logs: {runId, ts, event:{type,...}}).
                if "ts" not in e and "ts" in line_obj:
                    e = dict(e, ts=line_obj["ts"])
                out.append(e)
    return out


def _requests(run):
    out = []
    for f in glob.glob(f"{run}/kiso-home/sessions/traces/*.jsonl"):
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("kind") != "request":
                continue
            out.append(r)
    return sorted(out, key=lambda r: r["ts"])


def extract_run(run):
    """One run → the per-request curve + boundaries + the E4-e guards."""
    meta_path = f"{run}/meta.json"
    if not os.path.exists(meta_path):
        raise ValueError(f"[extract-t6c] {os.path.basename(run)}: refusing an unlabeled run — no meta.json (E4-e)")
    reqs = _requests(run)
    if not reqs:
        raise ValueError(f"[extract-t6c] {os.path.basename(run)}: refusing an empty run — no trace requests (E4-e)")

    # the turn cuts: each user_input event starts a new turn (T6 pipes one
    # prompt per turn; the first usage after an input belongs to that turn)
    input_ts = [e["ts"] for e in _events(run) if e.get("type") == "user_input"]
    compacted_ts = [e["ts"] for e in _events(run) if e.get("type") == "microcompacted"]

    rows = []
    mismatches = []
    prev_ts = None
    prev_hash = None
    for r in reqs:
        ts = r["ts"]
        turn = sum(1 for t in input_ts if t <= ts)          # 1-based
        bucket = (turn - 1) // TURNS_PER_BUCKET + 1
        boundary = False
        if prev_ts is not None:
            boundary = any(t > prev_ts and t <= ts for t in compacted_ts)
        c = r["canonical"]
        mismatch = False
        if boundary and prev_hash == r["contextHash"]:
            mismatch = True
            mismatches.append({"requestIndex": r["requestIndex"], "ts": ts,
                               "turn": turn})
        rows.append({
            "requestIndex": r["requestIndex"], "ts": ts, "turn": turn,
            "bucket": bucket,
            "fresh": c["input"], "cacheRead": c["cacheRead"],
            "cacheWrite": c["cacheWrite"], "output": c["output"],
            "contextHash": r["contextHash"], "costWeighted": c["input"] + 0.1 * (c["cacheRead"] or 0),
            "boundary": boundary, "boundaryMismatch": mismatch,
        })
        prev_ts, prev_hash = ts, r["contextHash"]

    meta = json.load(open(meta_path))
    walls = {}
    for f in glob.glob(f"{run}/wall_*"):
        walls[os.path.basename(f)] = int(open(f).read().strip())
    return {"run": os.path.basename(run), "meta": meta,
            "requests": rows, "mismatches": mismatches,
            "walls": [walls[f"wall_{i}"] for i in sorted(
                int(f[5:]) for f in walls)],
            "verify": open(f"{run}/verify").read().strip()}


def scan_round(round_dir):
    """All T6C runs under the round's dir → the rows the report embeds."""
    seen = {}
    rows = []
    for work in sorted(glob.glob(f"{round_dir}/*T6C*")):
        name = os.path.basename(work)
        tool, task, seq = name.split("-", 2)          # kiso-T6C-<seq>
        identity = (tool, task, seq)
        if identity in seen:
            raise ValueError(
                f"[extract-t6c] round scan: repeated run identity {identity} "
                f"({seen[identity]} vs {work}) — a reused run name (E4-e)")
        seen[identity] = work
        row = extract_run(work)
        row["run"] = seq          # the parsed identity, not the dir name
        rows.append(row)
    return rows


def main(round_dir):
    print(json.dumps(scan_round(round_dir), indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
