Translated from the original Chinese round record (2026-08-06)

# Performance round — parallel execution + in-stream execution + MCP lazy connection (ADR-0024's trigger conditions fulfilled), release 0.1.26

2026-08-06. Spec: "the performance round (ADR-0024's trigger conditions
fulfilled): parallel execution + in-stream execution + MCP lazy
connection, release 0.1.26. Prerequisite: v5 (mono + wording) already
landed under review. This round moves the kernel's execution order —
highest discipline." Reporting discipline as usual (the two clean-tree
machine lines).

## Evidence gathering (evidence before code)

- ADR-0024 decision #4 (serial execution)'s revisit clause is the
  trigger-condition text: "when a real workload shows the sequential
  ledger is the bottleneck — restore windowed batching with the ledger
  events emitted per call in deterministic order". This round's bench
  T3 multi-tool rounds + the spec declare the trigger fulfilled.
- The execution-order status quo: loop.ts is two-phase (stream
  collection → sequential execution); executeOne is an async generator
  yielding events one by one; the projection orders tool_result by seq
  (completion order); the registry snapshots extension tools; the MCP
  factory awaits every connection sequentially (startup-blocking).

## Parallel + in-stream execution (kernel)

- **In-stream execution**: once tool_call_end passes validation + the
  policy chain, the call LAUNCHES, in parallel with the model's stream.
  Execution events flow through a shared queue, drained by the stream
  loop per event — seq is monotone in completion order (the EventLog
  is the single allocator). Window cap 4 (the constant WINDOW_SIZE).
- **Write-ahead guarantee**: a STARTED event is only drained after the
  ack — a handler never runs before it is on disk. executionId is
  allocated atomically at the append site (`ex-<seq>` — replay/resume
  derive the same id; under concurrency the old lastSeq+1 prediction
  raced, now dead); decisionId uses a monotone counter (an association
  key, its value unrelated to seq).
- **ask conservative ordering**: the decide phase chains serially in
  call order; the ask human-decision gate runs AFTER that (regardless
  of the verdict — the context may have changed while the human
  deliberated); everything before the ask runs freely.
- **Violation/abort semantics**: forged events, post-stop violations,
  and incompatible stop reasons all VOID the whole round — the violated
  signal: executions already started run to completion and land their
  receipts (as usual); not-yet-started ones bail (abort semantics — no
  started, no uncertain); the terminal comes after the receipts. The C
  group stop-reason verification changes from "block the execution" to
  "void the whole round" (the call already launched at tool_call_end).
- **Byte discipline (projection)**: same-round tool_results are
  buffered and flushed at the round boundary in call order — completion
  order only affects WHEN they land on disk, never the derived
  messages. Non-render events (execution/permission/usage) no longer
  flush the assistant mid-message — every tool_calls message must be
  followed immediately by its tool messages (a real DeepSeek 400: found
  by bench measurement).

## MCP lazy connection (extension layer)

- The factory returns immediately; the connection starts in the
  background; startup no longer blocks.
- The tool list comes from a TOOL CACHE ($KISO_HOME/mcp-tools.json,
  written after a successful connection, storing the raw tool names):
  cached tools register immediately; a call before readiness WAITS on
  the connection (with a timeout); disconnection is honest (a failed
  connection → calls report a connection error).
- A banner "mcp (connecting…)" state (the extension contract gains an
  optional `connecting` field); mcp__status shows
  connecting/connected/error.
- The registry gains registerLive (a live tool source) — tools landed
  by a background connection are callable immediately, no session
  rebuild needed.

## Verification (red→green)

- ① parallel: three 300ms tools wall-clock ~300ms (serial ~900ms, the
  <60% threshold) — packages/core/tests/parallel.test.ts.
- ② the kill9 parallel variant: one round with 3 concurrent shells,
  killed after 3 started → 3 uncertain, resume resolves them one by
  one → the trajectory completes (a new kill9.test.ts variant, 3 tests
  all green).
- ③ byte discipline: a concurrent round projects in call order (the
  projection assertions in loop.test.ts).
- ④ in-stream: a 300ms-gap stream, started before stop (proven by the
  seq timestamps).
- ⑤ ask conservative ordering: the ask and everything after it wait;
  already-approved calls go first (seq assertions).
- ⑥ MCP: the banner is immediate + the connecting state; a cached
  tool's first call waits for readiness; disconnection is honest.
- ⑦ bench T2-T4 re-run: wall clock stated honestly — no measurable
  change (within LLM variance; tools are ms-level, the wall = model
  round-trips); the parallel win shows when tool latency dominates
  (the synthetic gate 900→300ms). The README says so.
- Fixes along the way: two real projection bugs (cross-round results
  mixed into the buffer → a real DeepSeek 400; execution events
  flushing mid-message split the assistant message → 400), both
  located by real-machine reproduction.

## Gates

- core 2034/2000 — over by 34 (spec-mandated increments: the parallel
  mechanism + the projection buffer + the registry live source). A
  ruling requested per ADR-0043 Amendment 1 (the 0.1.23 cli precedent):
  recalibrate the core gate or accept this round's overage. cli
  1547/1856 ✓ · tui 1361/1520 ✓.

## Release

0.1.26, eight packages, the standard template flow.

## Acceptance

- clean-tree: `git status --short` empty + `git log origin/main..HEAD
  --oneline` empty (pushed).
- Out of scope: request-level concurrency (parallel multi-model rounds)
  / speculative execution.

## ⚠ Awaiting a ruling

- core gate 2045/2000 (spec-mandated increments +45, the ADR-0043 Amd 1
  escape-hatch request; the 0.1.23 cli precedent: deliver + request the
  ruling, then add the check evidence once the gate number lands).

## Release record (post-publish)

- registry: all 8 packages at 0.1.26; the global CLI upgraded to 0.1.26.
- Parallel re-verification on the published artifact: a fresh-directory
  PTY smoke — three 800ms tools wall-clock 0.9s (serial 2.4s), the
  session shows 3 started events, all results return. The D area is
  intact on the published artifact (real DeepSeek re-verified by bench
  T2-T4 all pass, zero 400s).
