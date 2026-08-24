#!/usr/bin/env python3
"""RD-1B clean replay — the same scenarios, symmetric environments.

RD-1B's arms were not given the same world (RD1B-F7): the pi driver
inherited the operator's entire environment, loading 13 installed skills
and — because the fixtures sat inside this repository and pi walks
ancestors for context files — this project's own CLAUDE.md. The kiso
driver used a blank KISO_HOME. A surface probe then measured the
cleaned baseline and found the gap's DIRECTION was the contamination:
pi-clean 1,657 tokens against kiso-clean 1,937.

This re-runs the whole batch with that fixed:

  - both children get a CLEARED environment plus one identical whitelist
  - each agent gets its own empty profile directory (--isolate-home)
  - pi's user skills, context files and extensions are off via the
    product's own switches (-ns -nc -ne)
  - the fixtures live OUTSIDE this repository, so no ancestor
    instruction file is reachable by an agent that walks upward
  - the environment is recorded in each cell's provenance

Versions are pinned to the ones RD-1B used, deliberately: kiso 0.15.1
(the PUBLISHED artifact this time, closing the evidence-tier gap the
batch was reported with) and pi 0.84.2. **The RD1B-F1 fix is NOT in
this run.** A replay that changed the environment and the product at
once could not say which one moved a number.

usage: replay.py --kiso-cli <path> --work-root <dir outside the repo>
                 --out-root <dir under bench/rd1/out> [--runs 2]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

RD1 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCEN = os.path.join(RD1, "scenarios")
KISO_DRIVER = os.path.join(RD1, "drivers", "kiso", "drive.py")
PI_DRIVER = os.path.join(RD1, "drivers", "pi", "drive.py")
SCENARIOS = [f"c{i}" for i in range(1, 11)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kiso-cli", required=True)
    ap.add_argument("--work-root", required=True)
    ap.add_argument("--out-root", required=True)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--only", default="")
    a = ap.parse_args()

    repo = os.path.dirname(os.path.dirname(RD1))
    if os.path.abspath(a.work_root).startswith(os.path.abspath(repo) + os.sep):
        print(f"[rd1:replay] REFUSING: --work-root is inside {repo}. An agent that "
              f"walks ancestors would reach this repository's own instruction files — "
              f"the whole point of RD1B-F7.", file=sys.stderr)
        return 2
    scenarios = [s for s in SCENARIOS if not a.only or s in a.only.split(",")]
    os.makedirs(a.work_root, exist_ok=True)
    os.makedirs(a.out_root, exist_ok=True)
    rows = []
    for run in range(1, a.runs + 1):
        for scn in scenarios:
            for arm in ("kiso", "pi"):     # interleaved: drift lands on both
                cell = f"{scn}-r{run}"
                wdir = os.path.join(a.work_root, f"{arm}", cell)
                shutil.rmtree(wdir, ignore_errors=True)
                argv = ([sys.executable, KISO_DRIVER, "--cli", a.kiso_cli]
                        if arm == "kiso" else [sys.executable, PI_DRIVER])
                argv += ["--scenario", os.path.join(SCEN, f"{scn}.json"),
                         "--out", wdir, "--model", a.model, "--isolate-home"]
                if arm == "pi":
                    argv.append("--no-user-resources")
                t0 = time.time()
                r = subprocess.run(argv, capture_output=True, text=True)
                dest = os.path.join(a.out_root, f"rd1b-clean-{arm}", cell)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.rmtree(dest, ignore_errors=True)
                if os.path.isdir(wdir):
                    shutil.copytree(wdir, dest)
                verdict = {}
                try:
                    verdict = json.load(open(os.path.join(dest, "run.json"))).get("verdict", {})
                except Exception:
                    pass
                ax = verdict.get("axes", {})
                ok = bool(ax) and all(v in ("PASS", "N/A") for v in ax.values())
                rows.append({"arm": arm, "cell": cell, "axes": ax,
                             "integrity": verdict.get("injection_integrity"),
                             "wall": round(time.time() - t0, 1)})
                print(f"[replay {arm:4s} {cell:7s}] inj={verdict.get('injection_integrity','?'):4s} "
                      f"{'all-pass' if ok else 'FAIL/NA'} "
                      + " ".join(f"{k[:3]}={v}" for k, v in ax.items())
                      + f"  {round(time.time()-t0,1)}s"
                      + ("" if r.returncode == 0 else f"  [driver rc={r.returncode}]"), flush=True)
                json.dump(rows, open(os.path.join(a.out_root, "replay-progress.json"), "w"), indent=1)
    print(f"\n[replay] {len(rows)} legs. Score with rescore.py --live "
          f"rd1b-clean-kiso rd1b-clean-pi, cost with metrics.py --live.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
