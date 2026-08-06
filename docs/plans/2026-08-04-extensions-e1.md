Translated from the original Chinese round record (2026-08-06)

# Extensions E1 — the approval-policy extension system

> Date: 2026-08-04
> Status: complete — spec sections 1-7 delivered, acceptance gate green
> Authority: direction ruling 2026-08-04 (user): the E1 spec. Extensions
> carry approval policies, tools, and hooks; the CLI scans a directory at
> startup; the whole story is proven end to end through the CLI's topmost
> entry with a real kill -9.

## 1. Goal

An extension is a plain `.mjs` file — no SDK, no build step. Its approval
policies run BEFORE the human flow (deny > ask > allow), its allow/deny
verdicts are PERSISTED FACTS recorded with `decidedBy`, and a kill -9 never
re-asks an already-decided call nor re-runs the policy. Tools merge into
the registry; hooks compose after the harness's own.

## 2. Non-goals (violations counted as scope creep)

- No registerCommand / shortcuts / renderers / sendMessage-like APIs.
- No project-level extensions; no MCP; no subagents.
- No compaction parameter surface (that is E2).
- No new npm dependencies; the core 2,000-line cap is immutable (176 lines
  of headroom at ruling time; 95 at completion).

## 3. Baseline (recorded before starting)

- core: 1,824/2,000 lines (176 headroom) — the whole E1 core surface had to
  fit inside (ended at 1,905/2,000).
- cli: 699/1,200 lines (ended at 713).
- 355 tests green (ended at 372).

## 4. Delivery areas (with the evidence discipline: commit + file:line + test + red→green)

### a. core — protocol/extension.ts (pure types), decidedBy, the policy chain

- `packages/core/src/protocol/extension.ts` — `KisoExtension{name,
  hooks?, tools?, approvals?}`, `PolicyVerdict{allow|deny+reason|ask}`,
  `ApprovalPolicy.decide(call, ctx)` — types only, no runtime.
- `packages/core/src/protocol/events.ts:286-297` — `permission_decided`
  gains optional `decidedBy?: string` (absent = human; old logs compatible);
  deep validation at `events.ts:693-698`.
- `packages/core/src/kernel/loop.ts:703-767` — the policy chain in
  `executeOne`, before the human flow: any deny wins (the FIRST denial's
  reason), else any ask falls into the existing flow, all allow
  auto-approves — recorded durably with `decidedBy`, never a human pause; a
  throwing policy counts as ask; ask with no flow configured degrades to an
  honest denial. The durable check (`loop.ts:715-725`) keys on the SAME
  logical call — callId + identical input + decidedBy set — so a re-issued
  call with different arguments is a new call and re-decided (homologous to
  alreadyReplaced: the persisted fact speaks for the call).
- Tests `packages/core/tests/extensions.test.ts` (7) — red first:
  `expected [] to have a length of 1 but got +0` → green after the chain
  landed: ① deny outranks ask and allow (first reason, decidedBy, no pause)
  — `deny outranks ask and allow — the FIRST denial's reason, decidedBy
  recorded, no human pause`; ② ask outranks allow (human flow, no decidedBy)
  — `ask outranks allow — the existing human flow pauses, decided WITHOUT
  decidedBy`; ③ all allow (auto-approve, hook never ran) — `all allow —
  auto-approved with the extension's name, never a human pause`; ④ throw =
  ask — `a policy that throws counts as ask — the human flow decides`; ⑤
  ask with no flow = honest denial — `ask with no approval flow configured
  degrades to an honest denial`; ⑥⑦ resume durability with a decide-call
  counter — `a durable APPROVAL executes the call with the policy called
  ZERO times` / `a durable DENIAL emits the denial result with the policy
  called ZERO times`. Deep validation synced at
  `packages/core/tests/event-schema.test.ts` (decidedBy accepted / rejected).

### b. runtime — loadExtensions + AgentSession integration

- `packages/runtime/src/extensions.ts:19-48` — `loadExtensions(dir)`: native
  `import()` of every *.mjs default export (or factory); absent dir = [];
  a bad file or a duplicate name throws with the file name(s) — loud
  startup failure.
- `packages/runtime/src/agent.ts:57-62` — `AgentDefinition.extensions`:
  tools merge into the registry at agent creation — a built-in name
  collision is a loud startup error.
- `packages/runtime/src/session.ts:114-131` — `SessionConfig.extensions`:
  tools join the registry idempotently; hooks compose AFTER the existing
  ones (`composeHooks`, `session.ts:992-1058` — the existing hooks go
  first: observers all run; onUserMessage is a PIPE with veto
  short-circuit (re-reviewed in E1-P2: each handler sees the message the
  previous one left, a null veto ends the chain immediately — a later
  rewrite can never swallow an earlier veto, so adding an extension never
  makes the chain MORE permissive; single handler preserved); onPreTool
  first-decisive-wins; onPostTool folds); approvals enter the loop's policy
  chain (`session.ts:546-549`).
- Tests `packages/runtime/tests/extensions.test.ts` (9) — red first (9
  failures) → green: loader (absent dir, sorted load, factory, bad file,
  syntax error, duplicate name), tools merge + collision, hooks composition
  order (`extension hooks compose AFTER the agent's own (existing-first)`),
  approvals → chain with decidedBy.

### c. CLI — startup scan + banner + the e2e gate

- `apps/cli/src/index.ts:53-61` — `extensionsDir()`: KISO_EXTENSIONS_DIR
  override, default `~/.kiso/extensions`; scan in `makeAgent`
  (`index.ts:155-157`) — a broken extension fails the process loudly; the
  banner (`index.ts:62-71`) prints `[N extensions: name, ...]`.
- `examples/extensions/safe-defaults.mjs` — the reference extension: allow
  read/list/search, deny `\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf`
  shell commands with a reason, ask the rest.
- E2E `apps/cli/tests/extensions-e2e.test.ts` — real PTY, real processes,
  real SIGKILL through the CLI's topmost entry (red→green: the extension
  surface was absent, so the driver's needles never appeared). Phase 1: the
  read is auto-allowed (`read_file needs approval` never appears), the
  write IS asked (y injected), the destructive shell is denied (`[Permission
  denied]` reaches the model), and the process is SIGKILLed while a SECOND
  write's pause is pending (a pause is a stable kill point). Phase 2: a
  fresh process resumes — exactly the ONE undecided request is re-presented
  (`(out2.match(/approve write_file/g)).length === 1`), the already-decided
  calls are never re-asked, no uncertain executions, the trajectory
  completes (`done`), both writes landed, and the extension's marker file
  (one line per decide() call, across processes) proves the policy never
  re-runs after the kill.

## 5. Acceptance

1. Core single-turn tests: composition order (deny>ask>allow, ask>allow,
   all allow), throw=ask, decidedBy persisted, resume durability with a
   decide-call counter = 0.
2. Runtime tests: loader loud failure, duplicate failure, tools merge,
   hooks composition order.
3. CLI e2e through the topmost entry with a real kill -9: read auto-allows,
   dangerous shell denied, write still asked; resume never re-asks the
   decided and the policy never re-runs (marker proof).
4. `npm run check` all green — byte discipline / microcompact / kill -9
   gates unregressed (372 tests, core 1,905/2,000, cli 713/1,200).
5. Commit discipline: small commits, English messages; push allowed after
   green; no npm publish (release is the user's decision).

## 6. E2 (2026-08-04, wrap-up) — the remaining extension surfaces

- **compaction parameter surface** — landed by bootstrap #4 (dogfood),
  commit `2d8e5eb`: `KisoExtension.compaction?: { thresholdTokens?,
  keepResults? }` supplies the loop's microcompact params when the session
  sets none (`packages/runtime/src/session.ts` `microcompactFor`).
- **systemPrompt append surface** — this round: `KisoExtension.
  systemPrompt?: { append: string }` (`packages/core/src/protocol/
  extension.ts:50-56`) — append-only, never replace (monotonicity: adding
  an extension never removes existing guidance). The session's own prompt
  comes first, then each extension's append in load order,

-joined —
  deterministic (same extensions → same prompt), no appends → byte-
  identical to the extension-less run (`packages/runtime/src/session.ts:996-1002` `composeSystemPrompt`, wired at `session.ts:539-540`).
- Tests `packages/runtime/tests/extensions.test.ts` (red→green, E2-1/E2-2
  failed `"BASE PROMPT"` vs the appended prompt → 17/17): ① `E2-1: a single
  extension's append lands at the END — the session's own prompt FIRST`
  (`BASE PROMPT

EXT APPEND`); ② `E2-2: two extensions join in LOAD
  order, \n\n-separated`; ③ `E2-3: no appends — byte-identical to the
  extension-less prompt`. The "topmost entry" acceptance lands at the
  runtime layer (a real AgentSession + a faux adapter capturing the
  request) — the system prompt is invisible in CLI output, so the CLI e2e
  has nothing to assert; this is the spec's stated deviation, not a missed
  test.
- `npm run check` all green (376+3 tests; core 1,907/2,000, cli 713/1,200).

## 7. Ruling A (2026-08-04) — the E1 ask-semantics correction (the only permitted core diff)

**Conflict**: ③ the MCP bridge's e2e requires an approval question (the
ask tier) for mcp__ tools, but the ask path E1 landed routes into
`hooks.onPreTool` — the CLI's static automatic policy (`PERMISSION_POLICY`
default-denies tools without rules) answered for the human; the model
received a denial, no question appeared; under the four-package zero-diff
clause no configuration surface could change that.

**Three options**: A) one core change routes the ask path straight to the
human pause (permission_requested + resolveApproval), bypassing the hook;
B) zero kernel changes, the e2e's assertion changes to "not auto-approved"
(the human never sees external tools — "must be reviewed by a human"
fails); C) the CLI default changes deny→defer (a product-level security
behavior change).

**Ruling: A** — characterized as correcting E1's ask semantics, not an
exception carved out for MCP: ask means "a human must decide"; routing
into onPreTool let the static automatic policy answer for the human — the
semantic error was E1's.

**Landing** (`packages/core/src/kernel/loop.ts`, the one and only
permitted core diff; runtime/cli/tools-node zero changes):
- the ask branch goes straight to the human pause (`awaitHumanApproval`,
  the former defer-pause mechanism extracted into a shared helper):
  `loop.ts:769-787`; the hook gate becomes `chainVerdict === undefined`
  (the ask was already resolved by the human pause; the static hook no
  longer speaks and never pauses a second time): `loop.ts:789-808`.
- the "ask with no human flow = honest denial" criterion moves from
  hooks.onPreTool to resolveApproval.
- regressions pinned: with no extensions, unknown tools are still
  default-denied by the CLI's static policy (`packages/runtime/tests/
  extensions.test.ts` — `the CLI's static default deny for unknown tools
  is untouched — denial, never a pause`); ask + a hook present but no
  channel → honest denial, the hook called ZERO times (`packages/core/
  tests/extensions.test.ts` — `Ruling A: ask with a hook but NO approval
  channel still degrades — the static hook never speaks for an ask`).
- E1's existing tests checked one by one: all hold under the new routing,
  zero changes ("ask outranks allow — the existing human flow pauses,
  decided WITHOUT decidedBy" etc.; mid-implementation a double pause
  appeared (d-3+d-5) — an implementation bug where a passed ask fell into
  the hook block and paused again, fixed via the hook gate, not a test
  change).
- with no extensions, all behavior is byte-for-byte unchanged (regression
  tests + the full suite: 136 core / 122 runtime / 32 cli all green).

## ③ MCP bridge (2026-08-04) — official extension, zero kernel changes

- New workspace `extensions/mcp` (private, not published to npm):
  `@modelcontextprotocol/sdk` runtime dependency + esbuild devDep;
  `npm run build` produces the self-contained single file
  `dist/kiso-mcp.mjs` (SDK inlined; a `createRequire` banner solves
  cross-spawn's CJS dynamic require). core/runtime/cli/tools-node — zero
  changes in all four packages (the only core diff beyond Ruling A is
  Ruling A itself); the E1 loader is untouched.
- Behavior: the factory reads `${KISO_MCP_CONFIG:-~/.kiso/mcp.json}`;
  stdio/url dual transports (SDK 1.30, headers via requestInit); a failed
  connection = soft failure, errors aggregated into `mcp__status` (a
  zero-arg tool; connection state is runtime information and the CLI has
  no new UI for it — the tool presents it itself); tool mapping
  `mcp__<server>__<tool>` (description as-is, parameters as-is, text
  passes through / other blocks become an explicit
  `[MCP <type> content: <mimeType|kind>]` text line, isError→isError,
  callTool exceptions → isError + errorKind:"fatal"); ctx.signal → the
  callTool signal + CALL_TIMEOUT_MS=60s; stdio env strips provider
  credentials (copying the tools-node #7 list, noted to stay in sync)
  then layers the config env on top (explicit wins).
- Tests: an in-repo fake MCP server (`tests/fake-server.mjs`, McpServer +
  stdio, four tools: echo/env_probe/fail/slow; note: SDK 1.30's
  registerTool wants a Zod raw shape — JSON schema is rejected); 9 unit
  tests (① schema as-is ② echo round-trip ③ fail→isError ④ stripping +
  env layering ⑤ bad JSON / structurally invalid throws ⑥ absent config
  → only mcp__status ⑦ an unreachable server soft-fails, the rest usable
  ⑧ slow + immediate abort → timely isError + ⑤b) — red→green: the first
  run had 6 failures (connect crashed; root cause: the Server class lacks
  registerTool — it needs McpServer + the Zod shape), 9/9 after the fix;
  1 CLI e2e (a real process through the topmost entry: bundle +
  safe-defaults into KISO_EXTENSIONS_DIR, faux calls mcp__fake__echo —
  the banner `[2 extensions: mcp, safe-defaults]`, the ask tier goes
  through Ruling A straight to the human pause and the approval question
  appears, y injected, the echo result returns to the model, done) — red
  on the first run (the CLI path level was wrong — `../../` only reached
  extensions/), green after the fix. The root `npm run check` now includes
  mcp's build+typecheck+test (the build after the seven packages; the
  pack/size gates do not apply).
- Docs: the README gains an MCP section (one stdio and one url config
  example, namespacing, approvals default to ask + a self-written policy
  allow example, the soft-failure semantics, mcp__status, the two
  build/install steps, tools only); this plan records ③.

## ④ subagent (2026-08-04) — official extension, zero kernel changes

- New workspace `extensions/subagent` (private, not published to npm):
  **zero runtime dependencies** (child_process/fs are all built-in) — no
  esbuild needed, `src/kiso-subagent.mjs` is the final artifact, the build
  only copies to dist/ (aligned with mcp's consumption). Four packages +
  the E1 loader: zero changes.
- The `delegate` tool: parameter schema { tasks: [{role: explorer|
  implementer|reviewer|tester, task(minLength 1)}] }, 1..8 items,
  concurrency cap 4 (runLimited); when KISO_SUBAGENT_DEPTH>=1 the factory
  returns {name:"subagent",tools:[]} (the depth guard, no nesting). Each
  task spawns a child kiso: process.execPath + (KISO_SUBAGENT_BIN ??
  process.argv[1]); the child session id = sub-<parentSessionId>-<index>-
  <role> (the parent id is discovered via KISO_SESSION_ID or the newest
  mtime in the sessions directory, falling back to "parent"); stdin is
  written "task text\nexit\n" then closed; the timeout defaults to 10
  minutes (KISO_SUBAGENT_TIMEOUT_MS overrides); a timeout or ctx.signal
  abort → SIGKILL the child process group (detached).
- The child process env is constructed explicitly {...process.env,
  KISO_SUBAGENT_DEPTH: +1, KISO_EXTENSIONS_DIR: the role-policy temp
  directory} — provider credentials pass down explicitly with process.env
  (the comment states the difference from #7: shell strips arbitrary
  commands by default; delegate is a human-ask-approved controlled spawn).
  Role policies (temporary .mjs, child-process-only): explorer/reviewer →
  read/list/search allow, everything else deny (with a reason);
  implementer/tester → the six-tool set allow; only allow/deny, never ask
  (headless deadlock, stated in a comment); the temp directory is cleaned
  up when the process exits.
- implementer isolation: `git worktree add --detach` (the system temp
  directory), the child's cwd = the worktree; after exit `git -C <worktree>
  add -N . && git diff` (including the --stat header; add -N puts new
  files into the diff) is collected into the result; a diff → the worktree
  is kept and its path returned, no diff → deleted; a non-git repo →
  honest failure. explorer/reviewer/tester cwd = the parent's cwd.
- Result extraction (a hard clause): after the child exits, extracted from
  the child session's JSONL (unwrapping the store's {runId,ts,event}
  records + a brief retry, because the exit event can arrive a beat before
  the final write lands) — the terminal outcome, the final assistant text
  (a projection-equivalent parse), the tool-call count; stdout is
  diagnostic only (attached on a non-zero exit or a missing JSONL). content
  = one section per task; partial failure does not fail the whole; total
  failure → isError:true. Approvals never auto-pass — delegate lands in
  the ask tier (truly reaches a human after Ruling A).
- Tests (red→green): 7 unit tests (① the depth guard ② the role-policy
  artifact: explorer deny write / allow read + no "ask" anywhere in the
  whole text ③ JSONL extraction (a fabricated completed child session)
  ④ a slow subtask + a short timeout → timely isError + the child process
  group is dead ⑤ 6 tasks' concurrency peak ≤4 (a probe) ⑥ implementer
  worktree: diff → kept, no diff → deleted ⑦ non-git honest failure) —
  the first run had 4 failures, root causes: runProcess's try/finally
  cleared the timer immediately, the extraction did not unwrap the store
  wrapper, the test assertions were too strict; 7/7 after the fixes. CLI
  e2e (a real process through the topmost entry): a parent kiso (a faux
  script calls delegate with one explorer task) + the extensions dir
  containing subagent + safe-defaults → the banner [2 extensions:
  safe-defaults, subagent], the delegate approval question appears (the
  ask tier, Ruling A), y injected, the subtask completes, the JSONL result
  section returns to the model, done; the child session JSONL exists with
  a terminal (the durable selling point pinned). Depth e2e: a child
  process (a faux script calls delegate) → "Unknown tool: delegate" (the
  guard works in the child). The root check includes subagent's
  build+typecheck+test.
- Docs: a new README Subagent section (the role table,
  concurrency/timeout, worktree semantics, the depth guard, the durable
  child-session selling point, credential passing vs #7, the two install
  steps); this plan records ④.

## ⑤ skills (2026-08-04) — official extension, zero kernel changes

- New workspace `extensions/skills` (private, not published to npm, zero
  runtime dependencies, source-is-artifact with a copy-only build — same
  as subagent). The factory scans
  `${KISO_SKILLS_DIR:-~/.kiso/skills}/<name>/SKILL.md`: frontmatter (a
  ---delimited YAML subset, only name/description recognized, a
  hand-written parse ≤20 lines, zero dependencies); name defaults to the
  directory name; description is required and ≤200 characters (overlong →
  truncated with a note); no/empty directory → {name:"skills",tools:[]}
  without error; broken (no frontmatter) → skipped + a warning line at the
  index's tail (soft failure, the same philosophy as mcp).
- tier 1 (resident): systemPrompt.append = "Available skills (load with
  read_skill):" + one "- <name>: <description>" line each, sorted by
  directory name, deterministic. tier 2 (on demand): read_skill {name} →
  the full SKILL.md (≤32KB, truncated with a note); unknown name → isError
  + the current list (an actionable honest error); other files in the
  skill directory are not auto-loaded — the body lets the model fetch them
  with read_file by relative path (the progressive third layer, zero new
  mechanisms, documented in the README). Finding #8: no persistent
  resources, so dispose is an explicit one-line "not needed".
- safe-defaults updated (this round's only change outside extensions/):
  read_skill joins the allow list (reads the user's self-installed local
  docs, the same trust level as read_file).
- Tests (red→green, into the root check): ① the index lands in
  systemPrompt (two skills, sorted deterministically) ② read_skill
  round-trips the full text ③ unknown name → an honest error containing
  the list ④ a broken SKILL.md soft-fails + the warning line ⑤ an
  overlong description truncated ⑥ empty/missing directory → zero skills,
  no error — 7 unit tests + 1 CLI e2e (a real process: two skills, faux
  calls read_skill → safe-defaults auto-approves (no approval question),
  the text returns to the model, done; the banner [2 extensions:
  safe-defaults, skills]) — green on the first run; the safe-defaults
  tests import the example and assert read_skill allow.
- Docs: the README Skills section (the SKILL.md format, the two
  progressive tiers + the third-layer read_file convention, CC skills
  compatibility — the frontmatter name/description subset is compatible,
  CC skills can be dropped in directly) + the Comparison section (the
  capability matrix next to the bench numbers, the honest footnote kept);
  the plan records ⑤. Out of scope: allowed-tools/model fields, a skill
  marketplace/install command, new bench tasks (T4 is another round), the
  session tree.

## 8. What was NOT done (explicitly out of scope)

- registerCommand / shortcuts / renderers / sendMessage-like APIs;
- project-level extensions; MCP; subagents;
- systemPrompt replace / any template engine;
- any new npm dependency; any change to the core line cap.
