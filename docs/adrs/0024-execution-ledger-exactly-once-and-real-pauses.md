# ADR-0024: The execution ledger, exactly-once recovery, and real approval pauses

- **Status:** Accepted; decision #2 (the (name, input) dedup guard) is
  SUPERSEDED by ADR-0025 (executionId identity) — see 0025 for the current
  exactly-once mechanism; decision #4 (sequential execution) is SUPERSEDED
  by Amendment 1 (the parallel execution returns) — see the amendment below;
  decision #4's `concurrencySafe` sentence is SUPERSEDED by Amendment 2 (the
  field is retired at 0.12.0; the race moves to EC-1); Amendment 1's
  decisions #1, #2, #3 and #5 are SUPERSEDED by Amendment 3 (the execution
  window, the FIFO fence, the post-commit ask — the EC-1 round, ADR-0052),
  which also discharges Amendment 2's referral of the race.
- **Date:** 2026-08-03
- **Layer:** L2 Kernel / L3 Tool / runtime

## Context

Reliable Session Alpha's central promise is that a confirmed-successful side
effect never runs twice and an interrupted one is never silently re-run.
Before Phase D the kernel had neither a record of executions (only the model
facing `tool_result`) nor a real human-in-the-loop: `defer` was converted to
a denial with reason "awaiting user approval" (permission.ts's M1 note), which
fakes the pause — the model sees a refusal and adjusts, the human never
decided anything, and a crash between "ran the tool" and "wrote the result"
was indistinguishable from "never ran".

## Decision

1. **The ledger is the event log** (ADR-0002, no second store). Every tool
   execution appends `tool_execution_started` BEFORE the handler and
   `tool_execution_succeeded` / `tool_execution_failed` after, all write-ahead
   through the same log the session persists. `kernel/ledger.ts` derives
   status per call and per (tool, input) purely from events.

2. **The exactly-once guard keys on (name, input), not call id** — provider
   call ids never repeat, so the same side effect re-issued after a crash
   carries a fresh id. Before execution the loop consults the ledger:
   - a confirmed success is REPLAYED (recorded result returned, handler not
     called) unless the tool declares `idempotent: true` (reads, searches);
   - an interrupted execution (started without a result) or a human-abandoned
     one BLOCKS with a precondition result — the model sees why, and nothing
     runs until a human resolves it (`tool_execution_resolved`: "rerun" —
     the human takes responsibility — or "abandoned");
   - a failed attempt is not a side effect; re-runs are allowed.

3. **`defer` is a real pause.** The loop persists `permission_requested`,
   yields it, and awaits the approval channel (`resolveApproval`) inside the
   SAME run frame; the human's `approved`/`denied` is persisted as
   `permission_decided` before execution continues. The resolver is
   registered before the event is announced, so an answering consumer never
   deadlocks. Unanswered requests are re-presented after a restart
   (`session.pendingApprovals()`), and a session-level approve() after the
   run is gone persists the decision directly.

4. **Execution is sequential again.** The windowed parallel batching
   (ADR-0015) was removed because the ledger and the pause require
   deterministic, write-ahead ordering between calls. Parallel execution
   returns as an optimization once the ledger contract is stable — the
   `concurrencySafe` field stays on the contract.

5. **Abort reaches the running tool** through `ctx.signal` (already wired);
   the runtime merges an external signal (CLI stop) with the run's own
   controller (`MergedSignal`).

## Consequences

- The loop's execute phase became an async generator of ledgered events;
  the incident fixtures run on the real session runtime (acceptance).
- `Tool` gained `idempotent?: boolean` — the default (false) is the safe side.
- New event variants (`tool_execution_*`, `permission_*`) joined the closed
  union; consumers that switch exhaustively must handle them.
- A run paused on approval is NOT a terminal — the generator stays alive;
  abandoning it leaves a durable `permission_requested` that the next
  session presents again.

## When to revisit

- Parallel execution: when a real workload shows the sequential ledger is
  the bottleneck — restore windowed batching with the ledger events emitted
  per call in deterministic order.
- The (name, input) key: if two distinct side effects legitimately share a
  name and input but must run twice (counter), the key needs an explicit
  `dedupeKey` on the tool. Not before a real product hits it.
# ADR-0024 Amendment 1 — the parallel execution returns (the trigger condition is met)

- **Status:** Accepted (amends ADR-0024, decision #4)
- **Date:** 2026-08-06 (the performance round, 0.1.26)
- **Layer:** L2 Kernel / L3 Tool

## Context

ADR-0024 decision #4 removed the windowed parallel batching (ADR-0015)
because the ledger and the approval pause required deterministic, write-ahead
ordering between calls. Its "When to revisit" clause named the exact
trigger: *"Parallel execution: when a real workload shows the sequential
ledger is the bottleneck — restore windowed batching with the ledger events
emitted per call in deterministic order."*

The trigger is met: real multi-tool sessions (the bench T3 cross-file
rename, the coding agent's read→edit→verify turns) showed the sequential
execution serializing tool latency that the model stream could have
overlapped — and the spec declared the performance round. The ledger
contract (ADR-0025 executionId identity, the receipt repair, the uncertain
window) is stable; this amendment restores the batching WITH the ledger
events emitted per call in deterministic order.

## Decision

1. **Streaming execution.** A `tool_call_end` that passes
   validation and the policy chain LAUNCHES its execution immediately,
   while the model stream continues. The launched executions' events land
   through a queue the stream loop drains on every stream event — their
   seq order is the COMPLETION order (started/receipt/result land when
   each execution finishes; seq stays monotonic by construction — the
   EventLog is the single allocator).

2. **The window.** At most `WINDOW_SIZE = 4` executions run concurrently.
   The window bounds the turn's executions; the next turn has its own.

3. **The ask conservative order.** The DECIDE phases run in CALL
   order (a serialized chain): when a call's verdict is `ask`, its human
   resolution gates the calls AFTER it — they start only once the human
   decides, whatever the outcome (the context may have changed when the
   human approves). The calls BEFORE the ask run freely.

4. **The write-ahead survives.** The STARTED event is acked by the drain —
   the handler never runs before its receipt is persisted. An executionId
   is allocated ATOMICALLY at the started's append (`ex-<seq>` — the id
   equals the event's seq, so the same logical execution derives the same
   id on a replay or a resume; under concurrency the old `lastSeq + 1`
   prediction raced and is gone). The decisionIds come from a monotonic
   per-log counter (correlation keys; the value's relationship to the seq
   is meaningless).

5. **A voided turn (forged event, post-stop violation, a non-compatible
   stop reason) fires the violated signal**: the started executions finish
   and their receipts land BEFORE the terminal (receipts for already-launched
   executions); the not-started bail without a started event (abort semantics
   — clean, never uncertain). The C group stop-reason verification now VOIDS
   the turn
   instead of preventing the execution — the calls were already launched.

6. **The byte discipline.** The projection buffers ONE turn's
   tool results and emits them in CALL order at the turn boundary —
   the completion order (physical seq) never enters the derived messages.
   The same logical turn projects byte-identically whatever the completion
   interleaving. Non-rendered events (executions, permissions, usage) do
   NOT flush the assistant mid-message: each tool_calls message must be
   followed by ITS tool messages (a real DeepSeek 400 otherwise).

## Consequences

- The loop's execute phase is no longer a sequential for-loop; the launch
  machinery (queue, window, gate, settle) lives in kernel/loop.ts.
- An abort abandons the in-flight launches (started without receipt →
  uncertain), exactly as before; the settled turn's receipts land before
  any terminal.
- The MCP bridge registers its servers' tools through a LIVE registry
  source (tools land post-connect, callable the moment they do).
- The kernel grew: core measured 2,034/2,000 at delivery — the growth is
  this amendment's spec-mandated increment.

### The return-in-place extraction (the gate ruling, same record)

The gate ruling (2026-08-06): **no recalibration — the escape hatch is
relocation.** The `summarize` orchestration (kernel/summarize.ts, ~120
lines) is off-loop: it calls the ADAPTER to generate a summary, which is
the RUNTIME's arrangement — the kernel's duty is the `summarized` event
type and the projection semantics. It had been parked in the kernel by a
context-round expedience; this amendment's growth pushed it out:

- `summarizeConversation` + the boundary math moved to
  `packages/runtime/src/summarize.ts` (the session's own adapter, zero
  behavior change: /compact and autoCompact byte-identical, the context
  suite's assertions untouched — the relocation's zero-behavior
  acceptance);
- the kernel keeps the `summarized` event + its projection semantics;
- core measured 1,981/2,000 after the relocation (19 lines of headroom).

## When to revisit

- The window size: a real workload whose parallel tool latency exceeds the
  model latency shows the sweet spot; the constant is a single place.
- Request-level concurrency (multiple model turns in flight) and
  speculative execution are explicitly OUT of scope.

## Amendment 2 (2026-08-18): `concurrencySafe` is retired, the race is not

Decision #4's closing sentence — "the `concurrencySafe` field stays on the
contract" — expired at 0.12.0. The SC-1 semantic-contract audit found the
field DECLARED and consulted by nothing: Amendment 1 returned parallel
execution with a FIXED window of 4 and never wired the predicate, so
declaring it, omitting it, or returning `false` from it produced the same
schedule. The SC-1 memo's adjudication (owner, 2026-08-18) ruled removal
while the 0.x window is open, and the SC-1b round removed the field from
`Tool` (packages/core/src/tools/tool.ts) along with its unwired sibling
`delivers`.

The removal is a correction to the RECORD, not to the schedule: the pins in
packages/core/tests/sc1-tool-contract-pins.test.ts measure the same
window-of-4 overlap before and after, which is the evidence that nothing
depended on the field.

**The race stays open.** The reason a tool might want isolation did not go
away with the field that failed to provide it; that question moves to EC-1,
which owes a mechanism NOT built on a per-tool opt-in. The retired
predicate's own shape is the argument: parallel-safety is a per-CALL
judgment — the same tool is safe for one input and must be serial for
another — and a static per-tool flag cannot express it. A future mechanism
enters with a wiring and a gate, never as a field that describes an
intention the kernel does not keep.

## Amendment 3 (2026-08-19): the window is an execution window — eligibility, the FIFO fence, the post-commit ask

- **Status:** Accepted (amends ADR-0024 decision #4; SUPERSEDES Amendment
  1's decisions #1, #2, #3 and #5; discharges Amendment 2's referral of
  the same-path race)
- **Date:** 2026-08-19 (the EC-1 effect classification round, 0.13.0)
- **Layer:** L2 Kernel / L3 Tool
- **Companion:** **ADR-0052** — Durable Turn Commit is the boundary this
  scheduler serves. The seven invariants, the Turn Commit definition, the
  `effects` certificate's shape and the recovery classes live there and
  are deliberately not restated here; this amendment records only what
  changed about ADR-0024's own subject, the scheduler.

## Context

Amendment 1 restored parallel execution as ONE mechanism doing three
jobs. A `tool_call_end` that passed validation and the policy chain
launched immediately (#1); at most four ran at a time (#2); a call's
human ask gated the calls after it (#3); and a voided turn caught its
already-launched executions on the way out (#5). Every one of those jobs
was measured in PENDING INVOCATIONS rather than in running work, and
every one of them started the handler before the model's turn had proven
valid — which is the same sentence twice, because the window was also
the admission control.

Amendment 2 then retired `concurrencySafe` and stated plainly that **the
race stays open**, referring the mechanism to EC-1 with one binding
instruction: it must not be built on a per-tool opt-in for correctness.

EC-1 splits the jobs apart. Admission becomes ELIGIBILITY, ordering
becomes a FIFO barrier, and the window shrinks to what its name always
claimed — concurrency of running work.

## Decision

1. **Queue → eligibility → execution window.** An accepted invocation is
   ELIGIBLE when it is committed (or precommit-eligible per #4),
   authorized, and barrier-clear. Only a RUNNING execution consumes a
   window slot:

   > the window is an execution window, not a pending-invocation window

   so four held writes can never starve a runnable sibling. In code the
   split is the statement order in `packages/core/src/kernel/loop.ts`:
   the commit wait, then the barrier wait, and only THEN
   `acquireWindow()`. Waiting also leaves no durable trace — crash-matrix
   row C1 kills the process while one call is inside its handler and a
   sibling is held behind its fence, and finds exactly ONE
   `tool_execution_started` on disk: the held sibling is clean, not
   uncertain, so the human adjudicates one interrupted execution and
   never two.

2. **The FIFO fence, installed at ACCEPTANCE.** An exclusive invocation
   installs its barrier when the scheduler accepts it, not when its
   handler starts; later siblings — including precommit-safe reads —
   never overtake it. Undeclared means exclusive (ADR-0052 §5: absence is
   the conservative truth), so this closes the same-path write race
   Amendment 2 left open WITHOUT the per-tool opt-in that amendment
   forbade: a tool author who forgets everything gets serialization, and
   the most a forgotten declaration can cost is throughput.

   The fence is deliberately conservative in one direction: a read
   accepted after a write loses its latency win even when the two touch
   unrelated paths. That is the price of having no per-call conflict
   granularity yet, paid knowingly (ADR-0052, "When to revisit").

   Evidence (`packages/core/tests/ec1-effects.test.ts`): two same-path
   `edit_file` calls SERIALIZE in call order where the base interleaved
   them; a declared-shared pair still overlaps; an exclusive call blocks
   a later shared sibling; and a shared call ahead of an exclusive one is
   not delayed by it.

3. **The authorization order: the ask moves AFTER Turn Commit.** A human
   must never approve a call whose turn then proves invalid, so the pause
   waits for this turn's own commit exactly as a handler does. An
   uncommitted turn asks nothing and starts nothing.

   Amendment 1 decision #3's CONSERVATIVE ORDER between siblings survives
   unchanged — the decide phases still run in call order, and a call's
   ask still gates the calls after it. What moves is WHEN the question
   reaches the person. Two structural details are load-bearing: the ask
   gate stays installed in the DECIDE chain rather than at the ask (a
   precommit-eligible sibling must learn that an ask was accepted ahead
   of it BEFORE the commit exists, and the decide chain is the only thing
   that runs in call order), and the gate is per-call — one shared
   release meant the first ask's resolution opened the second ask's gate.

4. **The launch rule replaces "launches immediately".** A call may start
   before its turn's commit IFF its tool declares `precommitSafe` AND its
   authorization is already satisfied (an `allow` verdict, no human in
   the loop). Both halves are necessary: the certificate says the
   EXECUTION is harmless, never that the authorization is unnecessary.
   Everything else — every undeclared tool, and every declared one that
   still needs a person — waits for the commit.

5. **A voided turn no longer catches launched commit-required work.**
   Amendment 1 decision #5 described the void as arriving after the
   calls were already launched: started executions finished and their
   receipts landed before the terminal. After EC-1 a commit-required call
   is never launched before the commit, so a voided turn has no
   commit-required receipt to land. Only a precommit-safe execution can
   leave one, and ADR-0052's invariant 7 governs what it means — the
   receipt is an honest fact, and it never makes the turn valid.

## Consequences

- The declared SCHEDULER-TIMING class: every test that pinned launch
  TIMING is restated, never relaxed — `parallel.test.ts`,
  `execution-gate.test.ts` (×3), `execution.test.ts`, `loop.test.ts`,
  `sc1-tool-contract-pins.test.ts`, `sc1-truncation-contract-pins.test.ts`,
  and crash-matrix rows H2/H3 (the post-pause persist order is now
  `decided → execution` because the stop is durable before the person is
  asked; each row's crash point and recovery verdict are unchanged).
- A user-visible CADENCE change, reported rather than hidden: tools that
  declare nothing now arrive in the settle drain instead of one per
  stream event, so a repeated in-turn render (the task block) repaints in
  place where the base scrolled a new copy into the record each time.
  No TUI or CLI source changed; `apps/cli/tests/tui-v7-task.test.ts` is
  restated around cadence-free claims.
- The kill -9 parallel cell needed a truthful declaration to keep its
  three-way overlap: `shell` declares nothing, so after EC-1 the kernel
  serializes it. The cell now drives a test-authored extension tool
  declaring `concurrency: "shared"` (honest — each invocation writes its
  own marker path) and deliberately NOT `precommitSafe`, so the calls
  stay commit-gated and still meet the human.

## When to revisit

- **The window size** — unchanged at 4, and now measuring the right
  thing; a workload whose running-execution latency exceeds the model
  latency shows the sweet spot.
- **Per-call conflict granularity (`resourceKey`), safe overtaking, and
  snapshot semantics** — the three ways to give the fence back its lost
  parallelism. All three are future and evidence-gated; ADR-0052's "When
  to revisit" holds the overturn conditions.
