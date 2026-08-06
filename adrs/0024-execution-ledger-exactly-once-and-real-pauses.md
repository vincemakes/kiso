# ADR-0024: The execution ledger, exactly-once recovery, and real approval pauses

- **Status:** Accepted; decision #2 (the (name, input) dedup guard) is
  SUPERSEDED by ADR-0025 (executionId identity) — see 0025 for the current
  exactly-once mechanism; decision #4 (sequential execution) is SUPERSEDED
  by Amendment 1 (the parallel execution returns) — see the amendment below.
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

1. **流中执行 (streaming execution).** A `tool_call_end` that passes
   validation and the policy chain LAUNCHES its execution immediately,
   while the model stream continues. The launched executions' events land
   through a queue the stream loop drains on every stream event — their
   seq order is the COMPLETION order (started/receipt/result land when
   each execution finishes; seq stays monotonic by construction — the
   EventLog is the single allocator).

2. **The window.** At most `WINDOW_SIZE = 4` executions run concurrently.
   The window bounds the turn's executions; the next turn has its own.

3. **The ask conservative order (保守序).** The DECIDE phases run in CALL
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
   and their receipts land BEFORE the terminal (已开跑照落 receipt); the
   not-started bail without a started event (abort 语义 — clean, never
   uncertain). The C 组 stop-reason verification now VOIDS the turn
   instead of preventing the execution — the calls were already launched.

6. **The byte discipline (字节纪律).** The projection buffers ONE turn's
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

### 归位式抽取 (the gate ruling, same record)

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
