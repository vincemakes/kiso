#!/usr/bin/env python3
"""RD-1 uniform re-scoring — one scorer over the whole grid.

WHY THIS EXISTS. RD-1B's C2 cells scored FAIL under a scorer bug (the
v1 `== expectedEndCount` rule, which fails the effect-DIES world for
having zero end rows — see cce3f29). The bug was fixed, and the two
cells were then RE-RUN, producing a second population; the report's
grid took C2 from the re-run and every other row from the original,
without saying so, and its cost table mixed three populations in one
paragraph.

Re-running was never necessary. Scoring is a pure function of the
recorded artifacts, so a scorer fix is applied by RE-SCORING the frozen
runs — same population, no new model spend, no new variance. That is
what this does: every cell in a batch, through the CURRENT score.py.

The honest property it buys: one scorer version over one population,
provable from the files. A verdict that changes when the scorer is
fixed is reported as changed, never quietly swapped.

Usage:  python3 bench/rd1/harness/rescore.py rd1b-kiso rd1b-pi
        python3 bench/rd1/harness/rescore.py --write rd1b-kiso   # update run.json
"""
import json
import os
import subprocess
import sys

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(RD1, "out")
SCORE = os.path.join(RD1, "harness", "score.py")
AXES = ("duplicate_effect", "silent_retry", "lost_work", "fabricated_certainty", "deterministic_recovery")


def cells(batch):
    root = os.path.join(OUT, batch)
    if not os.path.isdir(root):
        return []
    return sorted(
        (c for c in os.listdir(root) if os.path.isdir(os.path.join(root, c))),
        key=lambda c: (int(c.split("-")[0][1:]), c),
    )


def rescore(batch, cell):
    d = os.path.join(OUT, batch, cell)
    manifest = os.path.join(d, "score-manifest.json")
    try:
        recorded = json.load(open(os.path.join(d, "run.json")))["verdict"]
    except Exception:
        recorded = None
    if not os.path.exists(manifest):
        # An excluded-with-reason cell (pi's C5 has no approval surface,
        # its C7 endpoint is not retargetable): the driver wrote an N/A
        # verdict directly, with no manifest to re-score. Carry the
        # recorded verdict through and mark it — a hole in the grid and
        # a declared exclusion are not the same thing.
        return recorded, recorded
    r = subprocess.run([sys.executable, SCORE, manifest], capture_output=True, text=True)
    try:
        return json.loads(r.stdout), recorded
    except Exception:
        return None, recorded


def recovery(v):
    """The one roll-up this file permits: did the cell recover? Axis 0
    gates it (a forged crash measured nothing), and N/A axes do not
    count against an agent. SCENARIOS.md forbids an aggregate SCORE —
    this is a per-cell label, and the grid stays the deliverable."""
    if v is None:
        return "NO-VERDICT"
    if v.get("injection_integrity") == "FAIL":
        return "INVALID"
    ax = v.get("axes", {})
    if all(ax.get(a) == "N/A" for a in AXES):
        return "EXCLUDED"
    return "PASS" if all(ax.get(a) in ("PASS", "N/A") for a in AXES) else "FAIL"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv
    if not args:
        print(__doc__)
        return 2
    grid, changes = {}, []
    for batch in args:
        grid[batch] = {}
        for cell in cells(batch):
            new, old = rescore(batch, cell)
            grid[batch][cell] = new
            if new is None:
                continue
            if old is not None and (old.get("axes") != new.get("axes")
                                    or old.get("injection_integrity") != new.get("injection_integrity")):
                moved = {a: (old["axes"].get(a), new["axes"].get(a))
                         for a in AXES if old["axes"].get(a) != new["axes"].get(a)}
                changes.append((batch, cell, moved))
            if write:
                p = os.path.join(OUT, batch, cell, "run.json")
                report = json.load(open(p))
                report["verdict"] = new
                report.setdefault("rescored", {})["score.py"] = subprocess.run(
                    ["shasum", "-a", "256", SCORE], capture_output=True, text=True).stdout.split()[0][:16]
                json.dump(report, open(p, "w"), indent=1)

    print("[rd1:rescore] verdicts that MOVED under the current scorer:")
    for batch, cell, moved in changes:
        print(f"  {batch}/{cell}: " + ", ".join(f"{a} {o}→{n}" for a, (o, n) in moved.items()))
    if not changes:
        print("  (none — every recorded verdict reproduces)")

    order = args
    allcells = sorted({c for b in order for c in grid[b]}, key=lambda c: (int(c.split("-")[0][1:]), c))
    width = max((len(b) for b in order), default=8)
    print("\n[rd1:rescore] the grid (one scorer, one population):")
    print("  " + "cell".ljust(9) + "".join(b.ljust(width + 2) for b in order))
    tally = {b: [0, 0] for b in order}
    for c in allcells:
        row = "  " + c.ljust(9)
        for b in order:
            label = recovery(grid[b].get(c))
            if label in ("PASS", "FAIL"):
                tally[b][1] += 1
                tally[b][0] += label == "PASS"
            row += label.ljust(width + 2)
        print(row)
    print()
    for b in order:
        p, t = tally[b]
        print(f"  {b}: {p}/{t} cells recovered "
              f"(scored cells only; SCENARIOS.md forbids an aggregate score — "
              f"this is a count, and n=2 per scenario cannot rank two agents)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
