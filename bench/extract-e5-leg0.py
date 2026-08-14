#!/usr/bin/env python3
"""E5 Leg 0 — the FLAT-composition activation extractor (extract-e5-leg0.py).

The question the insurance leg answers BEFORE the conditional exists: does
the task extension's plan-guidance make the model ACTUALLY plan (call
task_set) on (a) a planning-designed multi-step prompt (T5S — the guidance's
own trigger) and (b) the T6-class long session (T6S, 24 progressive turns)?
Metrics per run, trace-derived (the E4 extractor's shape):

  - activation: task_set invocations from the trace toolCalls;
  - requests, cacheWrite, costWeighted (input + 0.1*cacheRead), wall;
  - verifiedPass: the per-task verify (T5S: tests + --min check; T6S: the
    T6 verify);
  - rentHasTask / rentChars: the rent-ledger arm proof — a FLAT run carries
    system:ext:task + tool:task_set, a conditional/simple run does not.

Run: python3 bench/extract-e5-leg0.py <round>
"""
import json, os, sys, glob


def extract_run(run):
    meta_path = f"{run}/meta.json"
    if not os.path.exists(meta_path):
        raise ValueError(f"[extract-e5-leg0] {os.path.basename(run)}: refusing an unlabeled run — no meta.json")

    reqs = []
    for f in glob.glob(f"{run}/kiso-home/sessions/traces/*.jsonl"):
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("kind") == "request":
                reqs.append(r)
    if not reqs:
        raise ValueError(f"[extract-e5-leg0] {os.path.basename(run)}: refusing an empty run — no trace requests")

    activation = sum(1 for r in reqs for t in r["toolCalls"] if t == "task_set")
    cost_wtd = sum(r["canonical"]["input"] + 0.1 * (r["canonical"]["cacheRead"] or 0) for r in reqs)
    cache_write = sum(r["canonical"]["cacheWrite"] or 0 for r in reqs)

    rent = None
    for r in reqs:
        if r.get("rent"):
            rent = r["rent"]
            break
    rent_has_task = bool(rent and any(
        l["surface"].startswith(("system:ext:task", "tool:task_set")) for l in rent))
    rent_chars = sum(l["chars"] for l in (rent or []))

    verified = None
    vf = f"{run}/verify"
    if os.path.exists(vf):
        verified = open(vf).read().strip() == "pass"

    return {"run": os.path.basename(run), "task": json.load(open(meta_path)).get("task"),
            "verifiedPass": verified, "activation": activation,
            "requests": len(reqs), "cacheWrite": cache_write,
            "costWeighted": round(cost_wtd, 1),
            "wall": int(open(f"{run}/wall_seconds").read().strip()),
            "rentHasTask": rent_has_task, "rentChars": rent_chars}


def main(round_dir):
    runs = [extract_run(work) for work in sorted(glob.glob(f"{round_dir}/*E5L0*"))]
    print(json.dumps({"runs": runs}, indent=1))
    return runs


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
