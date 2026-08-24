#!/usr/bin/env python3
"""The batch's published numbers, pinned and re-derived.

The reproduction gate proved the documented commands RUN in a fresh
clone. It did not prove they still produce the numbers the report
quotes. Those are two different promises, and the second is the one a
reader actually depends on: a scorer change, a metric change or a
damaged archive could all keep the commands green while moving every
figure in the report.

So the figures are a tracked artifact. `--write` pins what the tools
currently derive; `--check` re-derives and compares, naming every field
that moved. The report's grid, its cost tables, its sensitivity rows and
Appendix A's counts all come from here, so none of them can drift
without the build going red.

Pinning is not blessing: `--write` records what the tools say TODAY. A
figure that moves is a question to answer, and re-pinning without an
answer is how a benchmark starts lying slowly.

Usage:  python3 bench/rd1/harness/expectations.py --write rd1b-kiso rd1b-pi
        python3 bench/rd1/harness/expectations.py --check rd1b-kiso rd1b-pi
"""
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import metrics as M  # noqa: E402
import rescore as R  # noqa: E402
from batches import ARTIFACTS, BatchUnavailable, cells, open_batch  # noqa: E402

DEFAULT_PIN = os.path.join(ARTIFACTS, "expected.json")


def pin_path(name):
    return DEFAULT_PIN if not name else os.path.join(ARTIFACTS, f"expected-{name}.json")


def derive(batches):
    out = {"batches": {}, "paired": None}
    usage = {}
    for batch in batches:
        with open_batch(batch) as root:
            grid, tally_pass, tally_total = {}, 0, 0
            for cell in cells(root):
                v, _, _ = R.score_cell(root, cell)
                ax = v.get("axes", {})
                grid[cell] = {"A0": v.get("injection_integrity"), **{a: ax.get(a) for a in R.AXES}}
                if v.get("injection_integrity") == "FAIL" or all(x == "N/A" for x in ax.values()):
                    continue
                tally_total += 1
                tally_pass += all(ax.get(a) in ("PASS", "N/A") for a in R.AXES)
        u = M.collect(batch)
        usage[batch] = u
        t = M.summed(u, list(u))
        out["batches"][batch] = {
            "cells": len(grid),
            "grid": grid,
            "postHocTally": {"passed": tally_pass, "scored": tally_total},
            "usage": {
                "requests": t["requests"], "fresh": t["fresh"], "cacheRead": t["cacheRead"],
                "output": t["output"], "totalInput": M.total_input(t),
                "costWeighted": round(M.cost_weighted(t), 1),
                "cacheHitPct": round(M.cache_hit(t) * 100, 2),
            },
        }

    if len(batches) == 2:
        a, b = batches
        paired = [c for c in usage[a] if c in usage[b]
                  and usage[a][c]["requests"] and usage[b][c]["requests"]
                  and M.cost_weighted(usage[a][c]) and M.cost_weighted(usage[b][c])
                  and not usage[a][c]["excluded"] and not usage[b][c]["excluded"]]
        paired.sort(key=lambda c: (int(c.split("-")[0][1:]), c))
        ta, tb = M.summed(usage[a], paired), M.summed(usage[b], paired)
        ratios = [M.cost_weighted(usage[b][c]) / M.cost_weighted(usage[a][c]) for c in paired]
        sens = {}
        for scn in sorted({c.split("-")[0] for c in paired}, key=lambda x: int(x[1:])):
            keep = [c for c in paired if not c.startswith(scn + "-")]
            if len(keep) < 2:
                continue
            ka, kb = M.summed(usage[a], keep), M.summed(usage[b], keep)
            rs = [M.cost_weighted(usage[b][c]) / M.cost_weighted(usage[a][c]) for c in keep]
            sens[scn] = {"n": len(keep),
                         "aggregate": round(M.cost_weighted(kb) / M.cost_weighted(ka), 2),
                         "median": round(statistics.median(rs), 2)}
        out["paired"] = {
            "arms": [a, b], "cells": paired, "n": len(paired),
            "aggregate": round(M.cost_weighted(tb) / M.cost_weighted(ta), 2),
            "median": round(statistics.median(ratios), 2),
            "moreExpensiveCells": sum(1 for r in ratios if r > 1),
            "totalInputRatio": round(M.total_input(tb) / M.total_input(ta), 2),
            "uncachedInputRatio": round(tb["fresh"] / ta["fresh"], 2),
            "cacheHitPct": [round(M.cache_hit(ta) * 100, 2), round(M.cache_hit(tb) * 100, 2)],
            "requests": [ta["requests"], tb["requests"]],
            "costPerRequest": [round(M.cost_weighted(ta) / ta["requests"], 1),
                               round(M.cost_weighted(tb) / tb["requests"], 1)],
            "sensitivity": sens,
        }
    return out


def diff(pinned, live, path=""):
    """Every leaf that moved, as `field: pinned -> live`."""
    rows = []
    if isinstance(pinned, dict) and isinstance(live, dict):
        for k in sorted(set(pinned) | set(live)):
            rows += diff(pinned.get(k, "<absent>"), live.get(k, "<absent>"), f"{path}.{k}" if path else k)
    elif isinstance(pinned, list) and isinstance(live, list):
        if pinned != live:
            rows.append(f"{path}: {pinned} -> {live}")
    elif pinned != live:
        rows.append(f"{path}: {pinned} -> {live}")
    return rows


def main():
    argv = sys.argv[1:]
    write = "--write" in argv
    check = "--check" in argv
    name = ""
    if "--pin" in argv:
        name = argv[argv.index("--pin") + 1]
        argv = [x for i, x in enumerate(argv) if i not in (argv.index("--pin"), argv.index("--pin") + 1)]
    batches = [a for a in argv if not a.startswith("--")]
    PIN = pin_path(name)
    if not batches or not (write or check):
        print(__doc__)
        return 2
    try:
        live = derive(batches)
    except BatchUnavailable as exc:
        print(f"[rd1:expected] FAIL — {exc}", file=sys.stderr)
        return 1
    except R.ScoringError as exc:
        print(f"[rd1:expected] FAIL — {exc}", file=sys.stderr)
        return 1

    if write:
        os.makedirs(ARTIFACTS, exist_ok=True)
        with open(PIN, "w") as fh:
            json.dump(live, fh, indent=1, sort_keys=True)
            fh.write("\n")
        p = live["paired"]
        print(f"[rd1:expected] pinned {len(batches)} batches -> {os.path.relpath(PIN, os.path.dirname(ARTIFACTS))}"
              + (f" (paired n={p['n']}, median {p['median']}x, aggregate {p['aggregate']}x)" if p else ""))
        return 0

    if not os.path.exists(PIN):
        print(f"[rd1:expected] FAIL — no pin file; run --write once and track it", file=sys.stderr)
        return 1
    pinned = json.load(open(PIN))
    rows = diff(pinned, live)
    if rows:
        print("[rd1:expected] FAIL — published figures moved:", file=sys.stderr)
        for r in rows[:40]:
            print(f"  {r}", file=sys.stderr)
        if len(rows) > 40:
            print(f"  ... and {len(rows) - 40} more", file=sys.stderr)
        return 1
    p = live["paired"]
    print(f"[rd1:expected] OK — every published figure re-derives"
          + (f" (paired n={p['n']}, median {p['median']}x, aggregate {p['aggregate']}x)" if p else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
