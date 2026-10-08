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
  pauses — Accepted (superseded in part by 0025; Amendment 1: parallel
  execution returns; Amendment 2: `concurrencySafe` retired, the race
  referred to EC-1; Amendment 3: the window is an EXECUTION window — the
  eligibility/window split, the FIFO fence, the post-commit ask, which
  supersedes Amendment 1's decisions #1, #2, #3, #5 — see 0052)
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
- 0032 — Subagents are durable sessions — Accepted (Amendment 1,
  2026-10-03: the tester role is the verifier; `after` works on a copy)
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
- 0041 — The CLI gate — terminal cap 2400 — **Superseded by 0043** (which
  executed 0041's own escape hatch: structural extraction, then
  per-package gates)
- 0042 — Abstain is a verdict — Accepted
- 0043 — TUI extraction, per-package gates — Accepted (Amendment 1:
the cli gate 1320 → 1856, one argued recalibration for the Config
round's spec-forced growth; next approach without argument = extraction,
not another recalibration)
- 0044 — The compact summary layer — Accepted (the covered-range
  sentence superseded by 0055 Amendment 2: a checkpoint replaces every
  earlier one)
- 0045 — The config surface: credentials never on disk, project config
  in the trust package, no "always" — Accepted
- 0046 — The one-compositor — Accepted
- 0047 — Prefix-Complete Execution: the durable recovery law — Accepted (Amendment 2: the α ruling — the receipted execution is an outcome, the α-gap row closed; Amendment 3: a committed call an abort stranded is answered by the next run)
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
- 0052 — Durable Turn Commit — the boundary between model-intent validity
  and real-world effect — Accepted, the EC-1 effect classification round,
  2026-08-19. The seven invariants, the three-boundary chain, the
  `effects` optimization certificate (absence is the conservative truth),
  the FIFO fence at acceptance, post-commit asks, the new recovery prefix
  classes, the truncation contract amendment, and the E1 extraction
  (delivery truth → kiso-evals). Companion: ADR-0024 Amendment 3.
- 0053 — The Projection Admissibility Law — every durable projection
  consumes the voided-range semantics before interpreting events —
  Accepted, recorded at the TV-1C/TT-1 review, 2026-08-20. Semantics
  mandated, representation not (no framework until a fourth
  implementation or a real divergence); new projections ship with a
  voided-range admissibility test.
- 0055 — A settled round is a legal compaction boundary — **Accepted**,
  2026-09-17, ratified by the owner. Verified in
  the tree: summary compaction cuts only at user turns, the auto-compact
  check returns while a run is in flight, `context_overflow` is
  `retryable: false`, `checkpointBoundarySeq` is called by nothing, and
  microcompact (tool results only) is the sole mid-run relief — so
  compaction is unreachable from inside a turn. A1b v1 is one threshold
  firing at the next settled round, one reserve guard before the send,
  one recovery that retries once. The default came from minimax regret
  over MEASURED session shapes; five of six real shapes never reach any
  threshold, so it rests on one observed session in three hundred and
  says so.
  Amendment 2 (2026-09-22, P0 in 0.40.1): a checkpoint REPLACES every
  earlier one (ranges nest, one summary projects); a compaction must
  remove at least what it writes; overflow is recognised without a status
  and, past a stated window, by kiso's own measure; the reserve is what
  the endpoint may grant.
- 0056 — One resident line per MCP server, or one proxy tool — **Accepted**,
  2026-09-17, ratified by the owner. The entire
  built-in tool surface measures 3,772 B (~943 tokens) — the denominator
  that makes deferral worth considering at all, and it is not yet known
  what a real server weighs. Two designs are written down (deferred
  schemas with `load_tools`; one proxy tool) with the proxy recommended:
  constant rent, zero cache breaks, no budget question, paid for with no
  native argument validation. Withdrawn rather than tuned if real servers
  turn out small, and it waits on the skills behaviour check, whose
  architecture it would otherwise inherit untested.
- 0057 — Safe Admission: new input enters a running run only at a
  quiescent boundary — **Accepted**, 2026-09-28, ratified by the owner.
  Steer is same-run admission: input may arrive at any time and is
  admitted as a `user_input` only once the model turn is committed, every
  started effect has its receipt, no approval is open, and the run may
  still ask the model (`maxTurns` wins; END_TURN does not). Three sites,
  an ingress sealed by every terminal, a person's input through
  `onUserMessage` once and the runtime's never. Overturns architecture
  §5 ("Run — one user turn") and "input lands between runs".
- 0058 — Tasks: execution that outlives the tool call that started it —
  **Accepted**, 2026-09-28, ratified by the owner; Amendments 1–2
  2026-09-30, Amendment 3 2026-10-01, Amendments 4–6 2026-10-02/03. A foreground command that outlives `foregroundMs` (60 s by
  default; the model's value wins) is promoted to a task, never killed;
  `background: true` starts one under a detached runner that survives
  kiso; `readyWhen` ends the wait on a ready line. A write-ahead journal
  per task and a verified runner identity decide every state after a
  crash; nothing is ever re-run. Completions reach the model through
  ADR-0057's admission seam, batched, with at most one autonomous wake.
  `delegate` runs explorer and reviewer children in the background as
  agent tasks, bounded by a turn budget, delivered once per group. The
  person moves a running command to the background with ctrl+b, a steer
  no longer waits for one, `/tasks` lists and stops them, and an exit
  with live tasks asks first.
- 0059 — `wait` — a run may end on a future event and resume on it —
  **Withdrawn** (Amendment 1, 2026-10-07: the tool removed before it
  shipped; its chain budget lives on as 0058 Amendment 9)

- 0054 — The default tool table: what is always present, and what deferral
  is reserved for — PROPOSED, 2026-09-16, awaiting the owner's
  ratification. The seven built-ins plus TTY-conditional `ask_user` stay;
  `delegate` and `ask_user` are default capabilities and never manual
  configuration. The decision-load hypothesis was measured in a nine-pair
  round and NOT SUPPORTED, so the projection idea is moot and deferred
  loading is reserved for an MCP-heavy long tail, not applied at seven.

Old ADRs are kept verbatim — decision history is the point of the
discipline; superseded records carry the marker in their own Status line,
never an edit.

**Whose job that is (SC-1b, 2026-08-18): the SUPERSEDING round updates the
superseded record's own Status line and appends the supersession note — in
the same round, not later.** The marker is the dead record's job to carry
and the live round's job to write; an index line alone does not do it,
because a reader arrives at an ADR by its number and reads its Status, not
the index. SC-1 found 0028, 0036, and 0041 marked in the index above and
"Accepted" in their own headers for as long as four months.
