# kiso

**kiso(基礎) — a growable TS agent framework.** A 2,000-line core that owns what
genuinely repeats, and packages that grow on top of it without limit.

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

  packages/core/src/kernel/loop.ts  560
  packages/core/src/protocol/events.ts 389
  ...
  total                               1714  / 2000

  ✓ 286 lines of headroom remaining.
```

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@kiso/core`, ≤ 2,000 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · hooks · compaction · modes · permissions) · L3 tool (contract · registry · real JSON Schema validation) · L7 eval hooks (delivery truth) |
| **packages** (unbounded) | `@kiso/evals` (faux provider · incident fixtures · contract tests) · `@kiso/provider-anthropic` · `@kiso/provider-openai` · `@kiso/runtime` (durable sessions, approvals) · `@kiso/tools-node` (file/search/edit/shell) · `@kiso/cli` (the coding-agent reference product) |

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
import { defineTool } from "@kiso/core";
import { createAgent, SessionStore } from "@kiso/runtime";
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
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
- Every fixture in `@kiso/evals` is a real production incident (uooki, 2026);
  the loop is proven against them, not just against happy paths — and the
  fixtures run on the real session runtime, not a test harness.

## Support

Node **>= 22** (the OpenAI-compat provider and the CLI declare it in `engines`).

## The CLI — the coding-agent reference product

The CLI is a real npm package — install it or run it directly:

```
npx @kiso/cli chat
```

(Inside this repo, `npm run cli` runs the same binary.) The command set:

```
kiso chat [sessionId]          interactive multi-turn session
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions                  list durable sessions
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

## Status

Reliable Session Alpha, including the four hardening rounds (areas 1-7,
A-F, 一-九, and the 第四轮 adversarial round), is complete (see
`docs/plans/2026-08-03-reliable-session-alpha.md`):

- **core** (1,714/2,000 lines) — protocol, loop (single honest terminal;
  missing/duplicate stops and tool_use-without-a-call are structured
  errors; retry only before anything streamed; one abort signal reaches
  backoff, approval waits, every pending tool, and the SDK), hooks,
  ModeProfile, permissions, microcompact, delivery truth, the lossless
  event-log projection (messages are a pure function of the log,
  ADR-0002), and the execution ledger keyed by framework `executionId`
  (ADR-0025): a failed non-idempotent execution is UNCERTAIN until a
  human decides — a confirmed success is never re-run, a new logical call
  always runs.
- **runtime** — `createAgent` / durable multi-turn sessions / crash-safe
  JSONL store (torn-tail repair under a cross-process writer lock, strict
  load, contiguous-seq validation) / `session.resume()` continues the
  INTERRUPTED run across processes: durable approvals are applied (the
  original call executes once, denials write their result), missing
  receipts are filled, and the original run completes — no invented turns.
- **cli** — `kiso chat|resume|sessions`; resume is the recovery flow
  (uncertain executions are decided rerun/abandon, approvals pause and
  ask); coding tools are bound to the workspace root (absolute paths,
  `..`, and symlink escapes are refused); the approval prompt shows the
  full shell command and full paths.
- **workspace** — publishable monorepo (core, evals, runtime, tools-node,
  provider-anthropic, provider-openai, cli), ESM + d.ts, synchronized
  internal versions; CI is clean-checkout `npm ci` + the full gate.

`npm run check` = build → typecheck (packages + root scripts + tests) →
tests → size gate (core only) → pack gate (dist + README + LICENSE in every
tarball) → whitespace gate (no trailing whitespace, every file ends with a newline)
→ `git diff --check` on the working tree and the index
→ consumer smoke tiers (runtime, NESTED install, providers, CLI, nested
  CLI with real Anthropic/OpenAI env)
→ demo start-and-exit gate. 294 tests green. 11 ADRs. 6 incident fixtures
running on the real runtime.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
