# kiso

```
█ █ ▀█▀ █▀▀ █▀█
█▀▄  █  ▀▀█ █ █   the coding agent that survives kill -9
▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀   v0.2.0
```

(The block letter above is `assets/logo.svg` in pixel form — an 8×8 K
whose bottom row is the bedrock foundation the framework is named for.)

A Chinese edition: [README.zh.md](README.zh.md).

**kiso code = the coding agent that survives `kill -9`.** Interrupted
executions get human verdicts, approvals persist across processes, and every
event is auditable and replayable — the whole trajectory is on disk, and
`kiso resume` continues it exactly. The proof is scripted:
`scripts/demo-kill9.sh` SIGKILLs the agent's whole process group mid-tool
and resumes the session clean, twice in a row — the same story the kill-9
section below automates end to end in `apps/cli/tests/kill9.test.ts`.

**kiso is a durable TypeScript agent framework for building coding agents
that can pause, crash, resume, and remain correct.** A small kernel owns
what genuinely repeats; packages grow on top of it without limit. For
TypeScript developers who want a real agent framework — event-sourced
sessions, durable human approvals, crash-consistent tool execution with
durable receipts and explicit uncertainty resolution — without a 50k-line
runtime.

**The numbers, on the same model and the same tasks** (the 2026-08-16
three-way comparison, cost-weighted input): T3, the cross-file rename,
needs **2.55× fewer input tokens than pi and 32× fewer than Claude Code**
with identical task outcomes. The full table and its honest footnotes are
in the [comparison section](#comparison).

**The core is a 2,000-line kernel, enforced by CI** — it cannot exceed
2,000 lines; past that you grow a package. See [the rule](#the-rule).

**A frozen durable-execution contract, enforced by gates** — the session
format and its recovery semantics are frozen; every invariant has an
executable gate in `npm run check`. See [the contract](#the-durable-execution-contract).

Distilled from reading Claude Code, [pi](https://github.com/badlogic/pi-mono),
and [oh-my-pi](https://github.com/can1357/oh-my-pi) at the source level — and
from running three agent products in production on its validated predecessor
(mauri, Python).

Every design decision ships with an ADR explaining **why**, and **when to overturn it**.

## Why durable — the durable runtime

> **Agents crash. Side effects don't rewind. Kiso makes execution durable.**

A coding agent is a process driving side effects — file edits, shell
commands, remote calls — through a model that makes mistakes. Treating
the agent as if it survives is what turns a demo into a tool; treating a
crash as if it rewinds everything is what turns a resume into a guess.
Kiso's whole design is the third option: the trajectory itself is the
durable artifact, so a killed process costs you nothing but the process.

- **Event-sourced sessions.** Every run is an append-only JSONL stream of
  `seq`-numbered events under `$KISO_HOME/sessions`. The messages a model
  sees are a pure function of the log (ADR-0002) — a session is a file you
  can read, replay, and audit, not runtime state that dies with the
  process. `kiso resume <id>` continues the interrupted trajectory in a
  fresh process, contiguously.
- **Durable human approvals.** A verdict — allow, deny, rerun, abandon —
  is a persisted fact, recorded with what decided it (ADR-0024). Kill the
  process and the already-decided calls are never re-asked: the resume
  applies the durable verdicts, and a policy's `decide` is never re-run
  for a call it already decided.
- **Crash-consistent execution.** Tool calls carry durable receipts keyed
  by `executionId` (ADR-0025). A confirmed success is never re-run; an
  execution that started and never reported is `uncertain` and blocks
  until a human decides — the only honest answer to "did the side effect
  apply?" The original run then completes; it does not replay.

The consequence: the session, the verdicts, and the side effects' truth
are already on disk before the crash — the next `kiso resume` asks only
what the crash window made unknowable. The kill-9 section below shows the
scripted proof.

## The durable execution contract

**The session format is a frozen contract, enforced by gates** — not a
versioned API that can drift. The freeze (ADR-0051, adjudicated by the
review, 2026-08-12) classifies every recorded event shape and pins the
invariants below to executable gates that run in `npm run check`. The
canon names live in ADR-0047 §7 / ADR-0051 §7; the public names below
are what this README uses.

| public name | what it guarantees |
| --- | --- |
| **Prefix-Complete Recovery** | the session can always be resumed from its durable prefix — every prefix a real published bin wrote loads, validates, projects, and derives a recovery plan (the generation gate, ≥4 real generations) |
| **Ambiguity Never Auto-Repeats** | an execution that started and never reported stays the human's decision — never auto-rerun, never silently re-asked |
| **Committed Intent Before Effect** | a tool call is decided and persisted before any effect; an approval is a durable fact, never a memory |
| **Durable Start Before Side Effect** | a handler never runs before its STARTED receipt is persisted — a crash cannot leave an unreported effect |
| **Stable Intent Identity** | the three identities (callId / invocationSeq / executionId) are never conflated; derived state is never persisted |
| **Single Durable Truth** | the event stream is the single truth; everything else is derived from it, and every event is kernel-owned |
| same-facts-same-projection | the same prefix projects to the same bytes on any given version (the prompt-cache byte discipline); the model-request surface evolves only by declared supersession (ADR-0051 Amendment 3) |
| exactly-one-terminal | every run converges on exactly one terminal — its last event |

The contract's ask semantics: **a pending ask lives iff its invocation
is not voided and the derivation can still execute it** — approval
verdicts are durable, whether decided directly by the human or by a
policy the human installed (ADR-0051 §8).

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
  packages/core/src/kernel/loop.ts    742
  packages/core/src/protocol/events.ts 438
  packages/core/src/kernel/project.ts 353
  ...
  total                               1971  / 2000
  ✓ 29 lines of headroom remaining.

cli:
  apps/cli/src/chat.ts  478
  apps/cli/src/index.ts 382
  ...
  total                 1870  / 1920
  ✓ 50 lines of headroom remaining.

tui:
  packages/tui/src/compositor.ts 986
  packages/tui/src/editor.ts     535
  ...
  total                          1761  / 2400
  ✓ 639 lines of headroom remaining.

tui-cells:
  packages/tui-cells/src/components.ts 618
  ...
  total                                1116  / 1280
  ✓ 164 lines of headroom remaining.
```

(The cli gate's single 2400 terminal cap was replaced by per-package gates
when the terminal layer was extracted into @vincemakes/kiso-tui — the
ADR-0041 escape hatch, ADR-0043. Each gate = actual + 20%. The gates today:
core 2,000, cli 1,920, tui 2,400, tui-cells 1,280. Every re-baseline was an
adjudicated ruling; the cli's 1,920 (ADR-0043 Amendment 6) is its LAST
recalibration before 1.0 — the next approach, argued or not, defaults to
extraction.)

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@vincemakes/kiso-core`, ≤ 2,000 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · hooks · compaction · modes · permissions) · L3 tool (contract · registry · real JSON Schema validation) · L7 eval hooks (delivery truth) |
| **packages** (unbounded) | `@vincemakes/kiso-evals` (faux provider · incident fixtures · contract tests) · `@vincemakes/kiso-provider-anthropic` · `@vincemakes/kiso-provider-openai` · `@vincemakes/kiso-runtime` (durable sessions, approvals) · `@vincemakes/kiso-tools-node` (file/search/edit/shell) · `@vincemakes/kiso-tui` (the pure terminal layer — cell renderer, dock, raw editor, diff; zero runtime deps, input is data / output is bytes — reusable standalone, API still 0.x semantics) · `@vincemakes/kiso-tui-cells` (the components cell renderer, extracted from the tui — the ADR-0041 escape hatch) · the four official extensions (`@vincemakes/kiso-mcp-ext` · `@vincemakes/kiso-skills-ext` · `@vincemakes/kiso-subagent-ext` · `@vincemakes/kiso-task-ext` — the first three ship INSIDE the CLI, task is opt-in, see Extensions) · `@vincemakes/kiso-code` (the flagship coding agent) |

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
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
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

This is `examples/hello-agent.ts` (faux adapter there — zero keys) and the
consumer smoke test compiles and runs it in a clean project against the
packed tarballs. `scripts/hero-check.mjs` keeps the two in sync: any drift
in either direction turns the check red.

- Packages build to plain ESM JavaScript + `.d.ts` — installed artifacts run
  on any Node project, no tsx, no source access (`scripts/smoke.mjs` proves it
  in a clean temp project every check).
- `npm run demo` runs the raw-loop REPL; the flagship coding agent is the CLI.
- Every fixture in `@vincemakes/kiso-evals` is a real production incident (uooki, 2026);
  the loop is proven against them, not just against happy paths — and the
  fixtures run on the real session runtime, not a test harness.

## Support

Node **>= 22** (the OpenAI-compat provider and the CLI declare it in `engines`).

## The CLI — the flagship coding agent

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
  pattern is legacy, supported.

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
⚠ interrupted execution: shell (ex-12) — did it apply? (y)es / (n)o y
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

The same story as a scripted demo: `scripts/demo-kill9.sh` runs it against
the published binary — two consecutive runs, a fresh `KISO_HOME` each, all
green.

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

**Three official extensions ship built-in in the CLI** (0.1.45+):
`mcp`, `skills`, and `subagent` are registered at startup by module
import — a fresh install has all three with zero disk setup, and the
banner says so: `[3 extensions: built-in: mcp, skills, subagent]`.

The fourth official extension, **task** (durable long-horizon working
memory), is **opt-in since 0.3.0**: on 13 consecutive real-provider
sessions it paid its rent on every request and was never called — not
even on the planning guidance's own designed trigger (measured dead
weight, findings E5-F1/E5-F2). Its capability is preserved: install it
per the Task section below.

On top of the built-ins, the classic layers still load, in cascade order:
**built-in → user → project**. An extension is a plain `.mjs` file — no
SDK, no build step. kiso scans `~/.kiso/extensions/*.mjs` at startup
(`KISO_EXTENSIONS_DIR` overrides) and names what loaded in the startup
banner. Loading is **loud**: a broken file or a duplicate extension name
fails the process at startup with the file name — an extension that cannot
load must never silently change behavior.

- **A user extension may SHADOW a built-in by name** — loudly: the
  built-in leaves the loaded set and the banner drops it
  (`[extensions] user extension "mcp" shadows the built-in — the built-in
  is not loaded`). Your copy, your rules.
- **A project extension may NOT shadow a built-in** — a project extension
  whose name collides with a built-in is refused with a loud error: a
  repo you cloned must never silently replace the CLI's own behavior.

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
  which must not answer for the human; ruling A, the E1 ask semantics fix); only an
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
kiso chat     # → [4 extensions: built-in: mcp, skills, subagent · safe-defaults]
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
- The status bar names the current tier in the dim status row — `plan`
  reads `plan (read-only)`, so the constraint is visible at a glance
  rather than encoded in a hue (KC3: the identity is monochrome).
- This is kiso's answer to Claude Code's permission modes: a CLI-side
  policy layer over the same extension approval chain — user extensions
  keep their votes on every call, and their denies always win.

## MCP — external tools over the MCP bridge

**Ships built-in in the CLI** — every `kiso chat` has the `mcp__` bridge
loaded already, no install step. `extensions/mcp` is the official
extension's source: self-host or customize by building and copying
`dist/kiso-mcp.mjs` into `~/.kiso/extensions/` (a user copy shadows the
built-in, loudly). The bridge is an ordinary extension — a self-contained
single file (the MCP SDK inlined) — with the four kernel packages
untouched:

```
cd extensions/mcp && npm install && npm run build   # only to self-host/customize
cp dist/kiso-mcp.mjs ~/.kiso/extensions/
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

**Ships built-in in the CLI** — the `delegate` tool is loaded at startup,
no install step. `extensions/subagent` is the official extension's source:
self-host or customize by copying `dist/kiso-subagent.mjs` into
`~/.kiso/extensions/` (a user copy shadows the built-in, loudly). The
extension is a zero-dependency single file — no SDK, no build step beyond
the copy:

```
cd extensions/subagent && npm install && npm run build   # only to self-host/customize
cp dist/kiso-subagent.mjs ~/.kiso/extensions/
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

**Ships built-in in the CLI** — skills load at startup, no install step.
`extensions/skills` is the official extension's source: self-host or
customize by copying `dist/kiso-skills.mjs` into `~/.kiso/extensions/`
(a user copy shadows the built-in, loudly):

```
cd extensions/skills && npm install && npm run build   # only to self-host/customize
cp dist/kiso-skills.mjs ~/.kiso/extensions/
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

## Task — durable long-horizon working memory

**Opt-in since 0.3.0** (it shipped built-in from 0.1.45 to 0.2.2; on 13
consecutive real-provider sessions it paid its rent on every request and
was never called — not even on the planning guidance's own designed
trigger, findings E5-F1/E5-F2 — so it left the default composition).
`extensions/task` is the official extension's source
(`src/kiso-task.mjs` — source IS the product, no build step); install or
customize by copying it into `~/.kiso/extensions/` (a plain user
extension — task is no longer a built-in, nothing to shadow):

```
cp extensions/task/src/kiso-task.mjs ~/.kiso/extensions/
```

A plan-carrying session keeps its durable plan on resume under the new
default — the plan lives in the log, not the extension. The edge: with
the extension absent there is no `task_set` to *update* the plan; the
opt-in restores it.

The `task_set` tool is a whole-table replace (the CC TodoWrite shape):
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
  banner: `[5 extensions: built-in: mcp, skills, subagent · safe-defaults · project: lint-rules, mcp]`), its
  `mcp.json` merges with your user config (a server name in both is a loud
  startup error), and its skills merge into the skills scan (a skill name
  in both: project wins, one stderr note). A project extension whose name
  collides with a built-in is refused with a loud error — a cloned repo
  must never silently replace the CLI's own behavior.
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
| built-in extension layer | the three default official extensions load in-process at startup (E5: task is opt-in); a user copy shadows loudly | `apps/cli/tests/builtin-layer.test.ts` |
| MCP bridge | official extension — built-in since 0.1.45, kernel untouched | `extensions/mcp/tests` |
| subagents | official extension — built-in since 0.1.45, role-policy children | `extensions/subagent/tests` |
| skills | official extension — built-in since 0.1.45, two-tier progressive | `extensions/skills/tests` |
| task | official extension — opt-in since 0.3.0 (built-in 0.1.45–0.2.2), durable long-horizon working memory (task_set) | `extensions/task/tests`, `apps/cli/tests/task-e2e.test.ts` |
| context economy ● | microcompact + /compact (model summary) + prompt-cache discipline | `packages/core/tests/prompt-cache.test.ts`, `summarize.test.ts` |
| project `.kiso` trust | content-digest gate, one ask, sticky refusal | `apps/cli/tests/project-trust.test.ts` |

The bench, one fixture, one model (deepseek-v4-flash), interleaved
same-day runs, order rotated per round — the 2026-08-16 three-way
comparison (kiso 0.4.0, the published artifact via npx · pi 0.84.2 ·
Claude Code 2.1.233 via DeepSeek's Anthropic-compatible endpoint).
Medians: n=3 per tool on T3, n=2 per tool on T5:

| task | tool | fresh in | cached in | total in | cost-wtd | out | reqs | wall |
|------|------|--------:|--------:|--------:|--------:|----:|----:|----:|
| T3 cross-file rename | **kiso** | 711 | 11,392 | **12,138** | **1,885** | 750 | **5.0** | **10s** |
| | pi | 3,494 | 18,176 | 20,247 | 4,800 | 1,184 | 6.0 | 12s |
| | claude | 38,591 | 222,592 | 261,392 | 61,059 | 2,069 | 15.0 | 30s |
| T5 8-turn session | **kiso** | 7,844 | 130,048 | **137,892** | **20,849** | 5,386 | 32.5 | **72s** |
| | pi | 6,190 | 279,424 | 285,614 | 34,133 | 7,282 | 35.0 | 92s |
| | claude | 303,406 | 1,464,640 | 1,768,046 | 449,870 | 16,530 | 54.0 | 259s |

**Headline.** On **T3**, the hardest small task, **cost-weighted input**
(fresh + 0.1×cached — DeepSeek's cache-hit price ratio, see
`bench/README.md`): kiso 1,885 vs pi 4,800 = **2.55×** and vs Claude
Code 61,059 = **32×**, all nine T3 runs verify-pass with identical task
outcomes. On **T5**, the 8-turn session: kiso 20,849 vs pi 34,133 =
**1.64×** and vs Claude Code 449,870 = **21.6×** — measured at one
session length. Honest attribution for T5: kiso's own cost is FLAT
versus the previous record (20,849 vs 19,941 — inside the historical
band); the widened ratios there are substantially rival-side movement
(pi 23,660 → 34,133; Claude Code 120,440 → 449,870 at 30 → 54 turns on
its newer version). kiso's T3 improvement is its own (2,211 → 1,885,
the E5 default-composition cut).

**The previous records live in git history and `bench/README.md`.** The
2026-08-12 round (kiso 0.2.0 · pi 0.84.1 · CC 2.1.227: T3 2.1×/19×, T5
1.2×/6.0×) is the prior same-protocol record; the 2026-08-10 comparison
(11× and 66×) came from an earlier protocol generation — its kiso cells
were measured on 0.1.41, before the 0.1.45+ built-in extension layer
and the trust surface (the same protocol files produce kiso T3 cells in
the ~1,900–2,400 band since the 0.1.48 re-baseline). The 2026-08-16
runs live in `bench/runs/` (gitignored — the numbers in this table and
in `bench/README.md` are the committed record); the old tables live in
this README's git history,
and the protocol change is recorded in `bench/README.md`.

Honest footnotes (from `bench/README.md`): these tasks are SMALL — Claude
Code's large system prompt buys real product capability (task tracking,
richer exploration) that pays off on complex work these tasks do not
exercise; Claude Code ran off-label (DeepSeek endpoint) and its prompts
are tuned for Claude models; the runs are SERIAL — each later run rides
the provider's server-side warm cache, so the fresh columns are the
unstable ones; n=3 per tool on T3, n=2 per tool on T5, one fixture per
task, one model, token accounting normalized per provider convention
(kiso's input total INCLUDES cache-hit input; pi and Claude Code report
fresh-only); kiso is our own tool — reproduce it yourself, everything
needed is in `bench/`.

**No growth claims.** These are point measurements at one or two session
lengths; this README deliberately claims nothing about how the ratios
scale with session length. What kiso's own long-session data shows is
reported honestly in `bench/README.md` (including the dedicated
long-session divergence study) — it is not extrapolated here.

## Status

**The Durable Execution Contract is frozen** (ADR-0051, the 0.2.x line): the
session format and its recovery semantics are contract, every invariant
enforced by the gates below, and the version line is the semver public
promise of that ABI (ADR-0051 Amendment 1). The road here: the
reliable-session alpha and its four hardening rounds (areas 1-7, A-F,
one through nine, and the fourth adversarial round — see
`docs/plans/2026-08-03-reliable-session-alpha.md`), the **kiso code**
round (the coding agent: kill -9 gate, microcompact, byte discipline —
`docs/plans/2026-08-04-kiso-code.md`), the **extensions** round (E1:
the approval-policy extension system; E2: the compaction parameter and
systemPrompt append surfaces — `docs/plans/2026-08-04-extensions-e1.md`),
and the durability line R-E→R-H (the straddle ruling, recovery as
projection, the dead-holder takeover, the freeze itself). Everything
below is proven by a gate in `npm run check`:

- **core** (1,971/2,000 lines) — protocol, loop (single honest terminal;
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
  seamless rolling upgrade (the fifth round P1-4), strict
  load, contiguous-seq validation) / `session.resume()` continues the
  INTERRUPTED run across processes: durable approvals are applied (the
  original call executes once, denials write their result), missing
  receipts are filled, and the original run completes — no invented turns /
  `loadExtensions(dir)`: every *.mjs default export (or factory), loud
  startup failure on a bad file or duplicate name; extension tools merge
  into the registry (built-in collision = startup error), hooks compose
  AFTER the harness's own (existing-first), approvals enter the policy chain.
- **cli** (1,870/1,920 lines) — the coding agent: bare `kiso` enters chat;
  the startup extension scan — the built-in layer first (the three default
  official extensions load in-process by module import: mcp, skills,
  subagent; E5: task is opt-in — a user copy shadows loudly, a project
  copy is refused), then
  `~/.kiso/extensions/*.mjs` (banner `[3 extensions: built-in: mcp,
  skills, subagent]`, user names appended bare, project ones marked
  `project:`);
  a system prompt (coding-agent discipline: read before edit, careful
  shell) composed from a constant, with AGENTS.md/CLAUDE.md injected and
  truncated at 8KB; one-line tool summaries per call
  (`✓ edit src/foo.ts (+12 -3)` / `✗ shell npm test (exit 1)`), the status
  line (`[turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]` — usage
  events only, unknown fields omitted entirely, faux mode shows
  `[turn N · faux]`), and `/last` to print the most recent tool call's
  full input/output straight from the event stream. The first-run scaffold
  (0.1.45): the trust verdict is a fresh home's FIRST access of any kind —
  only after the grant does the config surface materialize (`config.json`
  + the sentinel), silently, and a sentinel-marked home never re-scaffolds
  or clobbers your config. v2a/v5/KC3 — **the identity is monochrome**:
  shades of black and white carry the interface, and colour is reserved
  for the three things that MEAN something. Bright-white BOLD (SGR 1) is
  the accent (the you> prompt, the banner tagline, ✓ marks, command
  names, the user block's ▍ rail, the input brick); a light-gray
  inline-code tint (256 color 252) marks backtick spans in assistant
  text; dim carries metadata. The functional exceptions are the only
  colour left in the interface: green for the approval diff's additions
  and red for errors — with yellow reserved for warnings under the same
  rule (the palette has no yellow entry today). Everything else is
  plain; `NO_COLOR` or a
  pipe disables it all (pipes carry zero ANSI); typed input is echoed by readline itself,
  never rendered twice; a spinner glyph shows liveness between the request
  and the first delta. v2b: thinking blocks fold to ONE dim line per block
  (first 100 chars + ` (… /think shows full)`, `/think` prints the last
  complete block), the `[result]` echo truncates at 160 chars +
  ` (/last for full)` — the content strategy is the same in pipes; on a
  color TTY the UI docks to the bottom (ADR-0039): four pinned rows — an
  upper dim separator, the `▌` input line, a lower separator, and a LIVE
  status bar (idle `▸ <mode> · /mode to switch · …` with the right-aligned
  dim `/ commands · ↑ history` hint — cut first when the window is
  narrow; running `▖ working Ns · esc stop · alt+⏎ redirect · …`); the body scrolls
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
  kiso brick motif: a bold half-block ▌you> row and a dim dotted ╌
  separator; the sent line renders into the body exactly once, a turn
  submitted while another runs queues with a live `+N queued` status, and
  Esc aborts. KC1: the input is a MULTI-LINE composer — a paste keeps its
  newlines (LF/CR/CRLF all normalize to one), Ctrl+J (or Shift+Enter where
  the terminal encodes it) inserts a newline, Enter sends the whole block
  as ONE turn, and the box grows to at most 6 rows before scrolling
  internally. KC2: **Alt+Enter (or Ctrl+Enter) REDIRECTS** — one gesture
  aborts the running turn and sends what you just typed instead, ahead of
  anything already queued; Esc alone still just stops. KC3: **`@` opens a
  fuzzy file picker** — typed at a word boundary (never mid-word, so an
  email address stays an address), it lists the project's files above the
  composer: a case-insensitive subsequence match over the whole relative
  path, ranked by the longest contiguous run then the shortest path, the
  matched characters bold, five rows at a time with a `(n/total)` counter
  that says so when the list was capped. ↑↓ select, Tab or Enter accepts,
  Esc closes and leaves your sentence alone. Accepting inserts the
  **canonical path and nothing else** — never the file's contents: the
  model gets a reference it can choose to read, so an `@` mention costs a
  path instead of a file, and `read_file` pays only for the bytes it
  actually needs. The list is `git ls-files` (tracked + untracked, minus
  everything ignored) in a repo, a bounded walk outside one, and it is
  computed per open — no index, no daemon, no watcher.
  Known limitation: emoji ZWJ clusters are not width-perfect.
  Pipes keep readline byte-for-byte. v2d (ADR-0040): the body becomes a
  cell renderer — ONE writer owns the scroll region (event handlers only
  mutate cells, so interleaving is impossible by construction); completed
  cells freeze once, unfinished cells render in an active tail at the
  region's bottom and redraw in place; a tool's life is ONE line
  (`→ name summary` → ⏸ → running spinner + Ns → `✓ name (summary, 1.2s)`),
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
  provider-anthropic, provider-openai, tui, tui-cells, the four official
  extension packages (three default-built-in + task opt-in), cli — 13
  npm surfaces), ESM + d.ts, exact-pinned
  internal versions (per-package counters, pinned at each release); CI is
  clean-checkout `npm ci` + the full gate.

`npm run check` = build → typecheck (packages + root scripts + tests) →
tests → size gate (core 2,000 + cli 1,920 + tui 2,400 + tui-cells 1,280) →
pack gate (dist + README + LICENSE in every tarball) → whitespace gate (no
trailing whitespace, every file ends with a newline) → CJK gate (the tracked
tree stays CJK-free — `README.zh.md` is the only exemption)
→ `git diff --check` on the working tree and the index
→ consumer smoke tiers (runtime, NESTED install, providers, CLI, nested
  CLI with real Anthropic/OpenAI env)
→ demo start-and-exit gate. **918 tests green (128 files)**. 37 ADRs (index: `docs/adrs/README.md`).
6 incident fixtures running on the real runtime.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
