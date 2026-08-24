#!/usr/bin/env python3
"""RD-1 token cost — recomputed from raw traces, population declared.

WHY THIS EXISTS. RD-1B's first report put three different populations
in one paragraph: the cost-weighted total came from 18 original cells
plus a re-run C2, the request count from the original 20, and the input
total from the original 20 with the re-run stacked ON TOP. Each number
was individually derivable and no two described the same experiment.
Nothing in the pipeline made the population visible, so nothing caught
it.

So: one script, the population named in the output of every table, and
no total that mixes arms or batches. Run it and the report's numbers are
re-derivable from the archived artifacts alone.

Cost-weighted tokens = freshInput + 0.1 x cacheRead + output — cached
input is billed at roughly a tenth, so a raw token sum flatters whoever
caches more and tells you nothing about spend.

Reading:
  kiso  request rows in home/sessions/traces/*.jsonl (schemaVersion 4:
        freshInput / cacheRead / cacheWrite / output)
  pi    assistant messages in pi-sessions/*.jsonl (usage.input is the
        UNCACHED input — usage.cacheRead is separate)

Reads the tracked archive by default, so it reproduces in a fresh
clone; `--live` reads the working directory instead. Absent evidence is
an error, never an empty table.

Usage:  python3 bench/rd1/harness/metrics.py rd1b-kiso rd1b-pi
        python3 bench/rd1/harness/metrics.py --live rd1b-kiso rd1b-pi
"""
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from batches import BatchUnavailable, cells as batch_cells, open_batch  # noqa: E402

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(RD1, "out")
FIELDS = ("requests", "fresh", "cacheRead", "cacheWrite", "output")


def blank():
    return dict.fromkeys(FIELDS, 0)


def read_kiso(cell_dir):
    m = blank()
    for f in glob.glob(os.path.join(cell_dir, "home/sessions/traces/*.jsonl")):
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("kind") != "request":
                continue
            m["requests"] += 1
            m["fresh"] += r.get("freshInput") or 0
            m["cacheRead"] += r.get("cacheRead") or 0
            m["cacheWrite"] += r.get("cacheWrite") or 0
            m["output"] += r.get("output") or 0
    return m


def read_pi(cell_dir):
    m = blank()
    for f in glob.glob(os.path.join(cell_dir, "pi-sessions/*.jsonl")):
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            msg = r.get("message") or {}
            usage = msg.get("usage")
            if not usage or msg.get("role") != "assistant":
                continue
            m["requests"] += 1
            m["fresh"] += usage.get("input") or 0
            m["cacheRead"] += usage.get("cacheRead") or 0
            m["cacheWrite"] += usage.get("cacheWrite") or 0
            m["output"] += usage.get("output") or 0
    return m


def cost_weighted(m):
    return m["fresh"] + 0.1 * m["cacheRead"] + m["output"]


def total_input(m):
    return m["fresh"] + m["cacheRead"]


def cache_hit(m):
    return m["cacheRead"] / max(1, total_input(m))


def collect(batch, live=False):
    """Every cell's usage, plus whether the driver EXCLUDED that cell.

    Both are read inside the materialization context: the temp
    extraction is gone by the time the caller does arithmetic, so
    nothing here may return a path.
    """
    with open_batch(batch, live=live) as root:
        reader = read_pi if glob.glob(os.path.join(root, "*/pi-sessions")) else read_kiso
        names = batch_cells(root)
        if not names:
            raise BatchUnavailable(f"{batch}: zero cells — there is no evidence here")
        out = {}
        for cell in names:
            d = os.path.join(root, cell)
            m = reader(d)
            m["excluded"] = _excluded(d)
            out[cell] = m
        return out


def _excluded(cell_dir):
    """A cell the driver declared untestable for this agent: every axis
    N/A. Reading the recorded verdict, not re-deriving it — rescore.py
    owns verdicts, this file owns cost."""
    try:
        v = json.load(open(os.path.join(cell_dir, "run.json")))["verdict"]
    except Exception:
        return False
    ax = v.get("axes", {})
    return bool(ax) and all(x == "N/A" for x in ax.values())


def summed(cells, keys):
    s = blank()
    for k in keys:
        for f in FIELDS:
            s[f] += cells[k][f]
    return s


def main():
    argv = sys.argv[1:]
    live = "--live" in argv
    batches = [a for a in argv if not a.startswith("--")]
    if not batches:
        print(__doc__)
        return 2
    try:
        data = {b: collect(b, live=live) for b in batches}
    except BatchUnavailable as exc:
        print(f"[rd1:metrics] FAIL — {exc}", file=sys.stderr)
        return 1
    # A cell with ZERO requests is evidence loss, not a cheap cell: every
    # cell in every batch recorded at least one request, because a run
    # that never called the model is a run that never happened. Checking
    # only "the whole batch is empty" let a single cell's traces vanish
    # and quietly deflate the total — 93 requests silently became 86 in
    # the test that found this.
    # (Zero COST with requests > 0 is different and legitimate: C7's cut
    # stream returns no usage. That case is dropped from the paired
    # comparison, loudly, further down.)
    for b, cells_ in data.items():
        empty = [c for c in cells_ if cells_[c]["requests"] == 0]
        if empty:
            print(f"[rd1:metrics] FAIL — {b}: {len(empty)} cell(s) recorded no requests at all "
                  f"({', '.join(empty)}) — usage evidence is missing, not zero", file=sys.stderr)
            return 1

    for b in batches:
        cells = data[b]
        t = summed(cells, list(cells))
        print(f"\n[rd1:metrics] POPULATION = every cell in {b} ({len(cells)} cells) — no cell "
              f"from any other batch is mixed in")
        print(f"  cost-weighted {cost_weighted(t):12,.1f}   requests {t['requests']:4d}   "
              f"total input {total_input(t):9,d}   fresh {t['fresh']:8,d}   "
              f"output {t['output']:7,d}   cache hit {cache_hit(t) * 100:.2f}%")

    if len(batches) != 2:
        return 0
    a, b = batches
    common = sorted(set(data[a]) & set(data[b]),
                    key=lambda c: (int(c.split("-")[0][1:]), c))
    # A paired comparison only means anything over cells where both arms
    # ran THE SAME SCENARIO. Two ways that fails, and both are dropped
    # here rather than averaged in:
    #   - an arm produced no traffic at all;
    #   - an arm's scenario was EXCLUDED WITH REASON (its verdict is
    #     all-N/A) — pi has no approval surface for C5 and its endpoint
    #     is not retargetable for C7, so pi ran an easier world in both.
    #     Charging kiso for work pi was never asked to do is not a cost
    #     comparison.
    paired, dropped = [], []
    for c in common:
        why = None
        if not (data[a][c]["requests"] and data[b][c]["requests"]):
            why = "an arm sent no requests"
        elif not (cost_weighted(data[a][c]) and cost_weighted(data[b][c])):
            why = "an arm recorded no usage"
        elif data[a][c]["excluded"] or data[b][c]["excluded"]:
            why = "excluded-with-reason in " + (a if data[a][c]["excluded"] else b)
        (dropped if why else paired).append((c, why) if why else c)
    ta, tb = summed(data[a], paired), summed(data[b], paired)
    print(f"\n[rd1:metrics] POPULATION = the {len(paired)} cells where BOTH arms ran the SAME scenario")
    for c, why in dropped:
        print(f"  dropped {c}: {why}")
    print(f"  {a:22s} cost-weighted {cost_weighted(ta):11,.1f}   total input {total_input(ta):9,d}")
    print(f"  {b:22s} cost-weighted {cost_weighted(tb):11,.1f}   total input {total_input(tb):9,d}")
    print(f"  aggregate ratio {b}/{a} = {cost_weighted(tb) / cost_weighted(ta):.2f}x")
    # The mechanism, on THIS population — quoted in the report, so it is
    # printed here rather than recomputed by hand somewhere else.
    print(f"  mechanism: total input {total_input(tb) / total_input(ta):.2f}x   "
          f"uncached input {tb['fresh'] / max(1, ta['fresh']):.2f}x   "
          f"cache hit {cache_hit(ta) * 100:.2f}% vs {cache_hit(tb) * 100:.2f}%")

    ratios = []
    print("\n  per-cell ratio (the aggregate hides these — one cell can carry it):")
    for c in paired:
        ca, cb = cost_weighted(data[a][c]), cost_weighted(data[b][c])
        ratios.append(cb / ca)
        flag = f"  <- {a} is the expensive arm here" if cb < ca else ""
        print(f"    {c:8s} {ca:10,.1f}  {cb:10,.1f}   {cb / ca:6.2f}x{flag}")
    up = sum(1 for r in ratios if r > 1)
    print(f"\n  paired median {statistics.median(ratios):.2f}x over n={len(ratios)}   "
          f"{b} costs more in {up}/{len(ratios)} cells")
    print(f"  DIRECTION IS {'UNIFORM' if up == len(ratios) else 'NOT UNIFORM'} — "
          f"the median is the claim, the aggregate is not")

    # SENSITIVITY. One cell can carry an aggregate — c2-r2 runs 26x here
    # — so the report quotes what happens without each scenario. Those
    # numbers were hand-computed in the first issue; they are printed
    # now, because a number a tool does not emit is a number nobody
    # checks.
    print("\n  sensitivity — drop one scenario at a time (n is the surviving pair count):")
    scenarios = sorted({c.split("-")[0] for c in paired}, key=lambda x: int(x[1:]))
    for scn in scenarios:
        keep = [c for c in paired if not c.startswith(scn + "-")]
        if len(keep) < 2:
            continue
        ka, kb = summed(data[a], keep), summed(data[b], keep)
        rs = [cost_weighted(data[b][c]) / cost_weighted(data[a][c]) for c in keep]
        print(f"    without {scn.upper():4s} n={len(keep):2d}   "
              f"aggregate {cost_weighted(kb) / cost_weighted(ka):5.2f}x   "
              f"median {statistics.median(rs):5.2f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
