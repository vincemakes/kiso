#!/usr/bin/env python3
"""E4-b — the planning eval (extract-planning.py).

The question: the task extension costs 945 chars / 237 est. tokens per
request (E3's measured rent: the task_set spec 551 + the plan-guidance
append 394). Does it BUY anything? The eval runs the same task set twice:
ON (the default bench composition, task extension loaded) and OFF (the
same composition with a name-only "task" shell shadowing the built-in —
the builtInLayer rule; the shell pays zero). Trace-derived metrics per
run, zero runtime changes:

  - requests, cacheWrite (the destructive-churn proxy), rework
    (tool_execution_failed receipts), costWeighted, wall;
  - verified pass: the per-task verify files (T2: clamp.test.js,
    T3: user.test.js + cli.js);
  - activation (ON only): task_set invocations per task, read from the
    trace toolCalls — the append instructs one up-front call for 3+ step
    tasks; the model decides. A low activation with a high pass rate is
    the dead-weight hypothesis strengthened; a high rate with less rework
    is the insurance hypothesis.
  - the rent-ledger arm detector: an ON record carries system:ext:task +
    tool:task_set, an OFF record does not — E3's ledger is the arm proof
    (measured delta: 394 + 551 chars per request), never a transcription.

Verdict rule (adjudicated, E4 measures but never cuts): OFF fails where
ON passes → insurance-holds; OFF passes the same tasks AND is cheaper on
either metric → reduction-candidate for E5/E6; OFF passes nothing →
dead-weight.

Run: python3 -m unittest tests/test_e4_planning.py   (from bench/)
"""
import json, os, sys, glob

TASK_SET = ("T2", "T3")


def extract_run(run):
    meta_path = f"{run}/meta.json"
    if not os.path.exists(meta_path):
        raise ValueError(f"[extract-planning] {os.path.basename(run)}: refusing an unlabeled run — no meta.json (E4-e)")

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
        raise ValueError(f"[extract-planning] {os.path.basename(run)}: refusing an empty run — no trace requests (E4-e)")

    requests = len(reqs)
    cache_write = sum(r["canonical"]["cacheWrite"] or 0 for r in reqs)
    cost_wtd = sum(r["canonical"]["input"] + 0.1 * (r["canonical"]["cacheRead"] or 0) for r in reqs)
    activation = sum(1 for r in reqs for t in r["toolCalls"] if t == "task_set")

    rework = 0
    for f in glob.glob(f"{run}/kiso-home/sessions/*.jsonl"):
        if "/traces/" in f:
            continue
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            e = json.loads(line).get("event")
            if isinstance(e, dict) and e.get("type") == "tool_execution_failed":
                rework += 1

    tasks, verified = [], 0
    for task in TASK_SET:
        vf = f"{run}/verify-{task}"
        if os.path.exists(vf):
            tasks.append(task)
            if open(vf).read().strip() == "pass":
                verified += 1

    rent = None
    for r in reqs:
        if r.get("rent"):
            rent = r["rent"]
            break
    rent_has_task = bool(rent and any(l["surface"].startswith(("system:ext:task", "tool:task_set")) for l in rent))
    rent_chars = sum(l["chars"] for l in (rent or []))

    return {"run": os.path.basename(run), "meta": json.load(open(meta_path)),
            "tasks": tasks, "verifiedPass": verified,
            "requests": requests, "cacheWrite": cache_write,
            "rework": rework, "activation": activation,
            "costWeighted": round(cost_wtd, 1),
            "wall": int(open(f"{run}/wall_seconds").read().strip()),
            "rentHasTask": rent_has_task, "rentChars": rent_chars}


def verdict(on, off):
    """The adjudicated rule: OFF fails → insurance-holds; OFF passes the
    same tasks AND is cheaper on either metric → reduction-candidate
    (E5/E6 terrain, never a cut in E4); OFF passes nothing → dead-weight."""
    if off["verifiedPass"] == 0:
        return {"class": "dead-weight"}
    if off["verifiedPass"] < on["verifiedPass"]:
        return {"class": "insurance-holds"}
    cheaper = off["costWeighted"] < on["costWeighted"] or off["wall"] < on["wall"]
    if cheaper:
        return {"class": "reduction-candidate"}
    return {"class": "insurance-holds"}


def main(round_dir):
    runs = [extract_run(work) for work in sorted(glob.glob(f"{round_dir}/*PLN*"))]
    on = [r for r in runs if "PLN-on-" in r["run"]]
    off = [r for r in runs if "PLN-off-" in r["run"]]
    out = {"runs": runs}
    if on and off:
        agg = lambda rs: {k: sum(r[k] for r in rs) for k in
                          ("verifiedPass", "requests", "cacheWrite",
                           "rework", "activation", "costWeighted", "wall")}
        a, b = agg(on), agg(off)
        out["arms"] = {"on": a, "off": b}
        out["verdict"] = verdict(a, b)
    print(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
