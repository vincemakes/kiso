# kiso

**kiso(基礎) — the agent kernel that actually works.** ~2,000 lines. Read it in one sitting.

The smallest agent kernel that actually works: distilled from reading Claude Code,
[pi](https://github.com/badlogic/pi-mono), and
[oh-my-pi](https://github.com/can1357/oh-my-pi) at the source level — and from running
three agent products in production on its validated predecessor (mauri, Python).

Every design decision ships with an ADR explaining **why**, and **when to overturn it**.

## The rule

> The core will never exceed **2,000 lines**. Any PR that pushes it over gets closed,
> however good the feature is. CI enforces this before it installs a single dependency.
>
> If you need more, fork it. That is the point.

```
$ npm run size

  src/protocol/events.ts       62
  src/protocol/messages.ts     45
  ...
  total                       110  / 2000

  ✓ 1890 lines of headroom remaining.
```

Comments do not count. Explain freely; implement tersely.

## What this is

A kernel, not a framework. It owns the four contracts that genuinely repeat across
every agent product:

| Layer | Owns |
|---|---|
| **L1 Protocol** | Event sum type (with `seq`) · message union · adapter interface |
| **L2 Kernel** | The loop · hooks · compaction · pause/resume |
| **L3 Tool** | Tool contract · registry · repair · concurrency |
| **L7 Eval** | Faux provider · cross-provider matrix |

Two properties the harness gets for free:

- **Replayable trajectories** — every event carries a monotonic `seq`; a run is
  the replay of `seq` 0..N. Eval fixtures, incremental UI, and skill
  distillation all consume the same stream. See ADR-0002.
- **Honest terminals** — every run ends with exactly one `Terminal` event;
  an API error never wears the reason `completed`. See ADR-0004.

## What this is not

Loop *business logic*. UI. Permission policy. Billing. Skills content. Retrieval.
Session persistence. Those are yours. A kernel that decides them for you is a
framework, and a framework is the thing you eventually fight.

## Status

Early. The protocol layer (events / messages / adapter) is in, with ADRs
0001-0005 + 0020. The kernel, tools, adapters, and eval harness are being
ported from the validated Python implementation (mauri). Not usable yet —
watch the repo if you want the first release.

## Why another one

Because every agent framework hands you code and API docs, and none of them hand you
the reasoning. When the model changes next quarter and a design decision stops paying
for itself, the docs cannot tell you which one to pull out. The ADRs can.

## License

MIT
