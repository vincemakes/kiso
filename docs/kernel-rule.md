# The kernel rule — the 2,200-line core and the two layers

The README states the rule in three lines. This is the rule, the size
report it prints on every check, the two-layer split it produces, and the
list of things the core deliberately refuses to own.

## The rule

> The core cannot exceed **2,200 lines**. Any PR that pushes it over gets
> closed, however good the feature is. CI enforces this before it installs a
> single dependency.
>
> If you need more, grow a package. That is the point.
>
> The gate is a snapshot discipline, not a self-adjusting ratchet:
> recalibration happens only by adjudicated ruling and only for
> spec-mandated growth — the standing escape hatch is EXTRACTION (ADR-0043).
> It has moved exactly twice, each by adjudicated amendment: 2,000 → 2,100
> (Amendment 9, the F4 kernel round) and 2,100 → 2,200 (Amendment 10, the
> MG-1 round — the frozen continuation shapes and their trust boundary are
> kernel by definition).

```
$ npm run size

core:
  packages/core/src/kernel/loop.ts      888
  packages/core/src/protocol/events.ts  473
  packages/core/src/kernel/project.ts   360
  ...
  total                                2139  / 2200
  ✓ 61 lines of headroom remaining.

cli:
  apps/cli/src/index.ts     771
  apps/cli/src/chat.ts      730
  apps/cli/src/dispatch.ts  411
  ...
  total                    3660  / 1920
  ▸ 1740 over the reference figure — report-only (ADR-0043 Amendment 8).

tui:
  packages/tui/src/compositor.ts   1323
  packages/tui/src/editor.ts       1068
  packages/tui/src/panel-input.ts   406
  ...
  total                            3887  / 4000
  ✓ 113 lines of headroom remaining.

tui-cells:
  packages/tui-cells/src/components.ts      825
  packages/tui-cells/src/md.ts              497
  packages/tui-cells/src/approval-panel.ts  369
  ...
  total                                    2575  / 1280
  ▸ 1295 over the reference figure — report-only (ADR-0043 Amendment 8).
```

(The rule above binds THE CORE — the hard budget is the design; it
moves only by adjudicated amendment, and has done so once. The product surfaces run a different regime since
ADR-0043 Amendment 8: the cli/tui/tui-cells figures are REFERENCE
figures, printed on every check for visibility but never failing it —
their protection moved to the architecture gates (the TUI never owns
durable truth, TUI state is droppable, interactive behavior carries
PTY proof, public surfaces carry surface gates) and to the
four-question gate every UX round's spec answers: does it reduce human
friction · does it preserve truth semantics · does it add measured
rent · can it be deterministically PTY-tested. The amendment history —
the extraction hatch, the recalibrations — lives in ADR-0043.)

Comments do not count. Explain freely; implement tersely.

## What this is

A framework, in two layers:

| Layer | Owns |
|---|---|
| **core** (`@vincemakes/kiso-core`, ≤ 2,200 lines) | L1 protocol (event sum type with `seq` · message union · adapter contract) · L2 kernel (loop · hooks · compaction · permissions) · L3 tool (contract · registry · real JSON Schema validation) · L7 eval hooks (delivery truth) |
| **packages** (unbounded) | `@vincemakes/kiso-evals` (faux provider · incident fixtures · contract tests) · `@vincemakes/kiso-provider-anthropic` · `@vincemakes/kiso-provider-openai` · `@vincemakes/kiso-provider-openai-responses` · `@vincemakes/kiso-runtime` (durable sessions, approvals) · `@vincemakes/kiso-tools-node` (file/search/edit/shell) · `@vincemakes/kiso-tui` (the pure terminal layer — cell renderer, dock, raw editor, diff; zero runtime deps, input is data / output is bytes — reusable standalone, API still 0.x semantics) · `@vincemakes/kiso-tui-cells` (the components cell renderer, extracted from the tui — the ADR-0041 escape hatch) · the five official extensions (`@vincemakes/kiso-mcp-ext` · `@vincemakes/kiso-skills-ext` · `@vincemakes/kiso-subagent-ext` · `@vincemakes/kiso-ask-ext` · `@vincemakes/kiso-task-ext` — the first three ship INSIDE the CLI, ask joins them on an interactive terminal, task is opt-in, see [extensions.md](extensions.md)) · `@vincemakes/kiso-code` (the flagship coding agent) |

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
2,200-line cap does not bind them. A core that decides them for you is a blob,
and a blob is the thing you eventually fight.
