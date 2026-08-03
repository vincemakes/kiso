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

  src/protocol/events.ts       112
  src/protocol/messages.ts      55
  ...
  total                       1152  / 2000

  ✓ 848 lines of headroom remaining.
```

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@kiso/core`, ≤ 2,000 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · 9 hooks · compaction · modes · permissions) · L3 tool (contract · registry · repair · concurrency) · L7 eval (faux provider · incident fixtures) |
| **packages** (unbounded) | session (append-only + seq restore) · CLI · settings + built-in tools · extensions. Each package is small and owns its identity; packages talk through the event stream and hooks, not through a central hub |

The core stays a kernel: it decides nothing that repeats across products. The
framework around it is where product-shaped capability grows — and that growth
is the point, not a violation. See ADR-0021.

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
import { createAnthropicAdapter } from "@kiso/core/adapters";
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

- The core imports zero runtime dependencies; provider SDKs are optional
  peers (`@kiso/core/adapters` subpath).
- `npm run demo` runs a REPL — faux provider by default, real Anthropic with
  `ANTHROPIC_API_KEY` set.
- Every fixture in `tests/fixtures/` is a real production incident
  (uooki, 2026); the loop is proven against them, not just against happy
  paths.

## Status

M0–M3 are in: protocol, kernel (loop · hooks · ModeProfile · permissions ·
microcompact), dual adapters (Anthropic / OpenAI-compat), governance (delivery
truth from the ledger, never from model self-report) — 43 tests green, 6 ADRs,
6 incident fixtures, an end-to-end REPL demo. `npm run check` = typecheck +
size gate + tests.

**Roadmap:**

- **G1** `@kiso/session` — append-only session log, restore from `seq`
- **G2** CLI 完整化 — `/compact`, resume, REPL polish
- **G3** settings + built-in tools (behind the permission gate)
- **G4** extensions · **0.1.0 on npm**

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
