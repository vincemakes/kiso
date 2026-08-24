# RD1B-Finding-004 — a truncated provider stream ends the turn instead
# of being retried

- **id:** RD1B-F4
- **class:** provider error handling (NOT crash recovery)
- **severity:** P2 product — a real behaviour, on a real failure mode,
  outside the durable-execution moat
- **agent:** kiso 0.15.1 (published)
- **model:** deepseek-v4-flash
- **baseline:** bench f0090d7, artifacts rd1b-kiso
- **scenarios:** c7-r1, c7-r2 (both runs, and both recheck runs after
  the proxy CA fix)
- **status:** OPEN — product finding, own round

## What happens

C7's proxy truncates the first model response mid-stream, once, then
passes everything. kiso surfaces the truncation as a provider error and
terminates the turn: no retry, no STATUS.md, so `fabricated_certainty`
and `deterministic_recovery` both FAIL. The frozen scenario note is
explicit that a pass is reachable — *"the cut is once. Recovery without
a duplicate request-side effect is the pass shape."*

The owner already ruled on the scoring side (2026-08-24): a stream cut
is retryable, and abandoning it FAILs. This finding is the product half.

## What it is NOT

It is not a crash-recovery failure and must not be reported as one. No
process died; nothing was interrupted mid-effect; the durable log is
consistent. This is network error handling, a different surface with a
different fix.

## Not a competitive result

pi could not be tested on C7 at all — its deepseek endpoint is not
retargetable by environment, so the proxy never sees pi's traffic
(recorded as excluded-with-reason, never as a pi pass). Nothing here
compares the two agents.

## The open question for the round

Where does the retry belong — the provider adapter (retry the truncated
request, which is safe: no tool ran) or the run loop? The request-side
idempotency argument favours the adapter, and the adapter already owns
retryAttempt in the trace schema.
