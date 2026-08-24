# RD1B-Finding-002 — the competitor arm carried no provenance

- **id:** RD1B-F2
- **class:** benchmark integrity / auditability
- **severity:** P2 — no false result, but no artifact-level proof of
  fairness either
- **agent:** the harness (bench/rd1/drivers/pi)
- **baseline:** bench f0090d7, artifacts rd1b-pi
- **status:** FIXED in the working tree; the RD-1B pi artifacts remain
  as recorded (they are frozen evidence, not to be back-filled)

## What was recorded

Every kiso cell's `run.json` carries a provenance block: agent version,
cli path, model, base-url mode, bench baseline commit, driver sha256,
per-file harness sha256, the Axis-0 version, the scenario sha256 and a
timestamp. The pi cells carried:

    {"tool": "pi", "scenario": ..., "piVersion": ..., "model": ..., "verdict": ...}

No harness sha. No driver sha. No scenario sha. No timestamp.

## Why it matters

RD-1B's kiso arm ran at 13:15 under score.py `221b7be1758ece41`; the
scorer was then fixed (cce3f29) and the pi arm ran afterwards. Whether
both arms were judged by the same scorer is therefore a question the
artifacts cannot answer — it rests on the operator's memory of the
ordering. In a competitive benchmark that is the one thing that must be
checkable by someone who does not trust the operator.

(The scorer difference turns out not to matter here: `rescore.py` re-runs
the current scorer over the frozen artifacts of both arms and only the
two kiso C2 cells move. But that is a result, not a guarantee — the
guarantee is the recorded sha.)

## The fix

`bench/rd1/drivers/pi/drive.py` builds the same provenance block as the
kiso driver, through one `write_pi_run` helper used by all three exit
paths (the C7 untestable path, the C5 no-approval-surface path, and the
normal scored path), so a future exit path cannot silently omit it.
