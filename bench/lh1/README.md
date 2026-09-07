# LH-1 — the long-horizon delegated-completion benchmark (dry-run apparatus)

Protocol: `kiso-doc/kiso-lh1-dryrun-protocol.md` (frozen). This tree is
the apparatus the protocol's §10 deliverables land in; nothing here
runs a paid scored leg. The first closed loop — seed → surrogate →
evaluate → archive → rescore-from-archive → replay — runs on faux
material and is the exit criterion for the first fixture.

## The truth law (PE-1's, unchanged)

BENCH TRUTH is the task's `evaluator.mjs` exit code against the
workspace. The evaluator never reads an agent's verdict, session log
or transcript: the Evidence system cannot certify itself. Hidden tests
are injected from OUTSIDE the workspace after the git invariants are
checked; a no-test-edit invariant is `git diff seed -- tests/` being
empty; an allowed-paths invariant is every changed path matching the
task's `expected.json`.

## Layout

- `tasks/<family>-<n>/workspace/` — the hermetic seed (zero
  dependencies; `npm test` = `node --test tests/`); `SPEC.md` in the
  workspace is the task's specification the agent reads.
- `tasks/<t>/PROMPT.txt` — the user prompt, one paragraph.
- `tasks/<t>/expected.json` — allowed write paths (globs), the files
  that must survive byte-identical, the CLI probes.
- `tasks/<t>/hidden/` — hidden tests injected by the evaluator.
- `tasks/<t>/reference/` — the reference solution the selftest and the
  surrogate apply (files copied over; `_DELETE` lists removals).
- `tasks/<t>/evaluator.mjs` — the external judge. Never shown to the agent.
- `tasks/<t>/GRADE.md` — the PASS definition in one paragraph.
- `tasks/<t>/meta.json` — the duration label's BASIS: files and lines
  the reference touches, hidden test count. The label itself (30–60
  min) is a claim until the calibration batch measures it (§8).
- `lib/eval-kit.mjs` — PE-1's kit plus the LH-1 invariants.
- `run/make-workspace.mjs` — seed a fresh workspace (git init, `seed` tag).
- `run/selftest.mjs` — every evaluator must FAIL on pristine and PASS on
  the reference, and the reference must respect the allowed paths.
- `run/closed-loop.mjs` — the free closed loop on one task (below).
- `runs/` — leg records (gitignored); `artifacts/` — archived batches.

## Families (protocol §2)

L-IMPL (30–60 min, implement a specified multi-file feature),
L-REFACTOR (30–90, behavior-preserving restructure), L-MIGRATE
(60–120, mechanical migration across the tree). One fixture per
family; L-IMPL-1 first.
