# ADR-0051: The Durable Execution Contract — the 1.0 freeze

- **Status:** Accepted — adjudicated by the review, 2026-08-12 (R1–R11
  of the R-H 0.1.49 Phase-1 proposal, signed in the round record)
- **Date:** 2026-08-12
- **Layer:** the durable-execution surface (core protocol + runtime store
  + recovery derivation + the CLI's exit paths)
- **Scope:** freeze and normalize the EXISTING semantics only — zero new
  features (the round's stop clause c). The correctness surface is the
  forever-ABI; the efficiency/trace surface is explicitly outside it and
  versionable (§6).

## Context

kiso's durability has grown by rounds: every field, event, and recovery
rule exists because a finding or a ruling put it there. What it has never
had is a frozen statement of what is permanent. The 1.0 Durable Execution
Contract round exists to write that statement — the six invariants + two
external guarantees canonized with executable gates, the forever-ABI
enumerated per event, the old-log generations mapped with read-time
normalization rules, and the two open semantics lines (the boundary
asymmetry, the liveAsk exemption) closed into contract sentences.

The Phase-1 proposal (nine items a–i, options and costs) was adjudicated
by the review on 2026-08-12: **R1–R11**, with the riders recorded
inline below. The Phase-2 implementation plan (§10 of the proposal) was
approved as written; this ADR is its deliverable 1. The gate table in
§7 is the executable face of this document — every invariant and
guarantee has a gate, no empty rows.

## Decision

### §1 The forever-ABI: three classes (ruling R1, rider R1a)

Every event variant is classified forever. The classes:

1. **FROZEN** — the variant's shape is permanent: fields are never
   removed, never repurposed; the field-shape table below is the
   contract. 25 variants:
   `assistant_start` `assistant_end` `text_start` `text_delta` `text_end`
   `tool_call_start` `tool_call_input_delta` `tool_call_end` `tool_result`
   `user_input` `thinking` `usage` `stop` `terminal`
   `tool_execution_started` `tool_execution_succeeded` `tool_execution_failed`
   `tool_execution_resolved` `permission_requested` `permission_decided`
   `permission_expired` `uncertain_pending` `user_input_replaced`
   `microcompacted` `summarized` `model_output_abandoned`
   (envelope shape in §2; the two compact-surface markers in §3).
2. **NORMALIZE** — the optional fields' absence semantics are declared
   per-variant: `invocationSeq` (tool_result, tool_execution_*,
   permission_requested, permission_decided), `eventSeq` (compacted
   entries), `executionId` (tool_execution_*, uncertain_pending,
   tool_result), `source` (assistant_start, text_start, tool_call_*,
   tool_result, user_input, user_input_replaced), `errorKind` (tool_result,
   tool_execution_failed), `decidedBy` (permission_decided), `tags`
   (tool_result, tool_execution_succeeded/failed). Absent means the
   generation's implied value (§3); the projection's normalization fills
   implied facts at READ time and never persists them (invariant ④, no
   persisted derived state).
3. **DEPRECATE-WITH-UPGRADE** — `compacted`: still loaded and replayed
   forever (both entry shapes: v1 `{callId, content}` and v2
   `{eventSeq, callId, content}`), declared **never-writable by 1.0+
   bins** — the produce side retired at ADR-0044 (a8cfbb9). A load-time
   upgrade maps a compacted projection to its modern equivalent on the
   INTERNAL surfaces (deriveRecoveryPlan / consumers) only.

**R1a (byte stability wins).** The compacted upgrade mapping must NEVER
change any old log's provider projection bytes. If "generation-uniform
projection" conflicts with byte stability (ADR-0026: same facts → same
projection bytes), byte stability wins; unification happens only in the
internal representation (deriveRecoveryPlan / consumer surface), never on
the provider projection surface. Pinned by the byte-discipline gate's
compacted-generation case (§7, gate row ⑥+R8a): a compacted-era fixture
whose provider projection bytes are pinned; any byte change = red.

### §2 The envelope: no version field, the shape is gated (rulings R2, R3)

1. **B1a: no `schemaVersion`.** The envelope
   `StoreRecord {runId: string, ts: number, event: Event}` stays as-is,
   byte-identical since G2 (`1b384fd`). Generations are detected by
   content (§3), the same axis the normalization uses; a version field
   would be decorative and would create an old-bin forward-compat risk
   (the strict loader's tolerance of unknown envelope keys is unverified
   and must not be forced).
2. **R2a: the envelope shape is pinned by a gate.** A drift gate asserts
   every record the store writes has EXACTLY the three keys `runId`,
   `ts`, `event` — a shape change is a contract change, tripped by CI
   before it can ship (§7).
3. **R2b: content-discernibility (evolution rule 5).** Any new event or
   field must never make generation detection ambiguous — the content-
   detection strategy is itself a closure property, the same family as
   rule 2(ii)'s prefix-table closure (§5).
4. **B2a: lineage lives on the trace surface, not in the correctness
   ABI.** The contract sentence: **session-id naming is not protocol.**
   The `sub-<parent>-<n>-<role>` convention (`kiso-subagent.mjs`) is an
   operational convenience, explicitly non-contractual; causal links
   (parentSessionId / parentRunId / parentInvocationSeq / role) belong to
   the trace ledger (§6) and are absent from the correctness surface by
   design — no lanes, only causal links (the already-ruled direction).
   A lineage-is-absent test pins that no recovery derivation reads any
   parent-derived state (lands with the §6 purity gate).

### §3 Generations and read-time normalization (ruling R4, rider R4a)

The load-relevant generations, by format milestone (git-verified):

| gen | milestone | bin era | load-relevant facts |
| --- | --- | --- | --- |
| C1 | MicroCompact gen 1, `8e4ee1b` (ADR-0027) | pre-published-0.1.25 | `microcompacted {beforeSeq}`, user-turn boundary policy |
| C2 | gen 2, `e9e06bb` | ≥ 0.1.25 | compactable-result recentness (K=4); same event shape as C1 — the C1/C2 difference is produce-side boundary placement, never load semantics |
| B* | compacted v1→v2, `3786212` | ≤ 0.1.2x | `compacted.cleared` entries `{callId, content}` (v1) / `{eventSeq, callId, content}` (v2) — the v1/v2 reading rules pinned |
| D | summarized + compacted retired, `a8cfbb9` (ADR-0044) | 0.1.38–0.1.42 | `summarized {coversToSeq, summary}`; compacted replay-only; **no `invocationSeq`** |
| E | invocationSeq + marker, `9075f50` (R-E 0.1.43) | 0.1.43–0.1.46 | optional `invocationSeq` on the seven identity-bearing events; `model_output_abandoned {voidFromSeq, reason}` |
| F | native link lock, `52ebf07` (ADR-0050) | 0.1.47+ | the JSONL unchanged from E; the `<id>.lock` convention is a separate mechanism with its own (quarantine) upgrade contract |

(P: pre-durable, ≤ `f0b29c1` — no JSONL existed; no normalization
obligation.)

**Normalization is a read-time pure derivation.** A layer between strict
load and the projection fills implied facts per generation (e.g.
`invocationSeq` absent → derived from the matching `tool_call_end.seq`,
the fallback already documented at events.ts:199-203) and
generation-uniformizes the INTERNAL surfaces. **Never a persistent
rewrite**: rewriting old logs would violate byte stability (ADR-0026) and
"old logs are forever readable" (ADR-0044); derived facts are never
persisted (invariant ④).

**R4a: fixtures are real, provenance-attested.** Every generation sample
is a REAL log written by a REAL published bin (`npx -y
@vincemakes/kiso-code@<ver>` faux-mode runs), with a provenance line in
the fixture header (which bin, when, what command wrote it). Hand-
synthesized session fixtures are forever forbidden as generation samples.
The in-repo pool (`fixtures/sessions/`, the generation gate's table):
the 0.1.43 poisoned trio (`dogfood-0143`, `dogfood-0143b`,
`review-0143`, generation E, real model); `gen-d-0142-faux` and
`gen-d-0142-real` (generation D — the latter the 0.1.42 R-C dogfood
transcript, 2044 records, verbatim); `gen-e-0146-faux` and
`gen-f-0148-faux` (generations E/F, published bins); the two
marker-bearing samples `gen-e-0146-marker` and `gen-f-0148-marker`
(8 real `microcompacted` boundaries each, produced via the product's
own `KISO_CONTEXT_WINDOW` override — the honest resolution of the
finding that no real dogfood log ever contained a compaction marker).
The producer script `produce-generation-samples.sh` and the
`PROVENANCE.md` manifest (bin / date / command per sample) sit
beside the fixtures; the ≥4-generation gate (load → validate →
project → deriveRecoveryPlan over every sample) runs inside
`npm run check`.

### §4 The adapter write surface (ruling R5)

The whitelist `ADAPTER_EVENT_TYPES` is FROZEN at exactly 9 types:
`text_start` `text_delta` `text_end` `tool_call_start`
`tool_call_input_delta` `tool_call_end` `thinking` `usage` `stop`
(kernel tenancy, invariant ⑤). Everything outside the whitelist is
kernel-owned; a provider emitting a kernel-owned event ends the turn with
`invalid_request` and the event never persists (loop.ts:471-476,
:535-539) — enforcement already complete and tested.

**The contract sentence (verbatim): "every ADAPTER_EVENT_TYPES change is
itself a contract amendment."** The whitelist is amended only through the
§5 ritual; a drift gate pins the 9-type set to this table — a change in
either the code or the contract without the other trips CI (§7).

### §5 Incremental evolution (ruling R6, riders R2b)

Post-freeze, a change is non-breaking iff it passes the admission rules:

1. **Optional-field admission.** Adding an optional field to a FROZEN
   variant is non-breaking iff (i) old logs project byte-identically
   (invariant ⑥), (ii) the field is truly optional in the validator,
   (iii) it never changes the meaning of existing bytes. **R6: a new
   optional field MUST add a corresponding fixture case to the existing
   prompt-cache byte-discipline gate — declaration alone is not enough.**
2. **New-event admission.** A new kernel-owned event type is non-breaking
   iff (i) kernel tenancy holds (or the §4 amendment applies), (ii) the
   prefix table gains the new rows — **no prefix ever becomes ambiguous
   because of a new event; the table gate extends, never silently
   skips** (ruled the PRIMARY rule of this chapter), (iii) projection +
   normalization rules ship with it, (iv) it lands via a contract-
   amendment ADR with red→green gates, ruled at a review — the same
   ritual every round uses today.
3. **The ToolResult dual-plane reservation (RESERVED, not implemented).**
   `tool_result.content` remains `string | ContentBlock[]` forever; a
   future dual-plane (model-visible content + machine details +
   artifactRef) enters via new optional fields or a new event — never by
   repurposing `content`. The delivery.ts artifact-extraction note stays
   parked under this reservation.
4. **Envelope changes are a MAJOR contract change.** Any change to the
   record shape (§2.2) is the one event that may justify introducing a
   schemaVersion — never an incidental.
5. **Content-discernibility (R2b).** Any new event or field must never
   make generation detection ambiguous (§2.3).

### §6 The ledger boundary (ruling R7)

- **IN (frozen):** the event union + envelope + strict load + the
  recovery derivation (deriveRecoveryPlan) + the six invariants + the
  two external guarantees + the lock convention (ADR-0050).
- **OUT (versionable, never correctness):** Request Trace, lineage links
  (§2.4), efficiency counters, session metadata that is not an event.
- **The boundary invariant:** **the correctness derivation never reads
  trace data.** The purity gate (fills the previously-empty G1 row):
  deriveRecoveryPlan over a correctness-only corpus while trace-shaped
  data is present and byte-different — the output must be identical, and
  the derivation must perform no I/O (probed, not argued). The
  lineage-is-absent test (§2.4) lands in the same file.

### §7 The invariants and their gates (ruling R8, rider R8a)

The CANON names are ADR-0047 §7's (gates and ADRs use these); the PUBLIC
names are the owner-approved six (README/README.zh use these). The
mapping is explicit:

| canon (ADR/gate names) | public name (README) | coverage |
| --- | --- | --- |
| ① prefix-complete recovery | Prefix-Complete Recovery | 1:1 |
| ① limb | Ambiguity Never Auto-Repeats | the undecided-invocation limb of ① (ADR-0038: the crash window is the human's; never auto-rerun) |
| ② the durable-decision law | Committed Intent Before Effect | 1:1; Durable Start Before Side Effect is its procedural limb (ADR-0024: a handler never runs before its STARTED receipt is persisted) |
| ③ the incomplete-draft law | — (folded into the public pair) | no committed stop, no committed provider history |
| ④ identity trichotomy | Stable Intent Identity (the three-identity limb); Single Durable Truth (the no-persisted-derived-state limb) | 1:2 split |
| ⑤ kernel tenancy | — (folded into Single Durable Truth) | every event outside the whitelist is kernel-owned; forgery = invalid_request |
| ⑥ byte stability | — | optional growth never changes old-log projection bytes |
| G1 same-facts-same-projection | same-facts-same-projection | the purity reading of ⑥ — deriveRecoveryPlan is pure (no I/O, no clocks) |
| G2 exactly-one-terminal | exactly-one-terminal | every run converges on exactly one terminal, its last event |

The invariant → gate table (no empty rows; the gates named with their
test files; add-only per the round's stop clause d):

| invariant / guarantee | executable gates |
| --- | --- |
| ① prefix-complete recovery (+ Ambiguity Never Auto-Repeats) | prefix-table-gate.test.ts (16 rows); kill9.test.ts:311-436; alpha-gap-ruling.test.ts |
| ② the durable-decision law (+ Durable Start Before Side Effect) | prefix-table row "call_end + stop, no decided"; healing-fixtures.test.ts; truncation-guard.test.ts:44-74; execution-gate.test.ts:56-70; parallel.test.ts:137-141 |
| ③ the incomplete-draft law | draft-tail-red.test.ts; dangling-invocation-red.test.ts; prefix-table live-order rows |
| ④ identity trichotomy | prefix-table decided/denied/execute rows; storage-identity.test.ts; the generation-normalization gates (this round) |
| ⑤ kernel tenancy | adapter-trust.test.ts:49-69; event-schema.test.ts; **the whitelist drift gate (this round, R5)** |
| ⑥ byte stability | prompt-cache.test.ts:14-50; summarize.test.ts:52; extensions.test.ts:315; **the compacted-generation byte case (this round, R1a/R8a)** |
| G1 same-facts-same-projection | **the purity gate (this round, R7)** — derivation never reads trace data, no I/O |
| G2 exactly-one-terminal | loop.test.ts terminalOf; terminal.test.ts; adapter-trust.test.ts:55-62; crash-matrix.test.ts:337; recovery-plan.ts:89 |
| the envelope shape | **the envelope-shape drift gate (this round, R2a)** |
| the ≥4-generation load contract | **the generation gate (this round, R4/R4a)** — load → validate → project → deriveRecoveryPlan over every fixture, in check |

### §8 The ask semantics (rulings R9, R10)

The named clauses (Amendment 1's three sentences, renamed — no more
positional "sentence 3"):

- **Pair atomicity.** A tool call and its result project atomically —
  both or neither.
- **Void scope.** The abandon marker voids model output —
  text_delta/thinking/tool_call_* — never the framework's facts.
- **Voided-request expiry.** A stored permission_requested whose
  invocation is voided is expired — never re-presented, never executed.

**The boundary asymmetry closes as a semantic-axis unification (R9).**
The contract sentence: **"a pending ask lives iff its invocation is not
voided and the derivation can still execute it."** The stop-vs-user_input
asymmetry (ADR-0048 §3's OPEN line) is thus DERIVED from void semantics,
not dictated by boundary rules: a `user_input` boundary commits the
suffix to continuation (the liveAsk exemption, ADR-0047 Amendment 2),
a `stop` boundary closes the turn and the draft's undecided asks die with
it. The unification candidate (any pending ask re-presents) was rejected
R9: it would repeal the voided-request-expiry limb, reopen the R-E
straddle adjudication, and re-present asks whose invocations are voided —
approving a ghost call the contract forbids to execute. Zero code; the
gates are untouched. ADR-0048's open line is marked CLOSED with a
back-reference.

**The liveAsk exemption (R10), contractual wording:**
1. **Scope.** The exemption applies only when (i) a durable
   `permission_requested` stands in the suffix, (ii) the decision was
   persisted as a durable `permission_decided` for that `decisionId`,
   and (iii) the (request, decision) pair closes the call — the missing
   `stop` is ratified retroactively by the pair.
2. **Boundary.** The exemption NEVER applies to: (i) a voided request
   (expired — never re-presented, never executed); (ii) an execution
   with no `tool_execution_started` receipt (the crash window is the
   human's, the α ruling); (iii) a denied request (a denial is a closed
   decision, not a ratification).
3. **Limit.** Ratification outranks the missing stop ONLY within the
   closed pair: it never re-opens an expired request, never revives a
   voided invocation, never authorizes an effect whose request was never
   persisted.

**Ratification is durable, direct or delegated (R10, decidedBy (i)).**
`permission_decided.decidedBy` absent = the human decided directly;
present = a policy the human installed decided by delegation — both are
the human's authority. Ratification does not tier by decidedBy: a policy
verdict is a persisted fact like any human decision (R-E pinned), and the
same log must project identically regardless. Amendment 2's historical
source sentence ("human ratification outranks the missing stop") is
retained as history; the contract sentence is **durable ratification
(direct or delegated)**.

### §9 Versioning (ruling R11)

The contract's authority lives in this ADR + its gates, not the version
string. 0.1.49 ships this contract; the v1.0.0 flip is the owner's
post-APPROVE decision (the launch-polish queue item), consistent with
R11's I1.

### §10 Post-1.0 evolution (the documented residuals)

- Lineage links land in the trace ledger (the Efficiency Foundation
  round, first work item = Request Trace) — outside f)'s boundary.
- The ToolResult dual-plane reservation (§5.3) is the admission path for
  artifactRef-style surfaces.
- The C1→C2 microcompact policy difference is produce-side history; if a
  future policy change writes a different boundary placement, it rides
  the §5 ritual, never a silent format change.
- The lock's identity format is the cross-version channel (ADR-0050 §6);
  a future format change is a MAJOR contract change (§5.4 family) under
  the quarantine upgrade contract.

## Migration

None for existing sessions — normalization is read-time; old logs load
and project exactly as before (byte stability, R1a). The round's own
fixture gate is the migration evidence: ≥4 real generations, all green
load → validate → project → deriveRecoveryPlan in `npm run check`.

## Conformance

The round's stop clauses: (a) zero new features — freeze and normalize
only; (b) the core line accounting (29-line headroom at the round's
start; per-commit accounting; measured over → STOP and return with the
precise accounting + eviction-candidate analysis — the delivery.ts
README-tenant confirmation from R-E is itself an adjudication matter if
it becomes a candidate, never a default; the validator shape-diet is the
parallel candidate); (c) ruling phrasing discipline; (d) R-E prefix
table, healing fixtures, R-F crash matrix, R-G lock suite: add-only, no
edits — deviations declare + cite + rule; (e) the gates table above is
the contract's executable face.

## Amendment 1 (2026-08-12): the post-1.0 version convention

The 1.0.0 flip (the R-I round) is a whole-line event: all 13 public
packages (core, runtime, evals, the two providers, tools-node, tui,
tui-cells, the four extensions, cli) move to 1.0.0 together. Core and
runtime's 1.0.0 is the semver public promise of this ADR's frozen ABI;
the 0.1.x per-package counters are archived and never resume.

The version convention after the flip:

- **The release round is the cli minor** — 1.1.0, 1.2.0, …; the cli's
  minor is the release number (the cli has been the release counter
  since the 0.1.x era; the convention continues).
- **Packages bump per the §5 evolution rules**: an additive-optional
  admission (rule 1) ships as a MINOR; a fix ships as a PATCH; a
  frozen-surface break is FORBIDDEN — it can only land through the
  contract-amendment ritual (§5.2(iv)), i.e. a MAJOR.
- **An envelope change is a MAJOR** (§5.4's original sentence — the one
  change that may justify introducing a schemaVersion).
- **Tags are ANNOTATED from this round** (v1.0.0 and onward; 0.1.49's
  lightweight tag was the P4 note — not a precedent to follow).
- **No deprecate of 0.1.49** — nothing is wrong with it; the line's
  deprecation history stays as-is.

## Amendment 2 (2026-08-13): the version reset — 0.2.x, and the real 1.0

The 1.x line (npm versions 1.0.0–1.2.0) is DEPRECATED on npm — a
physical unpublish proved impossible (npm forbids unpublishing any
version that has dependent packages in the registry, and the monorepo's
own packages all depend on `kiso-core`; see (a)). All 13 public
packages reset together to 0.2.0, mirroring the 1.0.0 flip as a
whole-line event (the product line pinned core, provider-anthropic,
and tools-node, so the sync is all 13, not runtime+cli alone).

**This amendment changes ONLY the version statement, never the
contract.** The frozen ABI, the envelope, the generations, the gates —
every §1–§10 fact stands exactly as frozen. Amendment 1's sentence
"Core and runtime's 1.0.0 is the semver public promise of this ADR's
frozen ABI" is superseded: the semver promise of the frozen contract
is now expressed on the 0.2.x line, and the REAL 1.0 is owner-decreed,
gated by the trigger template below.

### (a) The adopter-face principle: npm deprecates, history stays

- **Immutable history, both kinds**: the git commit history and the
  annotated tags v1.0.0–v1.2.0 are BOTH preserved. A tag is history,
  the same way a commit is — deleting a tag would be history erasure
  and is not done, ever.
- **Why deprecate, not unpublish**: unpublish was attempted and
  refused by npm with `E405 — has dependent packages in the registry`.
  npm forbids unpublishing a version that any other published package
  depends on; every 1.x package depends on `kiso-core@1.x`, so the
  whole line is undeletable. npm's own error names the remedy
  (`npm deprecate`). A second wall stood behind it: npm has retired
  TOTP 2FA, so a write needs a security-key (WebAuthn) or a recovery
  code, and a bypass-2FA granular token is explicitly barred from
  unpublish. The lesson is recorded: a published multi-package
  monorepo cannot roll its versions back by unpublishing — it
  deprecates the old line and moves `latest`.
- **Adopter-facing cleanup happens on the npm/registry surface only**:
  the 1.x npm versions are DEPRECATED (each carries "Superseded … use
  0.2.x", rendered with a strikethrough and an install-time warning),
  and the `latest` dist-tag is re-pointed at 0.2.0. That is the entire
  adopter-visible change — the 1.x versions remain resolvable but are
  flagged dead.
- **The tag↔npm mapping table** (filed from `npm view` ground truth at
  execution): for every v1.x tag, the npm versions it points to and
  their deprecated status — an honest account, so the record says
  plainly "the tag exists; the npm version it names is deprecated, not
  removed". This is the answer to any future "why is v1.0.0 flagged"
  question.

| tag | npm versions it names | deprecated |
|---|---|---|
| v1.0.0 | all 13 packages @ 1.0.0 (core, evals, provider-anthropic, provider-openai, tools-node, runtime, tui, tui-cells, mcp-ext, skills-ext, subagent-ext, task-ext, code) | yes |
| v1.0.1 | runtime 1.0.1, code 1.0.1 | yes |
| v1.0.2 | runtime 1.0.2, code 1.0.2 | yes |
| v1.0.3 | code 1.0.3 only (the R-I-p2 bare-command patch was cli-only; runtime has no 1.0.3) | yes |
| v1.1.0 | runtime 1.1.0, code 1.1.0 | yes |
| v1.2.0 | runtime 1.2.0, code 1.2.0 | yes |

22 1.x versions in total (11 packages × 1.0.0 + runtime × 5 + code × 6),
all deprecated (verified 2026-08-13). The tags above stay in the
repository, annotated, forever.

### (b) The real-1.0 trigger template (R6b)

The real 1.0 requires ALL THREE conditions satisfied AND the owner's
ratification — written text, not vibes:

1. **External real adopters ≥ N** — N to be filled by the owner;
   recorded as TBD at this amendment.
2. **One full quarter of the frozen contract with zero breaking
   changes** — the §5 evolution rules' breaking paths (envelope change,
   frozen-surface break) untouched for a continuous quarter.
3. **The owner's explicit approval**, recorded in the review lane.

Until the trigger fires, the line stays on 0.x.

### The version convention after the reset

- The release round remains the cli minor on the 0.x line (0.2.0 →
  0.3.0 → …); the cli is the release counter, as since the 0.1.x era.
- **The 0.x line's minor count has NO cap** — 0.9.0 is followed by
  0.10.0, never 1.0. The real 1.0 happens ONLY by the owner's decree
  (the R6b three conditions above, nothing less); version progression
  NEVER auto-reaches 1.0.
- Packages bump per the §5 evolution rules within the 0.x line.
- A future real 1.0 is again a whole-line flip (all 13 together),
  mirroring Amendment 1's whole-line event — and it costs the
  trigger-template gate above, nothing less.
- Tags remain ANNOTATED (Amendment 1's sentence stands, on the 0.x
  line).
- Deprecation history stays as-is (Amendment 1's final sentence
  stands; the 1.x versions are REVOKED by the reset sequence's step
  ③, separately ordered after the product-line migration
  confirmation — not by this amendment itself).

## Amendment 3 (2026-08-16): invariant ⑥'s scope, and the declared-supersession ritual for the model-request projection

Two E-track rounds changed the bytes the runtime SENDS TO THE PROVIDER
for pre-existing durable facts — E5 removed the task extension from
the default composition (an old session driven under 0.3.0+ composes
a different request than under 0.2.x), and E6 (e) reframed the
`summarized` boundary from an assistant reply to a user-role context
block (6ad1305, ordered in the E6 disposition; the ADR-0044 projection
goldens — including this ADR's ⑥-named `summarize.test.ts` gate —
byte-moved under a declared "sanctioned supersession"). Both were
owner-adjudicated; neither amended this document. This amendment
closes that gap. It changes the CONTRACT TEXT's precision, never the
durable ABI: every §1–§10 fact about events, load, replay, and
recovery stands exactly as frozen.

**(a) Invariant ⑥'s scope, stated exactly.** "Optional growth never
changes old-log projection bytes" binds two planes: (i) the durable
log's own replay and content projection — persisted text (compacted
clearings, summaries, results) replays VERBATIM, forever (the
ADR-0044 promise, summarize.test.ts:127); (ii) schema growth — adding
optional fields or new event kinds never changes how an old log
loads, validates, or derives recovery. The MODEL-REQUEST projection —
the bytes assembled for the provider from those facts — is the Model
Request Surface (the roadmap's four-surfaces vocabulary): a VERSIONED
surface outside the frozen plane, evolving with the efficiency track.

**(b) The declared-supersession ritual (the E1/E6 mechanism, now the
rule).** A change to the model-request projection of existing fact
shapes is legal ONLY as a declared supersession: named in the commit
message, carried by a red test first, the moved golden updated in the
same change, and — this amendment's addition — the affected gate row
in this ADR annotated in the same change. Registered instances: the
E1 v2-rejection gate reversal (the E2 round), the E6 (e)
summarized-boundary reframing (6ad1305). Silent byte drift of the
request projection remains a violation.

**(c) The public G1 sentence, tightened.** The README guarantee row
read "the same prefix projects to the same bytes, every time" —
stronger than G1's meaning (the PURITY of derivation: no I/O, no
clocks — determinism within a version). The row now reads: the same
prefix projects to the same bytes on any given version; the
model-request surface evolves only by declared supersession.

Gate-table annotation (per (b)): invariant ⑥'s row names
summarize.test.ts:52 — that golden's summarized-boundary assertions
moved to user-role + framing by the E6 (e) declared supersession
(6ad1305); the row's durable-replay members (prompt-cache.test.ts,
the compacted-generation byte case, summarize.test.ts:127) are
untouched.
