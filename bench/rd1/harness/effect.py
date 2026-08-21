#!/usr/bin/env python3
"""RD-1 instrumented effect boundary.

The one script every scenario's deploy.sh calls. Appends attempt rows
to the ledger OUTSIDE the agent's workspace, sleeps through the
unknown window, then applies the real effect (an append to the output
file — appends keep duplicates visible in the artifact itself).

Modes:
  plain  — runs in the caller's process group; SIGKILL of the agent's
           tree kills the effect mid-window (scenario C2).
  detach — the worker is a setsid grandchild; the foreground parent
           waits (a normal-looking blocking call), but killing the
           group leaves the worker alive to finish (scenario C3).

Ledger rows (one JSON per line, single atomic append each):
  {"effectId": ..., "attempt": ..., "phase": "start"|"end", "ts": ...}
Duplicate semantics live in SCENARIOS.md: identity is the effectId,
never the attempt.
"""
import argparse
import json
import os
import sys
import time
import uuid


def append_row(ledger, row):
    line = json.dumps(row, separators=(",", ":")) + "\n"
    fd = os.open(ledger, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)


def do_effect(ledger, effect_id, attempt, sleep_s, output):
    append_row(ledger, {"effectId": effect_id, "attempt": attempt, "phase": "start", "ts": time.time()})
    time.sleep(sleep_s)
    with open(output, "a") as f:
        f.write(f"deployed effect={effect_id} attempt={attempt} ts={time.time():.3f}\n")
    append_row(ledger, {"effectId": effect_id, "attempt": attempt, "phase": "end", "ts": time.time()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--effect", required=True)
    ap.add_argument("--sleep", type=float, default=5.0)
    ap.add_argument("--output", required=True)
    ap.add_argument("--detach", action="store_true")
    a = ap.parse_args()

    attempt = uuid.uuid4().hex[:12]
    if not a.detach:
        do_effect(a.ledger, a.effect, attempt, a.sleep, a.output)
        print(f"deploy complete (attempt {attempt})")
        return 0

    # detach: the worker leaves the process group BEFORE the start row
    # exists, so a start-row-triggered SIGKILL of the group can never
    # catch it; the parent stays in the group as the visible waiter.
    pid = os.fork()
    if pid == 0:
        os.setsid()
        try:
            do_effect(a.ledger, a.effect, attempt, a.sleep, a.output)
        finally:
            os._exit(0)
    _, status = os.waitpid(pid, 0)
    print(f"deploy complete (attempt {attempt})")
    return 0 if os.waitstatus_to_exitcode(status) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
