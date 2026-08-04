# kiso

**kiso code = the coding agent that survives `kill -9`.** Interrupted
executions get human verdicts, approvals persist across processes, and every
event is auditable and replayable — the whole trajectory is on disk, and
`kiso resume` continues it exactly.

**kiso(基礎) — a growable TS agent framework for building coding agents and
durable multi-turn AI tools.** A 2,000-line core that owns what genuinely
repeats, and packages that grow on top of it without limit. For TypeScript
developers who want a real agent framework — event-sourced sessions, durable
human approvals, exactly-once tool execution — without a 50k-line runtime.

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

```
$ npm run size

core:
  packages/core/src/kernel/loop.ts  630
  packages/core/src/protocol/events.ts 406
  ...
  total                               1804  / 2000
  ✓ 196 lines of headroom remaining.

cli:
  apps/cli/src/index.ts  496
  apps/cli/src/render.ts 166
  ...
  total                   662  / 1200
  ✓ 538 lines of headroom remaining.
```

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@vincemakes/kiso-core`, ≤ 2,000 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · hooks · compaction · modes · permissions) · L3 tool (contract · registry · real JSON Schema validation) · L7 eval hooks (delivery truth) |
| **packages** (unbounded) | `@vincemakes/kiso-evals` (faux provider · incident fixtures · contract tests) · `@vincemakes/kiso-provider-anthropic` · `@vincemakes/kiso-provider-openai` · `@vincemakes/kiso-runtime` (durable sessions, approvals) · `@vincemakes/kiso-tools-node` (file/search/edit/shell) · `@vincemakes/kiso-cli` (the coding-agent reference product) |

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
npm install -g @vincemakes/kiso-cli
kiso chat          # after the global install, the command is `kiso`
npx @vincemakes/kiso-cli chat   # or run without installing
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
- Sessions are append-only JSONL under `$KISO_HOME/sessions` — exit, restart,
  `kiso resume <id>`, and the conversation continues with a contiguous seq.
- Keyless faux mode out of the box; `ANTHROPIC_API_KEY` (or
  `OPENAI_API_KEY` + `OPENAI_BASE_URL`) switches to a real provider.
- Interrupted side effects are surfaced on resume (`⚠ interrupted execution`)
  and block until a human resolves them — a confirmed success never re-runs.

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

When a long session's projected context crosses the threshold (50% of the
model window by default, configurable), the loop appends **one** `microcompacted`
boundary event to the stream — never a per-turn progressive clearing. The
projection then derives the compacted view deterministically: tool results
older than the boundary whose tool is in the whitelist (`read_file`,
`list_dir`, `search_text`, `shell`) are replaced by the fixed placeholder
`[old tool output cleared: <tool> <arg>]`. write/edit outputs are never
touched; results tagged `do-not-compact` are never touched; recent turns
stay intact.

The decision is a persisted fact, not runtime state: the same events always
derive the same messages — a crash/resume replays the boundary and lands on
the byte-identical projection (see the byte discipline below). No counting
API, no price table, no tokens spent on the compaction itself.

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

## Status

Reliable Session Alpha, including the four hardening rounds (areas 1-7,
A-F, 一-九, and the 第四轮 adversarial round), is complete (see
`docs/plans/2026-08-03-reliable-session-alpha.md`), and the **kiso code**
round (the coding agent: kill -9 gate, microcompact, byte discipline) is
done (see `docs/plans/2026-08-04-kiso-code.md`):

- **core** (1,804/2,000 lines) — protocol, loop (single honest terminal;
  missing/duplicate stops and tool_use-without-a-call are structured
  errors; retry only before anything streamed; one abort signal reaches
  backoff, approval waits, every pending tool, and the SDK), hooks,
  ModeProfile, permissions, microcompact (a `microcompacted` boundary is a
  persisted fact — the projection derives the compacted view
  deterministically; whitelist read/list/search/shell, `do-not-compact`
  respected, recent turns intact), delivery truth, the lossless event-log
  projection (messages are a pure function of the log, ADR-0002 — and the
  prompt-cache byte discipline: the same event prefix projects to the same
  message prefix, byte for byte, pinned by three regression tests), and the
  execution ledger keyed by framework `executionId` (ADR-0025): a failed
  non-idempotent execution is UNCERTAIN until a human decides — a confirmed
  success is never re-run, a new logical call always runs.
- **runtime** — `createAgent` / durable multi-turn sessions / crash-safe
  JSONL store (torn-tail repair under a kernel-flock cross-process writer
  lock — upgrade requires QUARANTINE: stop every old-format process before
  starting the new version; the pidfile guard is best-effort, not a
  seamless rolling upgrade (第五轮 P1-4), strict
  load, contiguous-seq validation) / `session.resume()` continues the
  INTERRUPTED run across processes: durable approvals are applied (the
  original call executes once, denials write their result), missing
  receipts are filled, and the original run completes — no invented turns.
- **cli** (662/1,200 lines) — the coding agent: bare `kiso` enters chat;
  a system prompt (coding-agent discipline: read before edit, careful
  shell) composed from a constant, with AGENTS.md/CLAUDE.md injected and
  truncated at 8KB; one-line tool summaries per call
  (`✓ edit src/foo.ts (+12 -3)` / `✗ shell npm test (exit 1)`), the status
  line (`[turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]` — usage
  events only, `?` when unknown, `~` marks the estimate), and `/last` to
  print the most recent tool call's full input/output straight from the
  event stream. `resume` is the recovery flow (uncertain executions are
  decided rerun/abandon, approvals pause and ask); coding tools are bound
  to the workspace root (absolute paths, `..`, and symlink escapes are
  refused); the approval prompt shows the full shell command and full
  paths. The **kill -9 gate** (`apps/cli/tests/kill9.test.ts`) SIGKILLs a
  real chat mid-execution and resumes it in a fresh process — see the
  section above.
- **workspace** — publishable monorepo (core, evals, runtime, tools-node,
  provider-anthropic, provider-openai, cli), ESM + d.ts, synchronized
  internal versions; CI is clean-checkout `npm ci` + the full gate.

`npm run check` = build → typecheck (packages + root scripts + tests) →
tests → size gate (core 2,000 + cli 1,200) → pack gate (dist + README +
LICENSE in every tarball) → whitespace gate (no trailing whitespace, every
file ends with a newline)
→ `git diff --check` on the working tree and the index
→ consumer smoke tiers (runtime, NESTED install, providers, CLI, nested
  CLI with real Anthropic/OpenAI env)
→ demo start-and-exit gate. 342 tests green. 11 ADRs. 6 incident fixtures
running on the real runtime.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
