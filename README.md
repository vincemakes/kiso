# kiso

```
█ █ ▀█▀ █▀▀ █▀█
█▀▄  █  ▀▀█ █ █   the coding agent that survives kill -9
▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀   v0.1.x
```

(The block letter above is `assets/logo.svg` in pixel form — an 8×8 K
whose bottom row is the 磐石 foundation the framework is named for.)

**kiso code = the coding agent that survives `kill -9`.** Interrupted
executions get human verdicts, approvals persist across processes, and every
event is auditable and replayable — the whole trajectory is on disk, and
`kiso resume` continues it exactly.

**kiso is a durable TypeScript agent framework for building coding agents
that can pause, crash, resume, and remain correct.** A small kernel owns
what genuinely repeats; packages grow on top of it without limit. For
TypeScript developers who want a real agent framework — event-sourced
sessions, durable human approvals, crash-consistent tool execution with
durable receipts and explicit uncertainty resolution — without a 50k-line
runtime.

Distilled from reading Claude Code, [pi](https://github.com/badlogic/pi-mono),
and [oh-my-pi](https://github.com/can1357/oh-my-pi) at the source level — and
from running three agent products in production on its validated predecessor
(mauri, Python).

Every design decision ships with an ADR explaining **why**, and **when to overturn it**.

## The rule

> The core will never exceed **2,000 lines**. Any PR that pushes it over gets
> closed, however good the feature is. CI enforces this before it installs a
> single dependency.
>
> If you need more, grow a package. That is the point.
>
> The gate is a snapshot discipline, not a self-adjusting ratchet:
> recalibration happens only by adjudicated ruling and only for
> spec-mandated growth — the standing escape hatch is EXTRACTION (ADR-0043).

```
$ npm run size

core:
  packages/core/src/kernel/loop.ts  660
  packages/core/src/protocol/events.ts 420
  ...
  total                               1914  / 2000
  ✓ 86 lines of headroom remaining.

cli:
  apps/cli/src/chat.ts  356
  apps/cli/src/index.ts 348
  ...
  total                  1547  / 1856
  ✓ 309 lines of headroom remaining.

tui:
  packages/tui/src/body.ts   440
  packages/tui/src/editor.ts 382
  ...
  total                      1361  / 1520
  ✓ 159 lines of headroom remaining.
```

(The cli gate's single 2400 terminal cap was replaced by per-package
gates when the terminal layer was extracted into @vincemakes/kiso-tui —
the ADR-0041 escape hatch, ADR-0043. Each gate = actual + 20%.)

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@vincemakes/kiso-core`, ≤ 2,000 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · hooks · compaction · modes · permissions) · L3 tool (contract · registry · real JSON Schema validation) · L7 eval hooks (delivery truth) |
| **packages** (unbounded) | `@vincemakes/kiso-evals` (faux provider · incident fixtures · contract tests) · `@vincemakes/kiso-provider-anthropic` · `@vincemakes/kiso-provider-openai` · `@vincemakes/kiso-runtime` (durable sessions, approvals) · `@vincemakes/kiso-tools-node` (file/search/edit/shell) · `@vincemakes/kiso-tui` (the pure terminal layer — cell renderer, dock, raw editor, diff; zero runtime deps, input is data / output is bytes — reusable standalone, API still 0.x semantics) · `@vincemakes/kiso-code` (the coding-agent reference product) |

The core stays a kernel: it decides nothing that repeats across products. The
framework around it is where product-shaped capability grows — and that growth
is the point, not a violation. Packages talk through the event stream and
hooks, never through a central hub. See ADR-0021.

Two properties every layer gets for free:

- **Replayable trajectories** — every event carries a monotonic `seq`; a run is
  the replay of `seq` 0..N. Session restore, eval fixtures, incremental UI, and
  skill distillation all consume the same stream. See ADR-0002.
- **Honest terminals** — every run ends with exactly one `Terminal` event;
  an API error never wears the reason `completed`. See ADR-0004.

## What the core is not

Loop *business logic*. UI. Permission policy. Billing. Skills content.
Retrieval. Those are not the core's job — they live in packages, where the
2,000-line cap does not bind them. A core that decides them for you is a blob,
and a blob is the thing you eventually fight.

## Requirements

- **Node ≥ 22** (the packages' engines).
- **python3** — the runtime's session store keeps its cross-process
  single-writer lock with a tiny `python3` kernel-flock helper (POSIX
  advisory locks; macOS/Linux). Known debt, adopted from the external
  review: a Node-side lock would remove the dependency — the store-level
  Lock Adapter injection is a 1.0 prerequisite (see `TODO.md` and
  `docs/reviews/2026-08-06-external.md`).

## Using it

```ts
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const agent = createAgent({
  model: "claude-sonnet-5",
  tools: [
    defineTool({
      name: "add",
      description: "Add two numbers",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
    }),
  ],
  store: new SessionStore("./sessions"),          // append-only JSONL
  adapter: createAnthropicAdapter(new Anthropic()),
});

const session = await agent.session({ id: "demo" });
for await (const ev of session.run("What is 2+3?")) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "terminal": console.log("\n", ev.outcome.kind); break;
  }
}
```

This is `examples/hello-agent.mjs` (faux adapter there — zero keys) and the
consumer smoke test runs it verbatim in a clean project against the packed
tarballs.

- Packages build to plain ESM JavaScript + `.d.ts` — installed artifacts run
  on any Node project, no tsx, no source access (`scripts/smoke.mjs` proves it
  in a clean temp project every check).
- `npm run demo` runs the raw-loop REPL; the reference product is the CLI.
- Every fixture in `@vincemakes/kiso-evals` is a real production incident (uooki, 2026);
  the loop is proven against them, not just against happy paths — and the
  fixtures run on the real session runtime, not a test harness.

## Support

Node **>= 22** (the OpenAI-compat provider and the CLI declare it in `engines`).

## The CLI — the coding-agent reference product

The CLI is a real npm package — install it globally, or run it directly:

```
npm install -g @vincemakes/kiso-code
kiso chat          # after the global install, the command is `kiso`
npx @vincemakes/kiso-code chat   # or run without installing
```

(Inside this repo, `npm run cli` runs the same binary.) The command set:

```
kiso [sessionId]               interactive session (default command)
kiso chat [sessionId]          same as above
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions                  list durable sessions
kiso help                      this help
```

- Tools: read file · list directory · search text · write/edit file · shell.
  Writes and shell sit behind the approval policy: the run **pauses**, asks
  `approve write_file? (y/n)`, persists the decision, and resumes the same
  run (ADR-0024).
- **Scoped reads (0.1.27, the token round):** reads are rangeable —
  `read_file` takes `offset`/`limit` (1-based lines) and returns only the
  head 200 lines of a large file by default, `search_text` caps at 50
  excerpts, `list_dir` at 200 entries. Every truncation carries an
  actionable continuation note (`… N more lines (call again with
  offset=…)`, `… +N more matches (narrow the pattern)`) — the model
  always has a path to the full content, deterministically. The system
  prompt guides batching independent calls in one round (the parallel
  execution makes it fast), locating before reading, and never re-reading
  unchanged files.
- Sessions are append-only JSONL under `$KISO_HOME/sessions` — exit, restart,
  `kiso resume <id>`, and the conversation continues with a contiguous seq.
- Keyless faux mode out of the box; `ANTHROPIC_API_KEY` (or
  `OPENAI_API_KEY` + `OPENAI_BASE_URL`) switches to a real provider.
- Interrupted side effects are surfaced on resume (`⚠ interrupted execution`)
  and block until a human resolves them — a confirmed success never re-runs.

### Model configuration (`~/.kiso/config.json`, 0.1.23)

The config surface (ADR-0045) holds named model profiles — schema v1,
credentials never inside (a profile only NAMES the env var holding its
key). Precedence: **flags > env > project config > user config > default**;
a broken config file fails loudly with the file named.

```jsonc
// ~/.kiso/config.json
{
  "model": "deepseek",                       // the startup profile
  "models": {
    "deepseek": {
      "kind": "openai-compat",               // or "anthropic"
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",       // the key's env var — never the key
      "baseUrl": "https://api.deepseek.com"  // optional
    },
    "claude": { "kind": "anthropic", "model": "claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "mode": "default",                         // manual/default/accept-edits/plan/bypass
  "contextWindow": 160000,                   // tokens
  "autoCompact": { "thresholdRatio": 0.8 },  // opt-in, env KISO_AUTO_COMPACT wins
  "projectTrust": "ask"                      // "ask" | "never" — no "always"
}
```

- `kiso --model deepseek chat` — the flag beats everything; `provider/model`
  direct writes work too (`--model openai-compat/gpt-4o`).
- `/model` in a session lists the profiles (each annotated available /
  unavailable — an unset apiKeyEnv is never a crash) and switches the
  session's adapter for subsequent turns (a NoticeCell records it).
- A profile whose env var is unset is refused loudly on switch — configs
  never store keys, so a missing env is an honest "not configured".
- The project's own `.kiso/config.json` rides the E3 trust gate: a
  granted project's config applies, an untrusted one is never even read
  (its digest covers the config file).
- **Migration from the kiso-ds wrapper pattern** (a shell wrapper
  exporting `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`): the
  wrapper still works — the env layer is second in the chain — but the
  config profile above is the replacement form (typed, switchable at
  runtime, and the key stays in your environment either way). The wrapper
  pattern is 遗留可用 (legacy, supported).

### The `kill -9` test

This is the product's scripted proof, automated end to end in
`apps/cli/tests/kill9.test.ts` (real PTY, real processes, real SIGKILL —
no mocks, no signal simulation). It is exactly what a `kill -9` user
experiences:

```
$ kiso chat k9                        # faux trajectory: edit f1.txt → slow
                                      # shell (sleep 30 && touch marker.txt)
                                      # → edit f3.txt; approve both tools
...                                   # the shell is mid-execution...
$ kill -9 -PGID                       # the agent's whole process group —
                                      # and the shell's own detached group
$ kiso resume k9
⚠ interrupted execution: shell (ex-12) — did it apply? (r)erun / (a)bandon: r
  rerun
→ edit_file({"path":"f3.txt",...})    # the ORIGINAL trajectory continues
```

What the test asserts on disk and on the filesystem after phase 1 (the kill):

- the event stream loads without corruption;
- **exactly one** execution is `uncertain` — the shell started, never reported;
- `marker.txt` does not exist; `f1.txt` was edited before the kill; no
  terminal was written.

And after phase 2 (the resume, in a fresh process, zero human typing):

- the uncertain verdict question is presented, `rerun` is injected;
- the third edit happens — the trajectory continues, it does not replay;
- the terminal lands and is durable; `marker.txt` still does not exist;
- exactly one `tool_execution_resolved` is on disk.

## MicroCompact — zero-API context relief

**The CLI ships it ON by default**: threshold = half the model window
(`KISO_CONTEXT_WINDOW` override included — 200k window → 100k tokens).
Library users opt in with `microcompact: { thresholdTokens }` in
`createAgent`. When a session's projected context crosses the threshold,
the loop appends **one** `microcompacted` boundary event to the stream —
never a per-turn progressive clearing. The projection then derives the
compacted view deterministically: tool results older than the boundary
whose tool is in the whitelist (`read_file`, `list_dir`, `search_text`,
`shell`) are replaced by the fixed placeholder
`[old tool output cleared: <tool> <arg>]`. write/edit outputs are never
touched; results tagged `do-not-compact` are never touched; recent turns
stay intact.

The decision is a persisted fact, not runtime state: the same events always
derive the same messages — a crash/resume replays the boundary and lands on
the byte-identical projection (see the byte discipline below). No counting
API, no price table, no tokens spent on the compaction itself.

**The model-summary layer (`/compact`, ADR-0044)**: the mechanical clearing
works on tool results only — the CONVERSATION still grows. `/compact`
(summarize the older conversation to free context) compresses the covered
rounds — everything before the most recent 4 rounds, from the last summary
point — into one durable `summarized` event via an off-loop call through
the session's own adapter. The projection replaces the covered range with
a single assistant summary message; the original events stay on disk
forever (the raw log, /last, and /think still reach them); a crash before
the persist is "nothing happened", after it the resume projects the
compressed view. The classic auto-compaction (`config.compaction` +
`compacted` events) was retired into the boundary by ADR-0044 — old logs
with `compacted` events replay verbatim, forever. (Matrix note: context
economy ◐→● — ◐ was the mechanical clearing alone, 0.1.19; ● adds the
model summary, 0.1.20.)

Wired end to end and test-verified: a session running through the real
runtime records the boundary on disk and a reloaded session projects the
placeholders (`packages/runtime/tests/microcompact-e2e.test.ts`); the CLI
resumes an over-threshold session with a tiny window and the boundary
lands (`apps/cli/tests/microcompact-cli.test.ts`).

## Prompt-cache byte discipline

Contract: the same event-stream prefix projects to a **byte-identical**
message prefix (`JSON.stringify`, element for element). New events only ever
change the projection at the tail — the one exception is the `microcompacted`
boundary, itself a persisted fact whose replay derives the same projection
every time. The contract is pinned by three regression tests
(`packages/core/tests/prompt-cache.test.ts`): ① the same log projects
identically twice, ② appending a turn leaves the old prefix byte-identical,
③ a microcompact boundary replays byte-identically after a JSON round-trip
(the crash + resume shape).

## Extensions — approval policies beyond the human

An extension is a plain `.mjs` file — no SDK, no build step. kiso scans
`~/.kiso/extensions/*.mjs` at startup (`KISO_EXTENSIONS_DIR` overrides) and
names what loaded in the startup banner: `[2 extensions: safe-defaults,
foo]`. Loading is **loud**: a broken file or a duplicate extension name
fails the process at startup with the file name — an extension that cannot
load must never silently change behavior.

The contract is pure types (`packages/core/src/protocol/extension.ts`):
each file's default export is the extension, or a factory returning it.

```ts
export default {
  name: "safe-defaults",              // unique per installation
  hooks: { /* ... */ },               // optional — compose AFTER the harness's
  tools: [ /* ... */ ],               // optional — merged into the registry
  approvals: [{ decide(call, ctx) { /* ... */ } }], // optional — the policy chain
  compaction: { thresholdTokens: 50_000 }, // optional — supplies the loop's
                                        // microcompact params when the
                                        // session sets none
  systemPrompt: { append: "..." },   // optional — EXTEND the system prompt
};
```

`systemPrompt.append` is appended to the end of the session's own system
prompt (`\n\n`-joined, extensions in load order) — append-only, never
replace: adding an extension can never remove existing guidance (the same
monotonicity as the approval chain and the veto short-circuit). The
composition is deterministic — the same extension list always assembles
the same prompt, byte for byte.

A policy's `decide` returns `{ action: "allow" }`, `{ action: "deny",
reason }`, or `{ action: "ask" }`. The chain runs **before** the human
approval flow and composes across all loaded policies:

- **deny > ask > allow** — any deny wins (the FIRST denial's reason reaches
  the model); else any ask goes DIRECTLY to the human approval pause (the
  CLI prompts `approve ...? (y/n)` — never through the static policy hook,
  which must not answer for the human; 裁决 A, E1 ask 语义修正); only an
  **all-allow** chain auto-approves.
- A policy that throws counts as **ask**; `ask` with no approval channel
  configured (no `resolveApproval`) degrades to an honest denial — judged
  by the channel's presence, not the hook's.
- allow/deny are recorded durably as `permission_decided` with
  `decidedBy: <extension>` — never a human pause. A policy verdict is a
  PERSISTED FACT like any human decision: `kill -9` the agent and the
  already-decided calls are never re-asked — a fresh-process resume applies
  the durable verdicts and the policy's `decide` is never re-run for them.

### safe-defaults — the tutorial

`examples/extensions/safe-defaults.mjs` is the reference extension: allow
the cheap read-only tools outright, deny the most dangerous shell
commands, ask for everything else. Install it with one line:

```
mkdir -p ~/.kiso/extensions && cp examples/extensions/safe-defaults.mjs ~/.kiso/extensions/
kiso chat     # → [1 extension: safe-defaults]
```

Now every `read_file`/`list_dir`/`search_text` auto-allows (no prompt); a
`shell` command matching `\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf` is
denied, with the reason fed back to the model; every write and every other
shell command is still asked of the human. The gate is automated in
`apps/cli/tests/extensions-e2e.test.ts` — a real PTY session, a real
`kill -9`: the read is auto-allowed, the write is asked, the destructive
shell is denied, and the resume re-presents only the one undecided request
while the extension's own call log (a marker file written per `decide`
call) proves the policy never re-runs across the kill.

## Modes — the five built-in approval tiers

`/mode` switches the whole session's approval posture. Five tiers, built
ON the extension chain above — the kernel is untouched: each tier is an
in-process `mode:<name>` extension (chain head), so its automated
verdicts record `decidedBy: "mode:<name>"` — the audit trail names the
tier that decided, exactly like it names the extension.

| tier | semantics |
|---|---|
| `default` | reads allow; write/edit/shell ask the human; extension tools are the extensions' business (the tier stays out of it) |
| `manual` | EVERY tool asks the human |
| `accept-edits` | `default` + write_file/edit_file allow |
| `plan` | read/list/search/read_skill allow; everything else denied with `plan mode: read-only` (the deny reason guides the model to output a plan; the startup prompt adds a plan directive) |
| `bypass` | everything allows — but a user extension's `deny` still wins (the chain's deny>ask>allow monotonicity; bypass cannot override an extension) |

- `/mode` prints the current tier and the list; `/mode <name>` switches
  immediately (the change applies to the next tool call), leaving a
  notice line in the session body. Startup: `--mode <name>` or
  `KISO_MODE=<name>`; default is `default`.
- The status bar shows the non-default tier in blue — `plan`/`bypass`
  carry a ⚠ prefix (danger visible at a glance).
- This is kiso's answer to Claude Code's permission modes: a CLI-side
  policy layer over the same extension approval chain — user extensions
  keep their votes on every call, and their denies always win.

## MCP — external tools over the MCP bridge

`extensions/mcp` is the official MCP bridge: an ordinary extension — a
self-contained single file (`dist/kiso-mcp.mjs`, the MCP SDK inlined) —
with the four kernel packages untouched. Configure servers, build, install:

```
cd extensions/mcp && npm install && npm run build   # step 1 — dist/kiso-mcp.mjs
cp dist/kiso-mcp.mjs ~/.kiso/extensions/            # step 2 — the E1 loader picks it up
```

Configuration: `$KISO_MCP_CONFIG` (default `~/.kiso/mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "SOME_VAR": "1" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    },
    "legacy": { "command": "node", "args": ["server.js"], "disabled": true }
  }
}
```

- Every MCP tool becomes a kiso tool named `mcp__<server>__<tool>`; the
  input schema passes through as-is. `mcp__status` (zero args) reports each
  server's connection state and errors — connection is a load-time fact
  and the CLI has no new UI for it, so the tool itself presents it.
- A server that fails to connect is a SOFT failure: its error lands in
  `mcp__status`, every other server keeps working. A missing config file
  means no servers (never an error); a broken config throws loudly at
  startup (the E1 loader convention).
- stdio children get provider credentials STRIPPED (the same list as the
  shell tool — `ANTHROPIC_/OPENAI_` KEY/BASE_URL/MODEL plus every
  `*_API_KEY`/`*_AUTH_TOKEN`) plus the config's `env` — the explicit env
  wins and may deliberately re-add a variable.
- Calls carry the run's abort signal and a 60s timeout — an interrupted
  call returns an error, never a hang.
- **Approval: no auto-allow.** `mcp__` tools fall in the ask tier — an
  external tool must pass human review before it runs. Write your own
  policy extension to allow specific ones:

```ts
export default {
  name: "allow-my-mcp",
  approvals: [{
    decide: (call) => call.name === "mcp__filesystem__read_text_file"
      ? { action: "allow" } : { action: "ask" },
  }],
};
```

Tools only: MCP resources/prompts and OAuth are not bridged this round.

## Subagents — delegate to child kiso processes

`extensions/subagent` is the official subagent extension: a zero-dependency
single file (`src/kiso-subagent.mjs` is the artifact; `dist/` is a copy) —
no SDK, no build step beyond the copy. Build and install:

```
cd extensions/subagent && npm install && npm run build   # step 1 — dist/kiso-subagent.mjs
cp dist/kiso-subagent.mjs ~/.kiso/extensions/            # step 2 — the E1 loader picks it up
```

The extension adds ONE tool, `delegate`, which runs 1-8 subagent tasks in
child kiso processes (the same binary), at most 4 concurrently:

| role | allowed tools | cwd | isolation |
|---|---|---|---|
| explorer | read/list/search | parent's cwd | role policy |
| reviewer | read/list/search | parent's cwd | role policy |
| tester | all six | parent's cwd | role policy |
| implementer | all six | a detached `git worktree` | diff comes back |

- **Role policies are generated per child** (a temporary extensions dir):
  only allow/deny — never ask (a headless child cannot answer an approval
  prompt). Explorer/reviewer may only read; implementer/tester may change.
- **implementer isolation**: the child works in a detached `git worktree`
  (parent must be a git repo — otherwise the task fails honestly); after
  the child exits, `git diff` (with its `--stat` header) comes back in the
  result. A worktree with changes is KEPT and its path returned; a clean
  one is deleted.
- **Results come from the child's own session JSONL** — terminal outcome,
  the final assistant text, and the tool-call count — never from stdout
  (stdout rides along only as a diagnostic when the child exits non-zero
  or the JSONL is missing). Children land in the normal sessions directory
  (`sub-<parent>-<n>-<role>`): they are durable, auditable, and resumable
  with `kiso resume` even if the parent is killed — the subagent selling
  point.
- **Depth guard**: `KISO_SUBAGENT_DEPTH ≥ 1` (set on every child) makes
  the factory return no tools — subagents can never nest.
- **Timeouts**: 10 minutes per child by default (`KISO_SUBAGENT_TIMEOUT_MS`
  overrides); a timeout or the parent run's abort SIGKILLs the child's
  whole process group.
- **Provider credentials deliberately pass down** with the parent's
  environment — the difference from the shell tool (#7): shell runs
  arbitrary commands (stripped by default); delegate is a CONTROLLED spawn
  the human just approved.
- **Approval: no auto-allow.** `delegate` falls in the ask tier — a human
  sees every delegation and can deny it.

## Skills — two-tier progressive skill loading

`extensions/skills` is the official skills extension: a zero-dependency
single file (`src/kiso-skills.mjs` is the artifact; `dist/` is a copy).
Build and install:

```
cd extensions/skills && npm install && npm run build   # step 1 — dist/kiso-skills.mjs
cp dist/kiso-skills.mjs ~/.kiso/extensions/            # step 2 — the E1 loader picks it up
```

A skill is a directory with a `SKILL.md` under `$KISO_SKILLS_DIR`
(default `~/.kiso/skills`), e.g. `~/.kiso/skills/review/SKILL.md`:

```markdown
---
name: review
description: a review checklist for pull requests
---

# Review checklist

... the skill body ...
```

- **Tier 1 — resident index.** Every skill's frontmatter (a `---` wrapped
  YAML subset; only `name`/`description` are read — no dependency, no
  parser) becomes one line of the system prompt, sorted by directory name:
  `Available skills (load with read_skill):` followed by one
  `- <name>: <description>` per skill. A `SKILL.md` without frontmatter is
  skipped with a warning line at the index tail — a soft failure, like the
  MCP bridge. No/empty skills dir → an empty extension, never an error.
- **Tier 2 — on demand.** The `read_skill` tool returns the full `SKILL.md`
  (capped at 32KB with a truncation note); an unknown name is an honest,
  actionable error listing the installed skills.
- **Tier 3 — progressive, zero new mechanisms.** Files other than
  `SKILL.md` are NOT auto-loaded: the skill body tells the model to read
  them with `read_file` by relative path when it needs them.
- **Claude Code compatibility.** CC skills use the same frontmatter
  shape; the name/description subset parses them as-is — drop a CC skill
  directory into `~/.kiso/skills/` and it works.
- **Approval:** `read_skill` reads user-installed local docs — the
  safe-defaults example allows it (read_file trust); everything else
  about skills is plain file access governed by the existing policy.

## Todo — durable long-horizon working memory

`extensions/todo` is the official todo extension: a zero-dependency single
file (`src/kiso-todo.mjs` is the artifact — source IS the product, no
build step). Install by copying it, like the skills extension:

```
cp extensions/todo/src/kiso-todo.mjs ~/.kiso/extensions/   # the E1 loader picks it up
```

The `todo_set` tool is a whole-table replace (the CC TodoWrite shape):
the model sends the complete current list every time, with at most one
item `active` (a second active is refused loudly — the CC discipline).
The result echoes the normalized list and carries the `do-not-compact`
tag. The echo renders in the terminal as a checklist cell
(□ pending / ▖ active / ▣ done, the brick family), and the system prompt
gains a restrained planning discipline (3+ steps → plan first with a
verification step; mark active before starting; mark done immediately).

The selling point is the contrast with Claude Code's TodoWrite: CC's list
is **runtime state** — it dies with the process. kiso's list is **durable
events** — the echo is a tool-result message in the session log, so it
survives kill -9 (a resume rebuilds the projection from the log) and
/compact (the do-not-compact tag makes the summary layer's boundary pull
back before its round — the latest list is never lost to a summary).

## Project-level `.kiso` — trusted by content digest, not by directory

A repo's own `.kiso` directory is a capability surface: cloned code that
executes on your machine the moment you run `kiso chat` in it. Three
artifact kinds are recognized there — `extensions/*.mjs`, `mcp.json`, and
`skills/<name>/SKILL.md` — and they share ONE trust gate (ADR-0037):

- **First discovery.** The CLI lists every artifact (file name + digest
  short prefix) and asks once: `trust this project's .kiso? (y/n)`. The
  verdict is recorded in `~/.kiso/trust.jsonl` (append-only,
  `KISO_HOME`-aware).
- **Granted** — the project's extensions load (marked `project:` in the
  banner: `[3 extensions: safe-defaults · project: lint-rules, mcp]`), its
  `mcp.json` merges with your user config (a server name in both is a loud
  startup error), and its skills merge into the skills scan (a skill name
  in both: project wins, one stderr note).
- **Refused** — nothing loads, and the refusal is sticky: it is never
  re-asked. Re-evaluate by deleting the `trust.jsonl` line for that
  project, or by changing an artifact file.
- **The trust dies with the files.** The digest is a sha256 over the
  sorted artifact paths and contents — `git pull` that changes `.kiso`
  makes you decide again. Same project, same files, same verdict: the
  gate never re-asks.
- **Non-TTY (CI, pipes).** Never asks, never loads — one stderr line
  explains. To pre-grant for CI, run `kiso chat` interactively once in
  the repo, or write the record yourself: a `trust.jsonl` line
  `{"root": "<realpath of <repo>/.kiso>", "digest": "<bundle sha256>", "decision": "granted", "ts": "..."}`.
  There is deliberately NO `KISO_TRUST`-style skip-ask environment
  variable — the gate is not a toggle.
- **Your home is never a project.** When you run kiso in your home
  directory, `<cwd>/.kiso` IS your user-level config directory — discovery
  returns nothing and the gate never runs (discovery#10). A stale
  `trust.jsonl` grant for the home dir is inert and can be left alone.

## Comparison

The bench (`bench/`, same model, same tasks, three agents) measures
efficiency on small tasks — capability was equal there. The capability
matrix below is what kiso itself delivers, each row proven by a gate in
this repo; the numbers beside it are the bench's, honest footnotes kept.

| capability | delivered by | proven in |
|---|---|---|
| survives `kill -9` | event-sourced sessions; resume continues the interrupted run | `apps/cli/tests/kill9.test.ts` |
| durable human approvals | pauses persist across processes; verdicts never lost | `packages/runtime/tests/approvals.test.ts` |
| crash-consistent execution | durable receipts keyed by `executionId`; a confirmed success is never re-run (exactly-once within the framework's own window — the rest is explicit human-resolved uncertainty) | `packages/core/tests/execution-gate.test.ts` |
| extensions | policies / tools / hooks / systemPrompt / dispose | `packages/runtime/tests/extensions.test.ts` |
| MCP bridge | official extension, kernel untouched | `extensions/mcp/tests` |
| subagents | official extension, role-policy children | `extensions/subagent/tests` |
| skills | official extension, two-tier progressive | `extensions/skills/tests` |
| todo | official extension, durable long-horizon memory (todo_set) | `extensions/todo/tests`, `apps/cli/tests/todo-e2e.test.ts` |
| context economy ● | microcompact + /compact (model summary) + prompt-cache discipline | `packages/core/tests/prompt-cache.test.ts`, `summarize.test.ts` |
| project `.kiso` trust | content-digest gate, one ask, sticky refusal | `apps/cli/tests/project-trust.test.ts` |

The bench, one fixture, one model, mean of two runs (kiso 0.1.27/0.1.28 ·
pi 0.73.1 · Claude Code 2.1.223 via a DeepSeek endpoint):

| task | tool | fresh in | cached in | total in | cost-wtd | out | reqs | wall |
|------|--------|-------:|-------:|-------:|---------:|-----:|----:|-----:|
| T1 read+answer | **kiso** | 196 | 2,176 | **2,372** | **414** | 162 | 2.0 | **5.0s** |
| | pi | 1,146 | 7,680 | 8,826 | 1,914 | 158 | 2.0 | 5.5s |
| | claude | 25,926 | 25,792 | 51,718 | 28,505 | 226 | 2.0 | 6.0s |
| T2 fix+verify | **kiso** | 990 | 5,120 | **6,110** | **1,502** | 256 | 4.0 | **6.5s** |
| | pi | 1,493 | 17,152 | 18,645 | 3,208 | 396 | 4.0 | 10.5s |
| | claude | 26,520 | 78,208 | 104,728 | 34,340 | 646 | 4.5 | 13.5s |
| T3 cross-file rename | **kiso** | 1,989 | 7,936 | **9,925** | **2,782** | 777 | 5.0 | **11.5s** |
| | pi | 1,628 | 22,784 | 24,412 | 3,906 | 752 | 5.0 | 13.0s |
| | claude | 28,196 | 203,648 | 231,844 | 48,561 | 2,094 | 14.5 | 30.0s |
| T4 skills (repo convention) | **kiso** | 1,431 | 8,960 | **10,391** | **2,327** | 749 | **5.0** | **13.0s** |
| | pi | 2,212 | 50,368 | 52,580 | 7,249 | 2,536 | 8.5 | 34.0s |
| | claude | 30,293 | 287,488 | 317,781 | 59,042 | 4,234 | 14.0 | 54.0s |

Headline (T3, the hardest task): on **raw total input tokens** kiso is
**2.5× fewer** than pi (9.9K vs 24.4K) and **23.4× fewer** than Claude
Code, with identical task outcomes (T5 8-turn session: 1.9× fewer than pi,
6.7× fewer than CC). On **cost-weighted input** (fresh + 0.1×cached,
DeepSeek's cache-hit price ratio — see `bench/README.md`) kiso is cheaper
on EVERY scenario: T4 3.1× (2.3K vs 7.2K — the token round's flip: 5
requests vs pi's 8.5), T2 2.1×, T3 1.4×, T1 4.6× and T5 1.35×; CC stays
5.5-24.9× heavier. The 0.1.22-era version of this table reported a
phantom "kiso fresh ≈ system-prompt size" anomaly and a pi cost-overtake
— both were extraction artifacts (kiso's total input was mislabeled as
fresh and double-counted into "total"); the 0.1.23 investigation fixed
the accounting AND found one real request-prefix violation in the adapter
(the reasoning_content turn-boundary flip, fixed in 0.1.23, ADR-0026
Amendment 1). T4's 0.1.26-era baseline (13 requests, 6.6K cost-weighted)
was itself a harness artifact — the runner never loaded the skills
extension, so the model paid raw exploration cost; the 0.1.27 失格调查
found and fixed it (full detail in `bench/README.md`). The T2/T3 fresh
means include the one-time cold start of the token round's prompt change
(the r2 steady-state rows are within variance of 0.1.26).

Honest footnotes (from `bench/README.md`): these tasks are SMALL — Claude
Code's large system prompt buys real product capability (task tracking,
richer exploration) that pays off on complex work these tasks do not
exercise; Claude Code ran off-label (DeepSeek endpoint) and its prompts
are tuned for Claude models; n=2, one fixture, one model, token accounting
normalized per provider convention; kiso is our own tool — reproduce it
yourself, everything needed is in `bench/`.

## Status

Reliable Session Alpha, including the four hardening rounds (areas 1-7,
A-F, 一-九, and the 第四轮 adversarial round), is complete (see
`docs/plans/2026-08-03-reliable-session-alpha.md`), the **kiso code**
round (the coding agent: kill -9 gate, microcompact, byte discipline) is
done (see `docs/plans/2026-08-04-kiso-code.md`), and the **extensions**
round (E1: the approval-policy extension system; E2: the compaction
parameter and systemPrompt append surfaces — see
`docs/plans/2026-08-04-extensions-e1.md`) is done:

- **core** (1,914/2,000 lines) — protocol, loop (single honest terminal;
  missing/duplicate stops and tool_use-without-a-call are structured
  errors; retry only before anything streamed; one abort signal reaches
  backoff, approval waits, every pending tool, and the SDK), hooks,
  ModeProfile, permissions, microcompact (a `microcompacted` boundary is a
  persisted fact — the projection derives the compacted view
  deterministically; whitelist read/list/search/shell, `do-not-compact`
  respected, recent turns intact), the extension policy chain (E1: a
  deny > ask > allow composition decided BEFORE the human flow — allow/deny
  recorded durably with `decidedBy`, a throwing policy counts as ask, a
  durable verdict survives kill -9 and the policy never re-runs), delivery
  truth, the lossless event-log projection (messages are a pure function of
  the log, ADR-0002 — and the prompt-cache byte discipline: the same event
  prefix projects to the same message prefix, byte for byte, pinned by
  three regression tests), and the execution ledger keyed by framework
  `executionId` (ADR-0025): a failed non-idempotent execution is UNCERTAIN
  until a human decides — a confirmed success is never re-run, a new
  logical call always runs.
- **runtime** — `createAgent` / durable multi-turn sessions / crash-safe
  JSONL store (torn-tail repair under a kernel-flock cross-process writer
  lock — upgrade requires QUARANTINE: stop every old-format process before
  starting the new version; the pidfile guard is best-effort, not a
  seamless rolling upgrade (第五轮 P1-4), strict
  load, contiguous-seq validation) / `session.resume()` continues the
  INTERRUPTED run across processes: durable approvals are applied (the
  original call executes once, denials write their result), missing
  receipts are filled, and the original run completes — no invented turns /
  `loadExtensions(dir)`: every *.mjs default export (or factory), loud
  startup failure on a bad file or duplicate name; extension tools merge
  into the registry (built-in collision = startup error), hooks compose
  AFTER the harness's own (既有先行), approvals enter the policy chain.
- **cli** (1,547/1,856 lines) — the coding agent: bare `kiso` enters chat;
  the startup extension scan (`~/.kiso/extensions/*.mjs`, banner
  `[2 extensions: safe-defaults, foo]`);
  a system prompt (coding-agent discipline: read before edit, careful
  shell) composed from a constant, with AGENTS.md/CLAUDE.md injected and
  truncated at 8KB; one-line tool summaries per call
  (`✓ edit src/foo.ts (+12 -3)` / `✗ shell npm test (exit 1)`), the status
  line (`[turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]` — usage
  events only, unknown fields omitted entirely, faux mode shows
  `[turn N · faux]`), and `/last` to print the most recent tool call's
  full input/output straight from the event stream. v2a/v5: the color
  identity is bright-white BOLD (SGR 1 — the you> prompt, the banner
  tagline, ✓ marks, command names, the user block's ▍ rail, the input
  brick), a light-blue inline-code tint (256 color 110) on backtick spans
  in assistant text, red for errors, dim for metadata, green for the
  approval diff — everything else plain; `NO_COLOR` or a pipe disables it
  all (pipes carry zero ANSI); typed input is echoed by readline itself,
  never rendered twice; a spinner glyph shows liveness between the request
  and the first delta. v2b: thinking blocks fold to ONE dim line per block
  (first 100 chars + ` (… /think shows full)`, `/think` prints the last
  complete block), the `[result]` echo truncates at 160 chars +
  ` (/last for full)` — the content strategy is the same in pipes; on a
  color TTY the UI docks to the bottom (ADR-0039): four pinned rows — an
  upper dim separator, the `▌` input line, a lower separator, and a LIVE
  status bar (idle `▸ <mode> · /mode to switch · …` with the right-aligned
  dim `/ commands · ↑ history` hint — cut first when the window is
  narrow; running `▖ working Ns · esc to interrupt · …`); the body scrolls
  with real LFs into the native scrollback (v2d-B, ADR-0040 — no scroll
  region); approval/uncertainty/trust questions take over the
  status position and are answered at the input line; SIGWINCH
  re-applies the region, bottom redraws are wrapped in CSI 2026
  synchronized output, and every exit path resets the terminal in a
  finally (`\x1b[r`) — a `kill -9` can leave the bottom rows stuck, and
  the terminal's `reset` command saves it. v2c: the TTY path draws its own input line (ADR-0039
  Amendment 2) — a zero-dependency raw-mode editor (display-width cursor
  math — CJK wide chars land on the right column, the hard acceptance —
  bracketed paste, horizontal scrolling with a dim … marker) with the
  kiso brick motif: a blue half-block ▌you> row and a dim dotted ╌
  separator; the sent line renders into the body exactly once, a turn
  submitted while another runs queues with a live `+N queued` status, and
  Esc aborts. Known limitation: emoji ZWJ clusters are not width-perfect.
  Pipes keep readline byte-for-byte. v2d (ADR-0040): the body becomes a
  cell renderer — ONE writer owns the scroll region (event handlers only
  mutate cells, so interleaving is impossible by construction); completed
  cells freeze once, unfinished cells render in an active tail at the
  region's bottom and redraw in place; a tool's life is ONE line
  (`→ name 摘要` → ⏸ → running spinner + Ns → `✓ name (摘要, 1.2s)`),
  the [result] no longer flows into the stream (`/last` holds it); the
  pipe bytes stay byte-identical. `resume` is the recovery flow (uncertain executions are
  decided rerun/abandon — uncertainty belongs to the crash window alone,
  ADR-0038; a receipted failure is a clean failure whose result carries an
  honest partial-side-effect note, and a retry re-passes the approval
  chain); coding tools are bound
  to the workspace root (absolute paths, `..`, and symlink escapes are
  refused); the approval prompt shows the full shell command and full
  paths. The **kill -9 gate** (`apps/cli/tests/kill9.test.ts`) SIGKILLs a
  real chat mid-execution and resumes it in a fresh process — see the
  section above.
- **workspace** — publishable monorepo (core, evals, runtime, tools-node,
  provider-anthropic, provider-openai, cli), ESM + d.ts, synchronized
  internal versions; CI is clean-checkout `npm ci` + the full gate.

`npm run check` = build → typecheck (packages + root scripts + tests) →
tests → size gate (core 2,000 + cli 1,600) → pack gate (dist + README +
LICENSE in every tarball) → whitespace gate (no trailing whitespace, every
file ends with a newline)
→ `git diff --check` on the working tree and the index
→ consumer smoke tiers (runtime, NESTED install, providers, CLI, nested
  CLI with real Anthropic/OpenAI env)
→ demo start-and-exit gate. 461 tests green. 17 ADRs (index: `adrs/README.md`).
6 incident fixtures running on the real runtime.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
