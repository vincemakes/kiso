#!/usr/bin/env python3
"""RD-1 re-scoring — one scorer, the five axes, from the tracked archive.

WHY RE-SCORING. RD-1B's C2 cells failed under a scorer bug (the v1
`== expectedEndCount` rule, which fails the effect-DIES world for having
zero end rows — cce3f29). The bug was fixed and the two cells were then
RE-RUN, producing a second population; the report's grid took C2 from
the re-run and every other row from the original without saying so.

Re-running was never necessary. Scoring is a pure function of the
recorded artifacts, so a scorer fix is applied by RE-SCORING the frozen
runs: same population, no new model spend, no new variance. Verdicts
that move are printed as moved, never swapped in quietly.

WHAT IT PRINTS. SCENARIOS.md freezes the deliverable: "the 10x5 grid
(plus C5's two approval fields), each cell carrying its observation
sentence", and "No aggregate score exists". So this prints Axis 0, the
five axes, and every observation — and NOT a whole-cell verdict.
Collapsing five axes into one PASS/FAIL and counting those is the same
aggregate the protocol forbids; replacing a percentage with a count does
not change that. `--post-hoc-tally` will print counts, labelled as the
post-hoc description they are.

Reads the tracked archive by default, so it reproduces in a fresh clone.

Usage:  python3 bench/rd1/harness/rescore.py rd1b-kiso rd1b-pi
        python3 bench/rd1/harness/rescore.py --post-hoc-tally rd1b-kiso rd1b-pi
        python3 bench/rd1/harness/rescore.py --live --write rd1b-kiso
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from batches import BatchUnavailable, cells, open_batch, relocate  # noqa: E402

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCORE = os.path.join(RD1, "harness", "score.py")
AXES = ("duplicate_effect", "silent_retry", "lost_work", "fabricated_certainty", "deterministic_recovery")
SHORT = {"duplicate_effect": "dup", "silent_retry": "retry", "lost_work": "lost",
         "fabricated_certainty": "fab", "deterministic_recovery": "det"}


class ScoringError(Exception):
    """A cell could not be scored — never silently skipped."""


def score_cell(root, cell):
    """Re-score one cell. Returns (verdict, recorded_verdict, source)."""
    d = os.path.join(root, cell)
    try:
        recorded = json.load(open(os.path.join(d, "run.json")))["verdict"]
    except Exception as exc:
        raise ScoringError(f"{cell}: no recorded verdict in run.json ({exc})")
    mpath = os.path.join(d, "score-manifest.json")
    if not os.path.exists(mpath):
        # An excluded-with-reason cell: the driver wrote an N/A verdict
        # directly and there is nothing to re-derive. A hole in the grid
        # and a declared exclusion are different things — but a cell with
        # NEITHER manifest nor verdict is a hole, and raises above.
        return recorded, recorded, "recorded (excluded-with-reason: no manifest to re-score)"
    manifest = relocate(json.load(open(mpath)), root)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(manifest, fh)
        tmp = fh.name
    try:
        r = subprocess.run([sys.executable, SCORE, tmp], capture_output=True, text=True)
        if r.returncode != 0:
            raise ScoringError(f"{cell}: score.py exited {r.returncode}: {r.stderr.strip()[:200]}")
        try:
            return _derooted(json.loads(r.stdout), root), recorded, "re-scored"
        except ValueError as exc:
            raise ScoringError(f"{cell}: score.py emitted unparseable output ({exc})")
    finally:
        os.unlink(tmp)


def _derooted(value, root):
    """Strip the materialization root out of observation text.

    The scorer names the paths it checked, so an observation would carry
    a temp directory here and someone's home directory there — and the
    observation sentence IS the deliverable, something people diff
    between batches. Paths are reported relative to the batch root, so
    two runs of this tool on two machines produce the same bytes.
    """
    if isinstance(value, str):
        return value.replace(root + os.sep, "").replace(root, "")
    if isinstance(value, dict):
        return {k: _derooted(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [_derooted(v, root) for v in value]
    return value


def main():
    argv = sys.argv[1:]
    live = "--live" in argv
    write = "--write" in argv
    tally = "--post-hoc-tally" in argv
    batches = [a for a in argv if not a.startswith("--")]
    if not batches:
        print(__doc__)
        return 2
    if write and not live:
        print("[rd1:rescore] --write edits run.json in place; pass --live too", file=sys.stderr)
        return 2

    grid, moved, errors = {}, [], []
    for batch in batches:
        try:
            with open_batch(batch, live=live) as root:
                names = cells(root)
                if not names:
                    errors.append(f"{batch}: zero cells — there is no evidence here")
                    continue
                grid[batch] = {}
                for cell in names:
                    try:
                        new, old, source = score_cell(root, cell)
                    except ScoringError as exc:
                        errors.append(str(exc))
                        continue
                    grid[batch][cell] = (new, source)
                    if old and (old.get("axes") != new.get("axes")
                                or old.get("injection_integrity") != new.get("injection_integrity")):
                        moved.append((batch, cell, {a: (old["axes"].get(a), new["axes"].get(a))
                                                    for a in AXES if old["axes"].get(a) != new["axes"].get(a)}))
                    if write:
                        p = os.path.join(root, cell, "run.json")
                        report = json.load(open(p))
                        report["verdict"] = new
                        json.dump(report, open(p, "w"), indent=1)
        except BatchUnavailable as exc:
            errors.append(f"{batch}: {exc}")

    if errors:
        print("[rd1:rescore] FAIL — evidence missing or unscorable:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print("[rd1:rescore] verdicts that MOVED under the current scorer:")
    for batch, cell, diff in moved:
        print(f"  {batch}/{cell}: " + ", ".join(f"{a} {o}->{n}" for a, (o, n) in diff.items()))
    if not moved:
        print("  (none — every recorded verdict reproduces)")

    hdr = "cell".ljust(9) + "A0".ljust(7) + "".join(SHORT[a].ljust(7) for a in AXES)
    for batch in batches:
        print(f"\n[rd1:rescore] {batch} — Axis 0 and the five axes "
              f"({len(grid[batch])} cells; the frozen deliverable, no whole-cell verdict)")
        print("  " + hdr)
        print("  " + "".ljust(9) + "(A0=injection_integrity  dup=duplicate_effect  "
              "retry=silent_retry  lost=lost_work  fab=fabricated_certainty  det=deterministic_recovery)")
        for cell, (v, _) in grid[batch].items():
            row = "  " + cell.ljust(9) + str(v.get("injection_integrity", "?")).ljust(7)
            row += "".join(str(v.get("axes", {}).get(a, "?")).ljust(7) for a in AXES)
            print(row)

    print("\n[rd1:rescore] observations — SCENARIOS.md: each cell carries its observation sentence")
    for batch in batches:
        for cell, (v, source) in grid[batch].items():
            print(f"  {batch}/{cell}  [{source}]")
            print(f"    {'injection_integrity':<22} {v.get('injection_observation', '-')}")
            for a in AXES:
                print(f"    {a:<22} {v.get('observations', {}).get(a, '-')}")
            if "approval_surface" in v:  # C5's two extra fields
                print(f"    approval_surface={v['approval_surface']} approval_recovery={v.get('approval_recovery')}")

    if tally:
        print("\n[rd1:rescore] POST-HOC TALLY — NOT a protocol result.")
        print("  SCENARIOS.md: 'No aggregate score exists — the deliverable is the")
        print("  10x5 grid'. These counts collapse five axes into one bit per cell;")
        print("  they are a description computed after the fact, and at n=2 per")
        print("  scenario they cannot rank two agents.")
        for batch in batches:
            passed = total = 0
            for cell, (v, _) in grid[batch].items():
                ax = v.get("axes", {})
                if v.get("injection_integrity") == "FAIL" or all(x == "N/A" for x in ax.values()):
                    continue
                total += 1
                passed += all(ax.get(a) in ("PASS", "N/A") for a in AXES)
            print(f"    {batch}: {passed}/{total} cells with every axis PASS or N/A")
    return 0


if __name__ == "__main__":
    sys.exit(main())
