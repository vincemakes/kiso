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

  packages/core/src/kernel/loop.ts  170
  packages/core/src/protocol/events.ts 116
  ...
  total                                764  / 2000

  ✓ 1236 lines of headroom remaining.
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
import { defineTool, ToolRegistry, loop } from "@kiso/core";
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const registry = new ToolRegistry();
registry.register(defineTool({
  name: "add",
  description: "Add two numbers",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
}));

for await (const ev of loop({
  adapter: createAnthropicAdapter(new Anthropic()),
  model: "claude-sonnet-5",
  registry,
  messages: [{ role: "user", content: "What is 2+3?" }],
})) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "terminal": console.log("\n", ev.outcome); break;
  }
}
```

- Packages build to plain ESM JavaScript + `.d.ts` — installed artifacts run
  on any Node project, no tsx, no source access (`scripts/smoke.mjs` proves it
  in a clean temp project every check).
- `npm run demo` runs a REPL — faux provider by default, real Anthropic with
  `ANTHROPIC_API_KEY` set.
- Every fixture in `@kiso/evals` is a real production incident (uooki, 2026);
  the loop is proven against them, not just against happy paths.

## Status

Reliable Session Alpha in progress (see `docs/plans/2026-08-03-reliable-session-alpha.md`):

- **core** done: protocol, loop (single terminal, retry in-frame, abort
  check before execute), 9 hooks, ModeProfile, permissions, microcompact,
  delivery truth — 43 tests green, 8 ADRs, 6 incident fixtures.
- **workspace** done: publishable monorepo, ESM + d.ts build, consumer smoke.
- **runtime** (durable multi-turn sessions, approvals, exactly-once recovery)
  and **cli** (`kiso chat|resume|sessions`, coding tools) in progress.

`npm run check` = build → typecheck (all packages incl. tests) → tests →
size gate (core only) → pack gate → consumer smoke.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
