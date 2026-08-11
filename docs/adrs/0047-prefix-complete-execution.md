# ADR-0047: Prefix-Complete Execution — the durable recovery law

- **Status:** Accepted
- **Date:** 2026-08-10
- **Layer:** packages/core (protocol) + packages/runtime (recovery)

## Context

The 0.1.43 round answers one question: the durable log stops at ANY
byte — is recovery unique and safe? The 0.1.42 review proved two
recovery-prefix gaps on the shipped code:

- **Gap A (P0 correctness)** — a committed turn (a legal `stop` on
  disk) whose `tool_call_end` is durable but whose permission events
  never landed. `#recover` keyed on `permission_requested` alone
  (run.ts), so the invocation was invisible to recovery; the
  continuation re-drove the model from the projection, which carried
  an assistant message with an unanswered `tool_use` (kernel/project.ts
  has no dangling precheck). The provider 400s and the resume itself
  dies with an error terminal. The window is real, not theoretical: the
  truncation guard holds `tool_call_end` until the `stop`
  (runtime/truncation-guard.ts), so the stop lands in the log BEFORE
  the whole async policy chain drains — a SIGKILL in that window
  leaves exactly `[user_input, tool_call_end, stop]`.

- **Gap B (semantic gap)** — a tail model output with no `stop`:
  `text_delta`/`thinking` are durable, the stop is not. The
  projection's `flushAssistant` commits the truncated draft as a
  finished assistant message (a stop is invisible to the projection),
  and the live loop never emits `assistant_start`/`assistant_end` — so
  after resume, the new turn's deltas merge seamlessly with the
  draft's deltas into one assistant message (the new answer glued onto
  the residual draft).

Both are the dangling-pair-400 family (the 0.1.42 compact-boundary P1)
and the committed-history family (ADR-0026), moved to the recovery
boundary.

## Decision

1. **Prefix-Complete Execution (the definition).** For every valid
   durable prefix, Kiso derives exactly one safe next action or
   terminal state. "Exactly one" is two claims: never zero (a prefix
   must resume to something safe — an undecided invocation is
   re-decided, never silently skipped) and never two (never both
   execute and wait, never both abandon and complete). The 12-row
   prefix table (Spec = Test, permanent in `npm run check`) is the
   proof machine: each row builds exactly the listed durable prefix
   and asserts the one safe action — nothing else.

2. **The durable-decision law.** Only a durable `permission_decided`
   authorizes an effect. A decision computed in memory before the
   crash is not a decision; a hook that half-ran is not a decision.
   Recovery does not guess, does not inherit, does not retro-authorize
   — it re-decides. Concretely (Gap A semantics): a committed turn's
   `tool_call_end` with no durable `permission_decided`, no
   `tool_execution_started`, and no `tool_result` is **UNDECIDED** and
   re-enters the approval pipeline with live-path semantics — the
   composed chain first, then the hooks' `onPreTool` (defer → ask,
   deny → deny, allow → allow), then the kernel's default allow; a
   throwing chain counts as ask (it speaks, never silently):
   - chain/hook allow → durable `permission_decided` (decidedBy
     written faithfully when the verdict carries one) → the persisted
     execution, never re-asked of the model;
   - deny → decided + the denial result;
   - ask / all-abstain → `permission_requested` → the existing human
     pause.
   A stored `permission_requested` is never re-decided: the requests
   pass owns request-tracked invocations (it binds the stored request
   by decisionId, or pauses for the human). The **boundary clause**
   keeps the two gaps apart: a call whose turn has no legal stop is a
   DRAFT's call — Gap B voids it (never executed, never in the
   provider projection). The two gaps divide at the stop; no mixing.

3. **Gap B — the incomplete-draft law.** A model output suffix without
   a committed stop is an incomplete draft and must never become
   committed provider history. On resume, when a tail draft is
   detected after the last committed boundary (stop / user_input /
   terminal / compaction / summarized / an earlier marker), recovery
   appends the append-only boundary marker
   `model_output_abandoned {seq, voidFromSeq, reason}`: the voided
   range is (voidFromSeq, seq], the provider projection excludes it
   (a draft's `tool_call_end` included — double protection with the
   boundary clause), and the audit bytes are never rewritten or
   deleted. The marker is the disambiguation device: once it is on
   disk, "residual draft A + new output B" derives purely — A voided,
   B valid; without the marker the two would merge into one message.
   Idempotent by construction: a re-resume finds the marker as its
   boundary.
   **Naming reason:** `model_output_abandoned` over
   `assistant_attempt_interrupted` — the name names the object it
   voids (a model output suffix), not the turn it belonged to;
   `turn_interrupted` was forbidden because "turn" is polysemous in
   kiso (loop turn / session turn / round). **Kernel-owned:** the
   AdapterEvent whitelist excludes the marker, so adapter/extension
   forgery is `invalid_request` by construction.

4. **The three-identity model.** `callId` is demoted to the provider
   correlation number (it no longer carries the framework identity —
   a provider may legally reuse it); `invocationSeq` is the framework
   identity — the call's `tool_call_end.seq`; `executionId` is the
   physical execution attempt, unchanged. `invocationSeq` is optional
   on the seven identity-bearing events (`permission_requested`,
   `permission_decided`, `tool_execution_started`, `tool_execution_succeeded`,
   `tool_execution_failed`, `tool_execution_resolved`, `tool_result`);
   new logs write it, old logs pair by callId + seq proximity (the
   last such call before the seq). The contract forbids any persisted
   derived state — no InvocationRecord/InvocationStore/InvocationState:
   `Event[]` stays the only durable truth (Persist facts. Derive
   state.).

5. **Precedents — this round is boundary extrapolation, not a new
   principle.** The verdict-race dual-write protection (a human verdict
   racing an abort is recorded exactly once, never lost — session.ts
   #verdicts), `flushPendingVerdicts` (a verdict never flushed is not
   a verdict — the abandoned generator's finally flush), the STARTED
   ACK gate (a tool handler never runs before its STARTED receipt is
   acked — loop.ts execQueue), the E1 no-chain default allow (an
   allow with no decidedBy is no durable fact), and ADR-0026's
   request-level invariant (byte-stable projection at the request
   boundary) all share one shape: *the durable log is the only source
   of truth, and every non-durable state must either become durable or
   be treated as if it never happened.* This round extends that shape
   to the recovery boundary — the byte at which the log stops must
   still yield exactly one safe action.

6. **Kernel tenancy of write rights (this round's correspondence).**
   The stop-clause (b) ruling (2026-08-10), cited as the actually
   issued ruling, not paraphrased:
   > core stays at 2000, no re-baseline, no ADR-0043 Amendment 6 — the
   > cli cap grows with the product, the core cap only by evicting the
   > non-kernel tenants; with a clean extraction path, moving the cap
   > is unjustified.
   The extraction it authorized — the execution ledger moving
   byte-for-byte to the runtime (531aef8) — shrinks the core public
   API by four symbols (`ExecutionStatus`, `ExecutionRecord`,
   `executionLedger`, `executionForCallId`); the protocol then grows
   by ~30 lines (the marker event + the optional invocationSeq
   fields) under the eviction's headroom (core 1931 → ~1961). The
   tenancy principle the ruling enforces: **the kernel owns every
   event type the adapter cannot forge.** The AdapterEvent whitelist
   (ADAPTER_EVENT_TYPES) is that sentence in code — adapters may only
   emit their narrow event set; everything else is kernel-owned, and
   an adapter/extension that yields a kernel event is forging state:
   the loop rejects it as `invalid_request` and the turn ends. The
   marker event, `tool_execution_*`, `permission_*`, `terminal`,
   `compacted`, `summarized`, `user_input` — all kernel-exclusive by
   the same construction. The kernel writes facts (started/receipts,
   its own loop write path); deriving state from facts is the
   harness's job.

7. **The six invariants (preview).** The full treatment lands with the
   1.0 round; previewed here so every later round can cite them:
   ① **Prefix-completeness** — every valid durable prefix derives
      exactly one safe next action or terminal state.
   ② **The durable-decision law** — only a durable permission_decided
      authorizes an effect.
   ③ **The incomplete-draft law** — no committed stop, no committed
      provider history.
   ④ **Identity trichotomy** — callId / invocationSeq / executionId
      never conflated; no persisted derived state.
   ⑤ **Kernel tenancy** — every event outside the AdapterEvent
      whitelist is kernel-owned; forgery is invalid_request.
   ⑥ **Byte stability** — optional protocol growth never changes the
      old-log projection bytes (the ADR-0026 family).

## Consequences

- The prefix table gate (Spec = Test) becomes permanent in `npm run
  check`: the table IS the test — 11 directive rows plus the
  failed-receipt row, each asserting exactly one action. The R-F round
  (recovery-as-projection) reuses it unchanged as its zero-behavior
  proof machine.
- The byte-stable contract (ADR-0026) holds: the optional
  `invocationSeq` fields change no old-log projection byte (the
  prompt-cache byte-discipline tests stay green); the marker changes
  only the projection of logs that carry it — the semantic fix itself,
  expected.
- Old-log compatibility: 0.1.42 and earlier logs load → validate →
  project → resume unchanged (no invocationSeq, no marker events).
- TUI/tui-cells handle the new event type gracefully — never crash,
  never garble; an interrupted hint is optional, and if implemented it
  counts against the tui gate budget (self-proving).
- The 0.1.43 round's own red evidence is the record of why this ADR
  exists: the gate landed red against the first Gap A fix — 8 of 12
  rows failed because a stored request was invisible to the
  decided-search (pending requests auto-executed, human decisions
  re-decided, durable denials overridden, receipt rows re-executed)
  and because a defer policy, being a hook rather than a chain,
  collapsed into an auto-allow on resume. Both holes are closed by
  decision 2's live-path semantics.

## Amendment 1 (2026-08-10): the straddle — void scope, pair atomicity, voided-request expiry

The 0.1.43 round shipped the recovery law; the same round's dogfood
(two live sessions with real kill -9 + resume on the released 0.1.43)
found the law's first live violation, adjudicated REVISE — the round
stays open and R-E 0.1.44 is the rework (the v6 0.1.33 precedent). In
live operation the stop event lands INSIDE the last call's lifecycle:
the loop appends the tool_call_ends and launches the executions, then
appends the stop; the async executor's succeeded/result for the last
call land after the stop. Three sessions (the two dogfood sessions and
the review's independent third, review-0143) all hit the same shape —
stop@41 between started@40 and succeeded@42 (dogfood-0143), stop@45
between started@44 and succeeded@46 (dogfood-0143b), stop@1197 between
started@1196 and succeeded@1198 (review-0143). The abandon marker's
void range (voidFromSeq, seq], derived from the last committed
boundary, swallowed the straddling call's completion records, and the
provider projection pairing broke in both directions: an unpaired
tool_use (the straddling result died with the draft — the 0143b 400
"insufficient tool messages") and an orphan tool_result (the voided
turn's stored request still bound at the requests pass and re-executed
after the marker — the 0143 400 "did not have response messages").
The sessions died in provider 400 error terminals and stayed
permanently poisoned: every subsequent turn re-malformed the same
projection.

Three sentences pin the fix (deviation from any → stop):

1. **Pair atomicity.** "The provider projection includes a tool call
   and its result atomically — both or neither."
2. **Void scope.** "The abandon marker voids model output — text_delta
   / thinking / tool_call_ — never the framework's facts
   (permission*, tool_execution, tool_result, user_input, terminal)."
3. **Voided-request expiry.** "A stored permission_requested whose
   invocation is voided is expired — never re-presented, never
   executed. A draft's call is never executed."

The fix is a pure DERIVATION change — "persist facts, derive state" —
the round's signature proof: no stored log is rewritten, and the three
poisoned sessions heal retroactively by projection (their jsonls,
byte-identical, are the healing fixtures in the runtime test suite;
load → project must be pair-clean). In the projection the void skip
becomes type-filtered to the model-output family (sentence 2 — a
straddling tool_result inside the void range keeps its pair), the
tool_result pass drops a receipt whose declaration never projected
(sentence 1 — the straddling receipt, whose declaration committed
before the stop, still projects; the voided draft's post-marker
receipt is the orphan, dropped from the projection, kept in the
audit), and the requests pass expires a stored request whose
invocationSeq falls inside a void range (sentence 3 — the dead-run
expiry precedent; an identity-less request, where neither the field
nor the callId+proximity fallback yields a seq, is never proven
voided and keeps the pre-0.1.44 behavior).

**Boundary verification.** The draft detection stays text-only: a bare
tool-call suffix [tool_call_end, permission_requested] with no text
after a stop is the legal approval-panel pause — the stored request
binds and executes with a pair-closed projection (the Area 2 contract,
gated by the extensions-e2e test). The round's shapes all carry text,
and the text is what justifies the marker. The gate's no-stop+request
row therefore carries the 0143 text-bearing shape.

**The α-gap open row (recorded, no silent default).** The "already-
executed draft call" — started/receipt appearing inside a no-stop
suffix (the kill landed after the execution began): the declaration
(tool_call_end) is voided as model output, the started/receipt are
framework facts and survive in the audit, and pair atomicity drops the
unpaired receipt from the projection — the projection stays clean. The
execution may have had real side effects, and whether such a call
should surface as "uncertain" is an open definition question —
explicitly an OPEN row, deferred to the R-F/1.0 contract round. No
side is chosen here; the audit keeps the receipt either way.

### Consequences of Amendment 1

- The prefix table gate gains four live-order rows (the minimal
  single-call straddle, the 0143b dual-call parallel straddle, the
  0143 post-marker-orphan shape, the no-stop+request expiry shape) —
  permanent in `npm run check`, same table, driven red then green.
- The healing fixtures (the three poisoned real jsonls, verbatim in
  packages/runtime/tests/fixtures/sessions/) gate the three sentences
  forever: any future regression of void scope, pair atomicity, or the
  voided-request expiry breaks load → project first.
- The straddle is now a gated shape: a live-order row where
  started < stop < succeeded/result must project pair-closed.

## Amendment 2 (2026-08-11): the α ruling — the receipted execution is an outcome

Amendment 1 recorded the α-gap as an OPEN row: the "already-executed
draft call" — started/receipt inside a no-stop suffix (the kill landed
after the execution began) — and whether it should surface as
"uncertain". Adjudicated by the review, relayed via the owner's ask
dialog, 2026-08-11 (the R-F 0.1.46 round surfaced it); the ruling
closes the row:

**RULED — pin current: the audit keeps it.** The receipted execution is
an OUTCOME (the mirror of ruling #12: a complete receipt IS the outcome),
NEVER uncertain — the framework facts (started, receipt, result) survive
in the audit; pair atomicity drops the orphan result from the provider
projection; only the started-NO-receipt window stays uncertain (the
crash window, the human's). The first derivation is ABANDON_DRAFT (the
draft dies), then CONTINUE_MODEL (nothing left to repair — the
receipted pair is complete), then TERMINAL — and the resume walks the
same ordinary program: no ResumeBlockedError, the provider stream stays
pair-closed, the terminal completes. Gated forever by
alpha-gap-ruling.test.ts (red → green: red = "Cannot find module
'../src/recovery-plan.js'" on the API-less tree; green = the full
runtime suite 229/229).

The matrix round also pinned the boundary of the draft detection (the
H rows of crash-matrix.test.ts): a crash MID-PAUSE leaves
[user_input, text, tool_call_end, permission_requested] with NO stop —
the loop persists the stream's tail after the pause resolves. Gap B's
text-bearing-suffix rule must not void the LIVE ask: a suffix after a
user_input boundary that carries a pending permission_requested is the
approval-panel pause (WAIT_PERMISSION re-announces it), never a draft.
A request AFTER a stop keeps the 0143 shape — the marker voids it and
the request expires with the draft (Amendment 1's sentence 3). The
liveAsk rule is an AMENDMENT to Amendment 1's sentence 3 — an
exemption, not a clarification: "a suffix whose pending ask the human
answers is committed by the durable verdict and the closed pair —
human ratification outranks the missing stop" (the full framing and
the stop-vs-user_input boundary asymmetry as a 1.0 open line are in
ADR-0048 §3). The R-E prefix-table gate and the healing fixtures are
untouched — the liveAsk rule only splits the previously-overlapping
shapes.

### Consequences of Amendment 2

- The α row is closed: a receipted draft call is an outcome, the audit
  keeps the receipt, only the started-no-receipt window is uncertain.
- The crash matrix (11 rows, the four effect boundaries before/after +
  the repair-write crashes) is permanent in `npm run check`; the real
  SIGKILL e2e (scripts/demo-kill9.sh) stays the OS-layer evidence.
