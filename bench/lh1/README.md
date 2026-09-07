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
- `tasks/<t>/hidden/` — hidden tests injected by the evaluator (flat:
  files only, copied into the workspace's `tests/`).
- `tasks/<t>/golden/` (L-REFACTOR) — the behavior-preservation truth:
  `cases.json` (argument vectors), `inputs.json` (the input files, some
  deliberately malformed), and `expected.json`, the
  SEED's own stdout/stderr/exit code per case; `lib/golden.mjs` runs a
  workspace against it from a scratch directory (`run/golden.mjs <task>
  <ws> [--write]` is the CLI). `tasks/<t>/seed-check.mjs`
  is an optional fixture-level invariant the selftest runs on the
  PRISTINE seed (here: the goldens ARE the seed's output), so a golden
  can never drift from the behavior it claims to pin.
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
- `run/golden.mjs <task> <ws> [--write]` — run (or, from a PRISTINE seed
  only, write) a fixture's golden battery.
- `drivers/kiso/` — the kiso driver, the surrogate-arm playbook
  generator and the declared policy (below).
- `lib/axes.mjs` + `run/calibrate.mjs` — the evaluator calibration
  (protocol §7.4): the LH-1 axes that overlap RD-1's (duplicate effect
  by effect identity, silent retry, lost work, fabricated certainty)
  ported rule for rule, re-derived over every scored cell of the
  tracked clean-replay archives and compared with the frozen rescore
  grid (`--check`: 144 axis cells, zero disagreement), plus 17
  synthetic boundary cases. A disagreement is an evaluator bug, never
  a new verdict. Gated from a fresh clone.
- `run/cost-geometry.mjs` — the cost-geometry extractor (protocol §4):
  first-request fresh / cacheRead and hit% PER SESSION START within a
  leg (every resume is a new start), beside the leg's totals
  (cost-weighted = fresh + 0.1 × cacheRead + output, rd1's population).
  `--leg <legDir>` reads a leg's `agent-state/sessions/traces`;
  `--rd1-clean --check` re-derives RD1B-F8's per-cell table from the
  tracked clean-replay archives, both arms, the c7 cells printed as the
  declared I-STREAM exclusion — the extractor's acceptance, and a gate.
- `runs/` — leg records (gitignored); `artifacts/` — archived batches.

## The driver and the surrogate arm (`drivers/kiso/`)

`drivers/kiso/drive.py` is the per-arm interaction layer over rd1's
world helpers (`bench/rd1/drivers/kiso/drive.py` owns the 0-row pty
Leg, the crash injection and the surrogate log): it seeds the fixture
OUTSIDE any repository (a temp root — protocol §3), clears the child
environment to the whitelist plus an isolated `KISO_HOME` and `HOME`,
types the prompt as one line once the banner is up, answers only the
questions it is asked — an approval is granted only for a class the
declared matrix (`policy.json`) puts at ASK, with scripted constant
latency — fires an overlay at a WORLD-OBSERVABLE boundary (N reference
steps true on disk; `kill` = SIGKILL first, reap, then the fd;
`restart` = SIGTERM, exit status recorded), resumes, and ends the leg
on the run's own terminal event in the durable log. The leg record is
`runs/<leg>/`: `workspace/`, `surrogate.jsonl`, `meta.json`
(provenance: versions, hashes, env keys, mode, policy sha, the
first request's prompt/tool hashes), `agent-state/` (durable log and
traces — evidence for the cost-geometry extractor, NEVER read by the
evaluator), `pty-leg*.log`, then `verdict.json` + `evaluate.log` from
the task's evaluator, which receives the workspace path and nothing
else.

`--arm faux` is the SURROGATE ARM: a real kiso process, real tools, a
real durable log and a real approval surface, with the model replaced
by a playbook — `drivers/kiso/faux-script.mjs <task>` writes a
`KISO_FAUX_SCRIPT` that applies the reference through kiso's own tools
(read, then write citing the revision; `rm` through the shell tool,
which the policy puts at ASK). It is free and it proves the apparatus,
never an agent: every overlay shape ran on it before any paid leg.
`--arm real` is the same driver with provider variables.

`drive.py --probe` is the policy-consistency probe (protocol §5.3): one
representative operation per effect class (`drivers/kiso/probe-script.mjs`)
under the declared realization; what happened to each call is read from
the durable log — executed / gated (with the surrogate's decision) /
refused — and compared with the matrix cell; a mismatch exits 1 and the
batch does not start. The surrogate classifies a pending call from the
durable log (name and input through the permission's callId), so a shell
command's class follows `policy.json`'s `shellClass` table. First run on
0.30.0: LH1-P1 — non-provider network is GATED under `accept-edits`
where the matrix says DENY; fix the realization or declare the class.

LH1-D1 (recorded by the first free leg): the F5 `--task-file` entry is
the subagent child's structured single turn; an approval raised under
it fails the run (`[run failed] readline was closed`) because the file
IS the input. Legs with an approval surface use the typed-line entry.

## The verdict record

`evaluator.mjs` prints one row per check with a detail for humans, then
one `[lh1:verdict-json]` line — the leg's RECORD — carrying only what is
scored: `{ task, pass, checks: [{ name, ok }] }`. Details (a test
runner's output, a temp path, a duration) are diagnostic and would make
two evaluations of the same tree differ; the closed loop's rescore
compares the record byte for byte, so the record carries none. The full
evaluator output of a leg is kept beside it as `evaluate.log`.

## Families (protocol §2)

L-IMPL (30–60 min, implement a specified multi-file feature),
L-REFACTOR (30–90, behavior-preserving restructure), L-MIGRATE
(60–120, mechanical migration across the tree). One fixture per
family.

- **L-IMPL-1** "ledger, multi-currency" — hidden tests + CLI probes;
  closed loop green.
- **L-REFACTOR-1** "statz, one reader/one aggregator/pure commands" —
  the truth is a 41-case golden battery (every error path, the drift
  between the seed's readers, order-sensitive float sums) plus layout
  invariants stated in the SPEC exactly as the hidden test runs them
  (`node:fs`/`process.` only in cli.mjs, `.toFixed(` once, the header
  literal once, the old modules gone); closed loop green.
- **L-MIGRATE-1** "lintr, rule files v1 → v2" — a mechanical migration
  across 30 rule files plus the loader, validator, scaffold and format
  doc; the truths are a completeness scan (every file schema 2, no v1
  key: zero stragglers), the ORIGINAL tree's own loader output as the
  semantics oracle (the evaluator extracts the `seed` tag and runs its
  loader; the migrated tree must match rule for rule), a 28-case golden
  battery, and hidden tests for the retirement of v1 (`missing schema`),
  the pinned validator wording and the scaffold; closed loop green.
