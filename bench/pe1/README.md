# PE-1 — the long-horizon capability seed corpus

The first measurement instrument for the Capability leg. A SEED CORPUS,
not a benchmark contract: the frozen unit is one run batch (freeze the
kit, run, report); between batches tasks may be discarded and
redesigned, never tuned mid-batch.

## The three-layer law

Every run is judged on three INDEPENDENT layers, reported side by side,
never merged:

- **MODEL CLAIM** — does the final assistant text explicitly assert the
  goal is complete? Mechanical three-state rule: an explicit completion
  assertion is CLAIM_COMPLETE; an explicit non-completion/failure
  statement is CLAIM_NOT_COMPLETE; everything else (hedges, partial
  reports, silence) is CLAIM_UNCERTAIN. Language style is never judged.
- **KISO EVIDENCE** — `session.assessTasks()` at session end (claims,
  allClaimedDone, the evidence verdict), quoted verbatim.
- **BENCH TRUTH** — the task's `evaluator.mjs` exit code against the
  workspace. The evaluator never reads a kiso verdict, a session log,
  or a transcript: the Evidence system cannot certify itself.

Disagreement cells are the product: each becomes a numbered finding.

## Two dimensions, never blended

- capability completion: t1-bugfix, t2-refactor, t3-trap, t4-recovery,
  t5-verify-extend, t8-ordering
- durability completion: t6-kill9 (SIGKILL + resume mid-task),
  t7-compact (/compact mid-task)

A durability failure is never reported as a coding-capability number.

## Reporting discipline (n=2)

The primary table is the per-task trajectory table — every run's
(claim, evidence, truth) triple shown. Aggregates appear only as
narrated observations; no single success-rate headline exists at n=2.

## Layout

- `tasks/<t>/workspace/` — the hermetic fixture (self-contained,
  zero dependencies, `npm test` = `node --test tests/`).
- `tasks/<t>/PROMPT.txt` — the user prompt, one paragraph.
- `tasks/<t>/evaluator.mjs` — the external judge (hidden tests, file
  and git invariants, behavior probes). Never shown to the agent.
- `tasks/<t>/reference/` — the reference solution the selftest applies
  (files copied over; `_DELETE` lists removals).
- `tasks/<t>/hidden/` — hidden tests the evaluator injects AFTER the
  git-invariant checks.
- `tasks/<t>/GRADE.md` — the task's PASS definition in one paragraph.
- `run/make-workspace.mjs` — seed a fresh workspace (git init + `seed`
  tag; evaluators diff worktree-vs-seed, so agent commits are welcome
  but never required).
- `run/selftest.mjs` — the evaluators' own red/green proof: pristine
  must FAIL, reference must PASS, all eight tasks.

## Experiment provenance (per run, recorded in the report)

run-id, model, provider, temperature, system prompt hash, kiso sha,
fixture sha (bench/pe1 tree hash), evaluator sha, rig sha + pyte
version, invocation line, timestamp. Measurement itself needs
provenance.

## What the corpus never does

No kiso-repo self-hosting (fixtures are standalone); no network; no
third-party packages; no PASS/FAIL release gate (PE-1 is measurement —
numbers ship as observed); no baseline arm in this batch (an uplift
comparison is a separately designed round with its own fairness
discipline).
