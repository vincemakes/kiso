# EX-0 — Experience groundwork

Not a memory system. A groundwork probe that answers ONE question
before kiso ever accumulates experience: **what makes an experience
trustworthy?** The answer, established here against real durable logs:

> An experience must be a BOUND PROJECTION over durable evidence —
> an `assertion + proof obligation`, verified by an external checker
> that reads the raw logs, never by any memory certifying itself.

This is EP-1's honesty principle raised from single-execution CLAIMS to
cross-execution EXPERIENCE, and it inherits Projection Integrity
(ADR-0053): a projection may never assert a certainty its durable facts
do not support.

## Contents

- `schema.md` — the Bound Experience contract, v1.1, four red lines:
  **binding** (why we believe it), **scope** (a model-specific behavior
  may not become a universal law), **antiEvidence** (the exceptions,
  mandatory), **validity** (the future conditions that retire it).
- `verifier.mjs` — the external binding checker. Reads only the
  durable-log slices under `evidence/`; an experience the verifier
  cannot bind is rejected. `Experience system cannot certify itself.`
- `experiences/` — BE-001..003, three real experiences distilled from
  the PE-1 and RD-1A durable logs, each bound and verifier-PASSING.
- `evidence/` — the extracted log slices (each with its source +
  source sha) that the experiences bind to. Self-contained: the
  verifier runs without the full run trees, each slice still points to
  its exact session.
- `failure-catalog.md` — the fourth output: "when NOT to trust
  yourself" — FC-001..004 (uncertain→claim, known-effect→re-run,
  model-specific→universal, correct→stale). The self-distrust rules
  that a future self-improving layer needs so it learns facts, not
  hallucinations.
- `selftest.mjs` — the verifier's own red/green (a mis-bound
  experience must FAIL): 7/7.

## Result (the groundwork's finding)

The contract holds. Three real experiences — task_set adoption is rare
(PE1-F2, 13/16, corroborated), C3 long-window resume double-deploy
(RD1A-F6, provisional), kiso isolates effect subprocesses (RD1A-F7,
corroborated) — all BIND against the raw logs, with honest scope,
anti-evidence, and validity. A human could distill trustworthy,
externally-verifiable experience from durable evidence. That is the
precondition EX-1 (AUTOMATIC distillation) needs; its hard problem is
not extraction but "how do we verify the abstraction?" — which is
exactly what this verifier begins to answer.

## Not in scope

No memory system, no runtime change, no automatic extraction (EX-1),
no self-improvement (UP), no new benchmark runs. Reads existing PE-1 /
RD-1A durable logs only. Zero API cost.
