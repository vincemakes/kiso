# Reliable Session Alpha — design & implementation plan

> Date: 2026-08-03
> Status: approved — implementation starts immediately after this commit
> Authority: direction ruling 2026-08-03 (user): kiso is a complete, growable,
> out-of-the-box TS agent framework. The 1,152 lines shipped so far are the
> core prototype, not the product. API is not frozen; this slice may reshape it.

## 1. Goal

The first real vertical slice. An end user must be able to:

1. install the compiled kiso packages;
2. create an agent in ~20 lines of code;
3. hold a real multi-turn conversation in a CLI;
4. use file, search, edit, and shell coding tools;
5. get approvals for dangerous tools;
6. pause at the approval point;
7. exit the process, restart, and resume the session;
8. be guaranteed that side effects already confirmed successful never run twice;
9. inspect a replayable, auditable trajectory of the whole run.

First reference product: a **coding-agent CLI** that dogfoods the framework.
The framework stays generic; the CLI is its consumer.

## 2. Baseline (recorded before starting)

- git: 11 commits, clean (except the docs redefinition in this commit).
- `npm run check`: 43/43 tests green, typecheck clean, size gate 1,152/2,000.
- `npm pack --dry-run`: tarball contains raw `src/*.ts` only — no compiled JS,
  no `.d.ts`, `exports` point at TypeScript. A normal Node project cannot
  import it without tsx. **That is the Phase A problem.**
- No git remote, no CI. CI is implemented as scripts (`npm run check` +
  `scripts/smoke.mjs`), ready to wire into GitHub Actions later.

## 3. Target structure (npm workspaces)

```
kiso/
├── package.json               private root; workspace scripts only
├── packages/
│   ├── core/                  @kiso/core — protocol, event log, loop, hooks,
│   │                          modes, permissions, compaction, delivery truth
│   ├── runtime/               @kiso/runtime — AgentDefinition/AgentRuntime/
│   │                          AgentSession/Run, JSONL SessionStore, reducer,
│   │                          durable approvals, recovery guards
│   ├── provider-anthropic/    @kiso/provider-anthropic — Anthropic adapter
│   ├── provider-openai/       @kiso/provider-openai — OpenAI-compat adapter
│   ├── tools-node/            @kiso/tools-node — read/list/search/write/edit/shell
│   └── evals/                 @kiso/evals — faux provider, incident fixtures,
│                              contract + matrix tests
├── apps/
│   └── cli/                   @kiso/cli — coding-agent reference product
├── docs/plans/                this plan
└── adrs/                      ADR trail (0001-0005, 0020-0022)
```

Merges allowed only when a package has no independent publish value yet —
but the source boundary must stay visible; no central-hub file may re-form
(ADR-0021 red line #10).

## 4. Key designs

### 4.1 Build: plain tsc, Node ESM

Keep the existing toolchain (tsc, vitest, tsx, npm). `moduleResolution:
NodeNext`, imports carry `.js` suffixes, each package emits `dist/*.js` +
`.d.ts`. Exports point at `dist` — never at source. Root `check` = build
(in topo order) → typecheck → tests → size gate (core only) → pack dry-run →
consumer smoke (clean temp project, install tarballs, import, run a faux
session).

### 4.2 Durability: events are the truth, write-ahead

`SessionStore` is an append-only JSONL file per session. Every event is
written + fsync'd BEFORE it is published to the consumer (write-ahead). The
`EventLog`'s `seq` continues across process restarts: restore reads the
JSONL and replays `seq 0..N`; the next append continues at `N+1`. Run
boundaries are records in the same log (`runId` on the line envelope, events
stay pure — ADR-0003 union untouched).

### 4.3 Reducer: state is a pure projection

The loop currently keeps a parallel `messages` array (loop.ts). Phase B
replaces it: adapter input is projected from the EventLog by a pure
`projectMessages(events)` — the reducer — so there is exactly one truth and
the projection is testable in isolation. The runtime's richer state
(approvals, tool execution ledger) is the same pattern at a higher layer:
given a JSONL, rebuild everything.

### 4.4 Terminals: explicit, unique, honest

- provider stop reason is never unconditionally `completed`: `max_tokens`
  → `{kind:"max_tokens"}`, `tool_use`/`end_turn` → `completed`, abort →
  `aborted`, provider error → `error` (ADR-0004 union gains the `max_tokens`
  variant; compiler finds every consumer).
- retry only when nothing of the turn has been emitted: once any event
  (text delta, tool call) left the adapter, a failure is surfaced as an
  `error` terminal, never a silent re-stream that duplicates text or tool
  calls.

### 4.5 HITL: defer is a real pause, not a deny

```
tool requested → permission_requested (persisted)
→ run paused (event yielded, pending decision id)
→ approve(id) / deny(id) persisted → same run resumes at the same seq
```
Approval requests are durable records in the JSONL; resume of a paused run
re-presents unanswered requests. `onPause` hook fires; the loop awaits the
decision inside the same run frame (no fake denial fed to the model).

### 4.6 Exactly-once side effects

Every tool execution writes its lifecycle to the log BEFORE and AFTER the
side effect: `tool_execution_started` → `tool_execution_succeeded` /
`tool_execution_failed`. On restore, a tool whose record shows `started`
with no result is **uncertain**: it blocks and requires an explicit human
decision (rerun or mark failed) — it is never auto-rerun. A tool confirmed
`tool_execution_succeeded` is never executed again after restore. Abort
propagates: adapter signal → tool `ctx.signal` (current) → recorded for
future sub-agents.

### 4.7 Tool args: real JSON Schema validation

`Tool.parameters` is JSON Schema (draft-07). Validation today is only
advertised, not performed (tool.ts:45). Phase B makes it real: one runtime
dependency (`ajv`) added to core, validated before `execute`, failure =
`invalid_input` tool result (never a thrown handler). ADR records the
dependency decision.

## 5. Phases

Each phase: failing tests first where behavior is being changed (B-D),
full check, one commit, then continue automatically.

| Phase | Deliverable | Commit |
|---|---|---|
| 0 | This plan + ADR-0022 | `docs: redefine kiso as a framework built on a small core` |
| A | Workspace monorepo; core moves to packages/core; build emits ESM+d.ts; exports → dist; check pipeline + consumer smoke; README fixed | `build: convert kiso into a publishable workspace` |
| B | Event-log projection replaces parallel messages; honest terminals (max_tokens etc.); no retry after partial emission; adapter cancellation; openai-compat system prompt; ajv schema validation; 43 tests + 6 fixtures migrated | `fix(core): harden event, terminal, retry, and adapter semantics` |
| C | createAgent / AgentRuntime / AgentSession / Run+runId; JSONL SessionStore; multi-turn; list/load/resume; write-ahead publish; reducer rebuild; restart recovery | `feat(runtime): add durable multi-turn agent sessions` |
| D | Durable approvals with real pause/resume; execution lifecycle events; uncertain blocking; no re-run of confirmed tools; abort fan-out | `feat(runtime): add durable approvals and exactly-once recovery guards` |
| E | `kiso chat|resume|sessions`; read/list/search/write/edit/shell tools; approvals; streaming; faux + real provider modes | `feat(cli): ship the persistent coding-agent vertical slice` |

## 6. Acceptance (all must hold)

- clean project installs packed tarballs and runs without tsx;
- TS consumers get correct types;
- two-turn conversation restores across processes;
- approval pause resumes;
- successful tools never re-run;
- uncertain side effects block with a clear prompt;
- anthropic + openai-compat system-prompt / abort / tool-call contract tests pass;
- all 6 incident fixtures run against the real runtime/session;
- build, full typecheck, tests, pack, consumer smoke all green;
- the README example executes successfully in a clean environment;
- git workspace clean.

## 7. Boundaries (this round)

No npm publish, no tag, no push. No oohki/uooki/mauri/pi/CC changes (read-only
reference). No Web UI/TUI. No memory/RAG/scheduler/workflow. No "continuous
learning" claims. No empty packages waiting for consumers. The 2,000-line
gate constrains only `packages/core`.
