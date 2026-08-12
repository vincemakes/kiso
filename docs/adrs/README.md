# kiso ADRs — Architecture Decision Records

Every decision that outlives a commit is recorded here. The discipline:
**any conflict with a choice between options (ruling-style rulings) and any
supersession lands as an ADR IN THE SAME ROUND as the implementation** —
future stage specs cite this rule; a decision without an ADR is a commit
that has not finished speaking.

- 0001 — kiso is a microkernel, not a framework — **Superseded by 0021**
- 0002 — The event stream is the single truth — Accepted
- 0003 — The event sum type — Accepted
- 0004 — The terminal is first-class — Accepted
- 0005 — Retry stays in the loop — Accepted
- 0006–0019 — **never assigned** — the initial commit (c366b2c) numbered
  the protocol ADRs 0001–0005 and started the implementation series at
  0020; the gap is a numbering artifact, not lost records
- 0020 — Tool error classification — Accepted
- 0021 — The framework grows in packages — Accepted (supersedes 0001)
- 0022 — Reliable Session Alpha — the first vertical slice — Accepted
- 0023 — ajv is the core's single runtime dependency — Accepted
- 0024 — The execution ledger, exactly-once recovery, and real approval
  pauses — Accepted (superseded in part by 0025)
- 0025 — executionId identity, crash-safe storage, and real
  cross-process resume — Accepted (supersedes 0024 in part)
- 0026 — The byte-stable projection contract — Accepted
- 0027 — MicroCompact — context relief as a persisted decision —
  Accepted (decision #1 superseded in part by bootstrapping #3, 2026-08-04)
- 0028 — The extension contract — narrow surfaces, monotone by
  construction — Accepted (ask routing superseded by 0029)
- 0029 — An ask is answered by a human — no automated policy speaks for
  the human — Accepted (supersedes 0028's ask routing)
- 0030 — Official extensions — in-repo workspaces, kernel zero-diff —
  Accepted
- 0031 — Credential boundaries — strip by default, pass explicitly under
  human approval — Accepted
- 0032 — Subagents are durable sessions — Accepted
- 0033 — Skills load progressively through existing surfaces — Accepted
- 0034 — npm identity — a personal scope, the pi pattern — Accepted
- 0035 — The upgrade contract is quarantine, not seamless rolling —
  Accepted
- 0036 — The single-writer lock is a kernel flock held by a helper
  process — Accepted (superseded by 0050)
- 0037 — Project-level capability is trusted by content digest, not by
  directory — Accepted
- 0038 — Uncertainty belongs to the crash window alone; the approval
  chain guards retries — Accepted (supersedes 0024 in part)
- 0039 — The TUI bottom-anchored UI budget — Accepted
- 0040 — The v2d body renderer cell model — Accepted
- 0041 — The CLI gate — terminal cap 2400 — Accepted
- 0042 — Abstain is a verdict — Accepted
- 0043 — TUI extraction, per-package gates — Accepted (Amendment 1:
the cli gate 1320 → 1856, one argued recalibration for the Config
round's spec-forced growth; next approach without argument = extraction,
not another recalibration)
- 0044 — The compact summary layer — Accepted
- 0045 — The config surface: credentials never on disk, project config
  in the trust package, no "always" — Accepted
- 0046 — The one-compositor — Accepted
- 0047 — Prefix-Complete Execution: the durable recovery law — Accepted (Amendment 2: the α ruling — the receipted execution is an outcome, the α-gap row closed)
- 0048 — Recovery as a pure projection: the plan, the thin driver, the EffectGate — Accepted
- 0049 — The diet-micro rider — VOID as written (the 0.1.47 void
  adjudication, the review, 2026-08-11); corrected record: A/B/C
  re-land as adjudicated in 0.1.48, D reverted
- 0050 — The identity-confirmed link lock — a pure Node single-writer
  lock — Accepted, adjudicated by the review, 2026-08-11 (supersedes
  0036)
- 0051 — The Durable Execution Contract: the 1.0 freeze — Accepted,
  adjudicated by the review, 2026-08-12 (R1–R11). The forever-ABI in
  three classes, the generations + read-time normalization, the
  adapter-write contract, the five evolution rules, the ledger
  boundary, the canonized invariants → gates, the ask semantics closed
  (G3, durable ratification). (Amendment 1: the post-1.0 version
  convention — the release round is the cli minor; additive-optional =
  minor, fix = patch, frozen-surface break = the amendment ritual =
  major, envelope = MAJOR; annotated tags from v1.0.0.)

Old ADRs are kept verbatim — decision history is the point of the
discipline; superseded records carry the marker in their own Status line,
never an edit.
