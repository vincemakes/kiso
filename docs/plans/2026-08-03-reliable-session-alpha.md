Translated from the original Chinese round record (2026-08-06)

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
│   ├── core/                  @vincemakes/kiso-core — protocol, event log, loop, hooks,
│   │                          modes, permissions, compaction, delivery truth
│   ├── runtime/               @vincemakes/kiso-runtime — AgentDefinition/AgentRuntime/
│   │                          AgentSession/Run, JSONL SessionStore, reducer,
│   │                          durable approvals, recovery guards
│   ├── provider-anthropic/    @vincemakes/kiso-provider-anthropic — Anthropic adapter
│   ├── provider-openai/       @vincemakes/kiso-provider-openai — OpenAI-compat adapter
│   ├── tools-node/            @vincemakes/kiso-tools-node — read/list/search/write/edit/shell
│   └── evals/                 @vincemakes/kiso-evals — faux provider, incident fixtures,
│                              contract + matrix tests
├── apps/
│   └── cli/                   @vincemakes/kiso-cli — coding-agent reference product
├── docs/plans/                this plan
└── docs/adrs/                ADR trail (0001-0005, 0020-0022)
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

## 6a. Hardening round (2026-08-03, Areas 1-7 — all delivered)

The first pass met the acceptance but not the failure paths. The hardening
round made the claims true under adversarial conditions; see ADR-0025 for
the decision record:

- **Storage** (Area 1): torn-tail repair under the writer lock, strict
  load (mid-file corruption / invalid records / seq gaps throw), O_EXCL
  cross-process single-writer locks, one active run per session, EventLog
  seq validation, fd/lock/dir lifecycle.
- **Cross-process continuation** (Area 2): `session.resume()` is a durable
  state machine — approvals are applied (the ORIGINAL call executes once,
  denials write their result), receipts are filled, and the original run
  completes; the CLI uses resume, never a fake new prompt.
- **Execution identity** (Area 3): framework `executionId` replaces the
  (name, input) guard; non-idempotent failures are uncertain until a human
  decides (rerun/abandon); only safe-to-retry tools get clean failures.
- **Abort** (Area 4): one signal reaches backoff, approval waits, every
  pending tool, and the SDK; shell kills its process tree.
- **Workspace safety** (Area 5): tools bound to a canonical workspaceRoot;
  absolute paths, `..`, and symlink escapes are refused; approval UI shows
  security-critical parameters in full.
- **Honest terminals** (Area 6): lossless projection; missing/duplicate
  stops and tool_use-without-a-call are error terminals; provider stop
  reasons map exhaustively; usage is never faked.
- **CLI/CI/release** (Area 7): resume argv fixed; demo has real multi-turn
  context; CI is clean-checkout `npm ci` + full check; three isolated
  consumer smoke tiers; the CLI is publishable.

## 6c. Third hardening round (2026-08-03, i-ix — all delivered)

- **Event/persistence ownership** (i): a rejected disk write (stale
  handle / corruption) POISONS the session permanently — the in-memory log
  can never keep accumulating seqs and "catch up" to the disk; every
  persist site routes through the session, every appended event is
  yielded exactly once (no hidden appends).
- **Framing & lock races** (ii): a line WITHOUT a trailing newline is never
  committed — load and append's torn-tail repair agree; stale-lock
  takeover is IDENTITY-CONFIRMED (rename away, verify token+pid, restore
  and retry on mismatch) — a live lock is never deleted; two-contender
  tests run as REAL concurrent processes behind a barrier.
- **User rewrite/veto** (iii): `user_input_replaced` is a normal gapless
  stream event; rewritten content is the only content every later turn
  sees; the hook's `source` survives; a true veto ends the run without
  ever calling the provider — verified through the raw loop, a real
  AgentSession, and a disk reload.
- **Execution identity** (iv): executionId is the ONLY recovery key —
  receipt/resolution/failure pairing never uses the repeatable provider
  callId; a fresh success is never polluted by a historical same-callId
  failure; resolutions belong to the ORIGINAL runId (the fake
  "resolution" runId is gone); a failed non-idempotent execution after a
  cross-process approval enters a durable uncertain pause; new runs are
  REFUSED while an open run lingers (resume is the only way past it).
- **Schema, turn gate, compaction** (v): every persisted variant is
  deep-validated (enums, Terminal members, Usage known/token combos,
  ContentBlocks, plain-object inputs, optional fields); `user_input_replaced`
  carries ContentBlock[]; ANY event after the provider's stop is a
  protocol error and tools never execute; compaction is keyed by the
  replaced tool-result EVENT SEQ and records only the delta; live tool
  results keep tags on both paths.
- **Provider content/usage** (vi): OpenAI base64 images become real data
  URLs; tool-result images convert to an explicit text note; a tool call
  keeps ONE identity from start to end even when its id arrives late;
  cached tokens are read for real (absent = null, never 0); every
  Anthropic stop path emits an honest usage first.
- **Consumer installs** (vii): the provider packages OWN their SDKs and
  export config-driven factories; the runtime imports only the provider
  packages; smoke tier D installs all seven tarballs with
  `--install-strategy=nested` and starts the CLI with real
  Anthropic/OpenAI env — no ERR_MODULE_NOT_FOUND on either path.
- **Tools/CLI failure paths** (viii): shell kills the whole tree including
  setsid()-escaped descendants and confirms their exit; write/edit
  preserve modes and never leak `.kiso-tmp-*`; read_file enforces the
  inode-boundary policy (external hard links and non-regular files
  refused); every terminal path escapes ESC/C0/C1/CR/backspace/bidi;
  approvals show the canonical path and the full content; Ctrl+C cancels
  the run AND a pending question; the startup resume is SIGINT-bound;
  "you> " re-arms after every turn; an exhausted faux script exits
  non-zero.
- **Release truth** (ix): trailing whitespace and EOF-newline checks are a
  gate (`scripts/whitespace-check.mjs` + `git diff --check` in `check`);
  README numbers match the real size gate (1,636/2,000) and test count
  (250); the smoke header matches the five tiers.


## 6d. Fourth hardening round (2026-08-03, i-xii — all delivered)

- **Workspace hardlink boundary** (i): the inode-boundary verification is
  STRUCTURAL — `find -print0` with NUL-separated output, every match
  re-statted and checked for the exact dev+ino pair, -xdev bounded, and
  fail-closed on any unverifiable link: a hard link named "inside\nspoof"
  can no longer fool the count, and read_file and search_text share the
  policy.
- **Permanent poison** (ii): ANY rejected disk write poisons the session —
  not only the typed stale/corruption errors (a live external writer's
  lock error is the realistic case); the run iterator re-checks health
  when it STARTS, and approve/resolveUncertain refuse a poisoned session;
  runs pre-constructed before the poison all fail on consumption and
  nothing of their context ever lands.
- **Kernel single-writer lock** (iii): the O_EXCL pidfile + rename-away
  scheme is GONE. The lock is an EXCLUSIVE kernel flock held by a
  dedicated helper process (fcntl.flock via python3, macOS + Linux): the
  kernel arbitrates every race, there is nothing to delete or overwrite,
  legacy live-PID lock files are refused (JSON.parse("123") is a bare pid,
  never an object without one), empty/half-written locks are harmless,
  close/closeAll release only this instance's helper, and a
  three-process barrier race has exactly one writer.
- **Old-session upgrade** (iv): v1 compacted records ({callId, content})
  remain legal — the projection replays them with v1 semantics and v2
  eventSeq records with exact replacement; a schema audit found no other
  record the old framework could legally have written.
- **Adapter trust boundary** (v): a narrowed AdapterEvent type plus a
  runtime whitelist — a kernel-owned event from the stream (terminal,
  tool_execution_*, permission_*, user_input, ...) is a forgery: never
  persisted, exactly one invalid_request terminal, tools never execute.
- **Rewrite/veto exactly-once** (vi): the hook runs AT MOST ONCE per
  input (a durable replacement blocks re-invocation on resume); the
  projection renders the FINAL replacement at the input's own position;
  a persisted veto never re-runs the hook or the provider.
- **Uncertainty flow** (vii): with a live resolver, resolveUncertain only
  passes the verdict — the loop/recovery generator appends, yields, and
  persists tool_execution_resolved, so the yielded stream and the
  durable seqs are IDENTICAL (no hidden 6 → 8 gap); offline verdicts
  persist directly; an abort records no resolution and the execution
  stays uncertain.
- **Receipt tags** (viii): tool_execution_succeeded/failed carry the result
  tags on the durable receipt; crash-window repair reproduces the
  normal-path tool_result losslessly.
- **Provider boundaries** (ix): Anthropic distinguishes usage-SEEN from
  usage-YIELDED (a message_start with usage then a bare stop yields an
  honest KNOWN usage); OpenAI adopts the first non-empty tool-call id
  forever and a different later id is a structured error; schema counts
  are safe integers, known usage reports at least one token, image
  payloads are strictly exclusive, errorKind is forbidden on non-errors.
- **CLI cancellation** (x): a CANCELLED sentinel (never the empty
  string) — a cancelled question does not swallow the next input (it is
  re-emitted as a fresh turn); Ctrl+C on an uncertain question records
  no verdict; approval cancellation is a printed conservative denial;
  faux exhaustion is a controlled exception (agent.close() always runs,
  exitCode instead of process.exit); top-level errors are escaped; the
  approval UI and the tools share one canonicalTargetPath resolution.
- **Shell termination** (xi): the root is SIGSTOPped first, descendants
  are discovered and frozen until the set is STABLE, then killed and
  polled to death; if any tracked pid survives the deadline the verdict
  is an explicit UNCERTAIN error naming the survivors — never a claimed
  "aborted" while a tracked pid lives.
- **Release truth** (xii): the CLI bin path is published as-is (no
  auto-clean warning), the smoke header names all FIVE tiers, nested
  provider smoke claims only install/resolution/construction, and README
  numbers match the real size gate (1,714/2,000) and test count (294).


## 6e. Fifth hardening round (2026-08-03, i-xii — all delivered)

- **Store lifecycle** (P1-1/2/3): the WHOLE append critical section is
  serialized per session and a rejected write propagates to every append
  queued behind it; the lock is held only while the helper PROCESS lives
  (dead helper detected, re-acquire or honest failure); close() is a
  lifecycle barrier — in-flight appends fail and no helper survives.
- **Upgrade contract** (P1-4): the pidfile guard for old-format writers is
  a best-effort refusal, NOT a seamless rolling upgrade — the documented
  contract is QUARANTINE (stop every old-format process, then start the
  new version).
- **Verdict durability** (P1-5/6): approve()/resolveUncertain() submit the
  verdict and the Run's finally FLUSHES it to disk if the generator never
  persists it (an abandoned generator cannot lose a verdict); the
  recovery abort path records a same-tick verdict with its callId.
- **Veto** (P1-7): a durable null replacement restores the vetoed flag —
  the provider is never called on resume, even with prior history.
- **Trust gate** (P1-8): isAdapterEvent validates STRUCTURE via the same
  per-variant validator the store uses — illegal fields are forgeries,
  never persisted.
- **ToolResult** (P1-9): a discriminated union — isError:false cannot
  carry errorKind (type-pinned by @ts-expect-error) and the emit sites
  runtime-guard it too.
- **Provider** (P1-10): the first OpenAI finish reason is FINAL — later
  content is ignored; late usage chunks are still honored.
- **CLI** (P1-11): the persistent line listener is installed BEFORE the
  startup recovery with a queue — a cancelled question's re-emitted line
  becomes the next turn (verified on a REAL PTY).
- **P2**: missing python3 is an honest locking-unavailable error; kiso
  resume's Ctrl+C exits cleanly without starting the recovery; the inode
  scan canonicalizes a symlinked workspaceRoot; README numbers are the
  measured ones (1,747/2,000, 320 tests); the shell tests use
  per-test-unique markers and run concurrently without cross-talk.

## 7. Boundaries (this round)

No npm publish, no tag, no push. No oohki/uooki/mauri/pi/CC changes (read-only
reference). No Web UI/TUI. No memory/RAG/scheduler/workflow. No "continuous
learning" claims. No empty packages waiting for consumers. The 2,000-line
gate constrains only `packages/core`.

## 6b. Second hardening round (2026-08-03, Areas A-F — all delivered)

- **Storage identity** (A): lock owner tokens (foreign-close safe), id
  validation before ANY file side effect, expected-last-seq CAS (stale
  handles refused), torn-tail repair before EVERY append, closeAll
  completeness, full per-variant event schema validation.
- **Per-run recovery** (B): run boundaries rebuilt from StoreRecord.runId;
  only the LAST unterminated run recovers; terminated runs' dangling
  approvals are closed (permission_expired) and late approve() cannot
  resurrect; resolveUncertain is executionId-keyed, idempotent,
  irreversible.
- **Execution gate** (C): no tool runs unless the turn is well-formed
  (exactly one compatible stop); onPreTool is cancelable; failed
  non-idempotent executions pause as uncertain_pending until a human
  decides (no siblings, no auto-retry); onUserMessage veto/rewrite are
  persisted as the only fact later turns see.
- **Projection/providers** (D): tool results carry full blocks; explicit
  assistant boundaries; absent/unknown stops are errors; 500-599
  retryable; connection errors recognized; real usage (OpenAI
  include_usage, Anthropic cache counters); compacted applies persisted
  replacements verbatim.
- **Tools/CLI safety** (E): pre-aborted shell never spawns; listener
  cleanup; safe replacement (external hard links survive); terminal
  escaping (ESC/C0/C1/CR/backspace/bidi); CLI closes all locks on exit;
  SIGINT binds to the resumed run.
- **Release truth** (F): CLI provider resolution via the runtime (no
  direct SDK imports); nested-install smoke tier; two-turn faux chat;
  Node >= 22 engines; README + LICENSE in every tarball; README claims
  match reality.
