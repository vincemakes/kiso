# ADR-0024: The execution ledger, exactly-once recovery, and real approval pauses

- **Status:** Accepted
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
