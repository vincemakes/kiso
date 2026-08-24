# Architecture — the responsibility map

kiso is layered by **decision ownership**, not by package. A package is a
shipping unit; a layer is the answer to "who owns this decision, and what
must it never decide?" The two mostly coincide in this tree — that is
deliberate — but this document is the map of the decisions, and the code
and ADRs remain the source of truth. `docs/concepts.md` explains the
invariants; this document explains the layers that enforce them.

## The stack

```text
Product shell        apps/cli  (+ tui, tui-cells as presentation machinery)
      |
Composition          the CLI chooses, createAgent binds
      |
Agent                definition + session factory        packages/runtime
      |
Session              durable conversation                packages/runtime
      |
Run                  one user turn, write-ahead               packages/runtime
      |
Kernel loop          model <-> tool cycle                packages/core
      |
   ---+-----------------------------
   Providers         wire protocol -> adapter events
   Tools             effect boundary
   Extensions        capability boundary

Adjacent (not in the control chain):
   Store             durability adjudication — who may write the next line

Cross-cutting (observes, never steers):
   Observation plane — trace, usage, evals, bench
```

Control flows top to bottom. The store sits *beside* Session and Run, not
below the loop: it adjudicates writes, it never decides what happens next.
The observation plane reads everything and owns nothing.

## State doctrine

The session's trajectory has exactly **one authoritative state: the
durable event log**. In-memory state exists — the seeded `EventLog`, the
session's active-run set, pending resolvers, an in-flight generator — but
all of it is either a cache of the log or scaffolding for the current
process. None of it is a second authoritative, mutable copy of the
conversation. After a crash the authoritative facts come from the log and
only the log (ADR-0002); every trajectory adapter call is a pure
projection of it (ADR-0026); every event is persisted before a consumer
sees it (persist-first, `Run`).

The claim is scoped to the trajectory on purpose: one off-trajectory
request exists — `session.sideQuery()` sends its own prompt straight to
the adapter, appends nothing to the log, and is visible only in the
trace. A side query answers; it never acts, and it never becomes history.

A second corollary: the session's MODEL BINDING (adapter + model id +
provider route) is LIVE state on the session, switched atomically by
`setModelBinding` — never a frozen construction-time config. The wire
and the accounting always describe the binding that actually served
the request (the 0.15.0 P0: a /model switch that changed the adapter
but not the wire's model id).

A corollary worth stating once: **the concurrency constraints have three
distinct owners** — and mutual exclusion between writers is never Run's
(Run's own constraint is consumption, not exclusion).

| Constraint | Owner | Anchor |
| --- | --- | --- |
| A run is consumed once | `Run` | `run.ts` (`#started`) |
| One active run per session, in-process | `AgentSession` | `session.ts` (`#activeRuns`) |
| One writer per session, cross-process | `SessionStore` | link lock + CAS (ADR-0050) |

## 1. Product shell — `apps/cli`

The Kiso Coding Agent product. It owns: which commands exist, how modes
and configuration are chosen, how trust is presented to a human, how
runtime events become terminal output (via `tui`/`tui-cells`), and when
the process exits. `tui-cells` is the zero-dependency data-to-bytes layer;
`tui` owns the terminal lifecycle and the compositor (ADR-0046).

It must not decide: anything about the model/tool cycle, event semantics,
or durability. A second host (server, IDE, script) must get the identical
agent semantics by driving the same runtime surface.

## 2. Composition — two homes, on purpose

Composition is split between "what" and "how":

- **What** — the CLI decides which model, store root, tools, extensions,
  and permission policy this invocation uses (`apps/cli/src/index.ts`,
  `builtin.ts`).
- **How** — `createAgent()` binds them: provider resolution (direct
  adapter injection, or a lazy import of a provider package so an unused
  provider costs nothing), tool registry, and the already-loaded extension
  set (`packages/runtime/src/agent.ts`, `compose.ts`). Loading itself is
  the runtime's `loadExtensions` / `loadProjectExtensions`, **called by
  the CLI** — the product decides when and from where to load; the runtime
  owns how a loaded extension composes.

There is no single composition-root file, and the split is the point: the
product owns product choices; the runtime owns wiring. Neither half runs
the loop.

## 3. Agent — definition and factory

`AgentRuntime` (`packages/runtime/src/agent.ts`) holds an
`AgentDefinition` — model, system prompt, tools, store, permission policy,
extensions — and creates sessions from it. That is all it does.

It owns: the reusable definition, and session creation.

It does **not** own: an active run, an abort signal, a message queue, or
any mutable conversational state. In kiso the run owner is `Run` and the
authoritative state is the log. If you arrive expecting a stateful `Agent`
class at the center of the system, the thing you are looking for is
`Run` + the store.

## 4. Session — the durable conversation

`AgentSession` (`packages/runtime/src/session.ts`) owns one `EventLog`
seeded from disk, and:

- the durable-first append of user input, before any loop work;
- the human-in-the-loop surface: `pendingApprovals()`, `approve()`
  (ADR-0029), `uncertainExecutions()` / `resolveUncertain()` (ADR-0038);
- summarization and the context policy (ADR-0044, ADR-0027);
- the **resume entry point** — recovery starts here, but is not
  implemented here (see *Recovery is cross-layer*);
- the in-process one-run-at-a-time constraint (`#activeRuns`).

It must not decide: terminal presentation, provider wire formats, or
whether a write is legal — the store adjudicates that.

## 5. Run — one user turn

`Run` (`packages/runtime/src/run.ts`) is a single **user turn** as an
async iterable of events: one input (or one resume) driven to its
terminal, spanning as many model/tool cycles as the loop needs. It owns:

- the `runId` and the abort;
- once-only consumption;
- **write-ahead persistence**: every event goes to the store before it is
  yielded — what a consumer sees is already on disk;
- driving the kernel loop on the live path, and **interpreting and
  executing the recovery plan** on resume: applying durable decisions,
  appending the abandoned/expired markers, and running recovery-derived
  invocations itself (`#executePersisted`) — always from durable facts,
  never from fresh model intent.

The durable turn commit (ADR-0052) is joint work, not Run's alone: the
kernel emits the boundary events that constitute a commit, Run persists
them, and the recovery plan reads them back — no durable stop means
uncommitted.

Run does not own mutual exclusion (see the table above). On the live path
it does not interpret events — it persists and forwards them; on the
recovery path interpretation of the derived plan is exactly its job.

## 6. Kernel loop — the control core

`loop()` (`packages/core/src/kernel/loop.ts`) is the model↔tool cycle. It
owns: when to call the model, when and how tool calls execute, retry
(ADR-0005), stop conditions, the honest `terminal` (exactly one per run,
truthfully classified), permission pauses (`defer` yields
`permission_requested` and waits for the durable decision), microcompact
(ADR-0027), the execution-event contract (`tool_execution_*`,
ADR-0024/0025), and the **void projection** — the semantics that a
`model_output_abandoned` marker voids draft model output, never framework
facts (ADR-0048). The marker itself has two producers: the loop on the
live path (a turn voided before it committed) and Run on the recovery
path.

It must not decide: disk formats, presentation, provider authentication,
or OS-level sandboxing. On the live path it is the only thing that runs
tools; the one other executor is Run's recovery replay, which executes
only what the durable plan derives.

`core` overall stays a kernel (ADR-0021, superseding ADR-0001 — the
framework grows in packages, the core does not): the frozen event union
(ADR-0003, ADR-0051), the message/tool/extension contracts, projection,
hooks, permissions — with `ajv` as its single runtime dependency
(ADR-0023). Nothing in `core` touches the filesystem, processes, or the
network.

## Store — durability adjudication (adjacent, not below)

`SessionStore` (`packages/runtime/src/store.ts`, `lock-adapter.ts`) is
drawn beside the control chain because it owns a different *kind* of
decision: not "what happens next" but **"who may write the next line, and
is this write legal?"**

It owns: the identity-confirmed link lock and its takeover protocol
(ADR-0050), the expected-last-seq CAS (`StaleWriterError`), torn-tail
repair before every append, and the upgrade contract (quarantine,
ADR-0035).

It must not decide: event semantics, projection, or control flow. It will
refuse an illegal write from any layer above, including Run.

## The boundaries

### Providers — translation, never execution

The contract is `Adapter` (`packages/core/src/protocol/adapter.ts`):
`stream()` returns an async iterable of events — incremental and
interruptible. Authoritative replay belongs to the persisted log, not to
the stream: an adapter's own ordering is a stream-local hint, and `seq`
is assigned by the `EventLog` alone. An adapter may produce exactly the whitelisted
adapter event set (text, tool-call, thinking, usage, stop) and nothing
else; anything outside it is forging kernel state, and the loop enforces
the whitelist **at runtime** with the same per-variant validator the store
trusts (`isAdapterEvent`). One deliberate exception to "nothing
provider-shaped crosses": the `usage` event carries the provider's RAW
counters — the frozen union records observation, and the accounting
TRUTH is derived at the boundary (`usage/canonical.ts`, route-keyed
conventions, model-keyed pricing via the metadata registry, unknown
always null).

Implementations live in `packages/provider-anthropic` /
`provider-openai`, loaded lazily as optional peers. A provider never
decides whether a tool executes and never touches the session.

### Tools — contract vs. effects

The contract, registry, and schema validation live in
`packages/core/src/tools/`. The effects — files, search, edit, shell —
live in `packages/tools-node`. On the live path the kernel is the only
executor (Run's recovery replay is the one other caller of
`tool.execute`, and it executes only durable-plan derivations), and
every execution is bracketed by durable facts: validation and the
permission verdict first, the ledger's STARTED receipt, then the effect,
then the receipt (`tool_execution_*`). No-opinion is never a silent
allow (ADR-0042). First-party tool schemas declare a CLOSED world —
every object node carries `additionalProperties: false`, so a
model-invented parameter is a model-visible `invalid_input` rather than
silently ignored semantics; bridged external (MCP) schemas pass through
verbatim (the closed-world inventory gate,
`tests/tool-schema-closed-world.test.ts`).

### Extensions — contract / composition / capability

Three homes: the contract in `packages/core/src/protocol/extension.ts`;
loading and composition in `packages/runtime` (`extensions.ts`,
`compose.ts` — existing hooks compose first); the official capabilities as
ordinary consumers of the public contract in `extensions/*` (ask, mcp,
skills, subagent, task — ADR-0030). Project-level capability is trusted by
content digest (ADR-0037). An extension runs with process privileges;
loading is a trust decision, not a sandbox.

## Recovery is cross-layer

Recovery is deliberately split, and no single file implements it:

- the **kernel** owns the semantics: what a void marker means for the
  projection — model output voids, framework facts never do (ADR-0048);
- the **runtime** derives the recovery plan from the log
  (`recovery-plan.ts`) — recovery as projection, not as saved state;
- **Run** interprets and executes the plan on resume: it appends the
  abandoned and expired markers, completes interrupted invocations from
  their receipts (never re-executing an observed effect), and executes
  the derived not-yet-run invocations itself;
- **Session** exposes the entry point (`resume()` — the same code path as
  a second run).

Only the last open run is recovered; a run with a terminal is history.
Interrupted side effects land in the uncertainty ledger and wait for a
human verdict (ADR-0038) — an unobserved effect is never silently retried.

## The observation plane (cross-cutting)

These read the system and verify it; they own no semantic decisions:

- **trace** (`packages/runtime/src/trace/`) — per-request byte
  accounting, the rent manifest, the request-surface guard;
- **usage** (`usage/canonical.ts`) — the canonical accounting schema;
- **evals** (`packages/evals`) — the faux adapter, incident fixtures,
  governance checks;
- **bench** (`bench/`) — the reproducible cost/behavior experiments and
  their methodology.

"Cross-cutting" does not mean "outside the call path": the tracer
physically wraps the adapter stream (`traceGuard`), so requests flow
*through* it. What the plane may never own is a decision — it measures
bytes and records manifests; it never alters a verdict, a projection, or
an event. (One pragmatic seam is acknowledged: the CLI's keyless mode
currently reaches the faux adapter through `evals` — known, tracked for a
dedicated round.)

## Four flows, kept apart

**Control** — who decides the next step:

```text
CLI -> Agent -> Session -> Run -> loop
```

**Data** — a cycle, not a line (every model call is a pure projection of
the log):

```text
EventLog -> projection -> model -> adapter events -> EventLog
```

**Effect** — when the real world changes:

```text
tool_call -> validation + permission verdict -> STARTED receipt
          -> execute -> execution receipt
```

**Persistence** — begins *before* the loop and ends *before* the UI:

```text
session.run(input): user_input durable-first
   -> loop events -> Run write-ahead -> store -> only then any consumer
```

Keeping these apart dissolves the usual confusions: rendered text is
already persisted (not "will be"); a proposed tool call is not an effect;
a committed line is not necessarily committed *conversation* (durable
observation ≠ committed history).

## What kiso deliberately does not have

Stated plainly, so the map cannot be read as larger than the territory:

- **No session tree.** The log is linear — no fork, no branches, no leaf
  navigation.
- **No remote stack.** No wire protocol, client, server, or remote
  backend. Sessions are local-filesystem-backed with a single writer per
  session at a time — cross-process lock takeover and resume are fully
  supported (ADR-0050); remote transport is not.
- **No mid-stream steering, no durable queue.** The RUNTIME has no
  stream injection and no queued-input state class: input lands
  between runs. The product shell composes both experiences from that
  primitive — the CLI's redirect (KC2) is abort + the text as the
  next turn, and its pending-turn queue (W22) is ephemeral process
  state whose lines only ever become ordinary `user_input` events.
- **No second in-memory authority.** By design — see *State doctrine*.
- **No OS sandbox.** Tools and extensions run with process privileges;
  isolation belongs to the host.

What kiso does carry, and treats as its center of gravity, is the durable
execution slice: crash-consistent runs, the execution ledger — exactly-once
within the framework-controlled window, with the uncertain crash window
handed honestly to the ledger and a human verdict rather than papered
over — and recovery as projection. The rest of the list above is roadmap
territory only if evidence ever demands it.

## Reading path

1. `packages/runtime/src/agent.ts` — `createAgent`, the definition;
2. `packages/runtime/src/session.ts` — the durable session;
3. `packages/runtime/src/run.ts` — write-ahead and recovery driving;
4. `packages/core/src/kernel/loop.ts` — the control core;
5. `packages/runtime/src/store.ts` — the durability adjudicator;
6. `packages/core/src/protocol/adapter.ts` — the provider boundary.

Companions: `docs/concepts.md` (the invariants), `docs/sdk.md` (the
public surface), `docs/adrs/` (the decision record).
