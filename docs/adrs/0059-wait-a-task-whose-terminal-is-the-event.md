# ADR-0059: `wait` — a run may end on a future event and resume on it

- **Status:** **Withdrawn** (2026-10-07, Amendment 1 at the end) — the
  `wait` tool, the wait profile and the GitHub drivers are removed before
  any release shipped them; **the chain budget stays**, now recorded as
  ADR-0058 Amendment 9. Originally accepted: the direction, "a wait is a
  task", the three overturns below and the chain bound were ruled by the
  owner on 2026-10-05 and 2026-10-06, in their own words in chat.
- **Date:** 2026-10-06
- **Layer:** `packages/runtime` (the task journal, the TaskManager, the
  delivery), `packages/tools-node` (the `wait` tool), `apps/cli` (two
  wait drivers over `gh`, one setting, one label). **No kernel line:**
  `packages/core` is untouched and `npm run size` reads what it read.
- **Baseline:** 0.46.0 (`a9102120`), after #221 and #223.

## The hazard, first

**This ADR lets a session run again with nobody having typed.** Today an
idle session wakes at most once after a person's message, when a task
the model started ends (ADR-0058 §8, guard 3). After this ADR a session
can wake many times in a row, days apart, on timers and on events in
other systems. Two failures follow from getting that wrong, and both are
silent:

1. **A chain that never ends.** A model that waits, wakes, and waits
   again is a loop with no person in it. The bound is not a timeout on
   the loop; it is a budget on autonomous wakes per person's message,
   derived from the log, and a deadline on every wait, in the record.
2. **A promise with nothing behind it.** The failure this ADR exists to
   close: the model says "I will tell you when CI is green" and the
   runtime has no way to run it again. The cure is not to forbid the
   sentence; it is to give it a mechanism, and to tell the model that a
   sentence without the mechanism is not a promise.

## What the product does today, verified in the tree

- A task's terminal in an idle session starts ONE continuation run whose
  first input is the notice (`runtime/src/tasks/delivery.ts`, `onWake`;
  the CLI wires it at `apps/cli/src/chat.ts`, `queueTurn`).
- A task started inside that wake run never wakes — lineage depth 1
  (`#startedInWakeRun`).
- The only terminals are a process's end, a service's ready line, a
  runner vanishing, and a start that never ran. Time and other systems
  cannot end a task.
- A terminal missed across a restart is delivered as a notify at the
  next run a person starts, never a wake at startup (`delivery.ts`, the
  constructor).

## Decision

### 1. A wait is a task

A wait is a task record with `profile: "wait"`. Its `planned` record
carries the wait (`source`, `deadlineAt`, `note?`, `goalId?`); its
terminal is `wait_fired { eventId, payload }` or `wait_expired`, or the
ordinary `stop_requested` + `terminal` when stopped. Everything
downstream is ADR-0058's as it stands: write-ahead order, the journal's
verdict, the delivery's batching and exactly-once receipts
(`user_input.via.items`), the task row, `task_stop`.

**The stated deviation.** `via.items[].transition` is core's closed
union (`ready | exited | failed | stopped | unknown`). A fired wait rides
as `exited`, an expired one as `failed`; the notice line itself says
`fired`, `expired` or `stopped`, and the model reads the line. Widening
the union is one kernel line and is not taken in this release.

### 2. Sources and drivers

A wait names a source by `kind`. The runtime owns two drivers:

| kind | fires when | identity |
|---|---|---|
| `timer` `{ ms }` | `plannedAt + ms` has passed (its deadline IS its fire time) | the fire time |
| `task` `{ id }` | that task ends (or has ended already) | the task and its transition |

Every other kind is a host's driver, registered on the TaskManager
(`drivers`), never on the kernel's extension contract. The CLI registers
two over `gh`:

| kind | fires when | payload |
|---|---|---|
| `gh-checks` `{ pr, repo? }` | every check on the PR's current head has a conclusion | `subject`, `version` (`sha:<head>`), the checks verbatim |
| `gh-review` `{ pr, repo? }` | a review or comment that did not exist at registration appears | `subject`, `version`, the new reviews and comments |

Polling, every 60 s, no tokens; a `gh` failure is retried, never fatal.
Webhooks are a later release. **The payload carries what was observed,
never a summary; the `version` is what the evidence is about** — a
fired checks wait for one head sha says nothing about the next push.

### 3. The autonomy bound — the rulings this overturns, named

- **ADR-0057 §8** ("no autonomous runs — waking an idle session belongs
  to ADR-0058 and is bounded there") — **overturned in part.** An idle
  session may wake on a wait's terminal, under the bound below.
- **ADR-0058 §8 guard 3** ("lineage depth 1") — **overturned.** A chain
  needs run 3 to wake after run 2. Replaced by:
  - **the chain budget** — at most `maxWakes` autonomous wakes since the
    last run a person started (default 20; the CLI setting `maxWakes`,
    the host option `useTasks({ maxWakes })`). The count is the wake
    runs in the log (a run whose first input is a runtime notice),
    never a counter. Past the budget a terminal delivers as a notify,
    its line saying "chain budget spent", and the person's next message
    resets the count;
  - **the deadline** — every wait expires (24 h default, 7 d cap); an
    expiry is a terminal that delivers like any end — never silent (the
    §8 invariant holds);
  - **the switch** (§8 guard 4) stays: `taskWake: false` turns every
    wake into a notify.
  One rule for every terminal — a background command's end inside a
  wake run follows the same budget.
- **ADR-0058 §10** ("no scheduled or recurring tasks") — **overturned
  for one-shot timers.** No recurrence.

### 4. The restart rule, kept

A wait is re-armed from its journal when a TaskManager opens on the
session's task directory. One whose time had already passed resolves at
once, marked `overdue`, and the delivery treats an overdue terminal as a
notify — the existing "never a wake at startup" rule. Whether an overdue
event may wake on restart is a later release's decision (it needs a
resident host).

### 5. The tool

`wait({ for: { kind, … }, deadlineMs?, note?, goalId? })`, in the coding
toolset beside `task_stop` whenever tasks are wired. It returns at once
("waiting as t7 …"); its guideline tells the model to finish its message
and stop, and never to poll for what it can wait on. `goalId` is on the
schema from day one and unused until release 2a.

### 6. The notice

One batch, as every ADR-0058 delivery:

```
<kiso-wait id="t7" status="fired" kind="gh-checks" pr="207" duration="22m03s"/>
{"subject":"github:pr#207","version":"sha:…","checks":[…]}
Runtime notice — not the user.
```

The payload rides verbatim, capped at 4 KiB.

## Recovery: the crash rows (runtime tests, `tasks-wait.test.ts`)

| kill -9 at | durable state | on restart |
|---|---|---|
| W2 while waiting on a timer | `planned` with the wait | re-armed; overdue fires once, `overdue`, delivered notify at the next person's run |
| W3 after the driver observed the event, before the terminal | `planned` | the driver observes again; one terminal (identity) |
| W4 after the terminal, before delivery | `planned` + `wait_fired` | delivered once (ADR-0058 §7) |
| W5 the same state observed twice | — | one terminal; the second observation is a no-op |
| W6 after the wake run started, before its first request | the `user_input` | `CONTINUE_MODEL` (ADR-0057 SA2) |
| W7 the budget: kill between the 20th wake and its record | — | derived from the log, never a counter |

W1 of the round spec cannot occur: `planned` is written before the
driver is armed; a crash before it leaves no wait and no effect.

## Evaluation before release (BM-1 §3), pre-registered

**Tier:** a tool-schema change (the `wait` tool) plus an execution
change → the request-byte gates, the paired bench and the crash matrix
block.

**Static rent:** the `wait` schema and one guideline line, estimated
90–130 tokens per request at the cache-read price.

**Paired bench, candidate vs 0.46.0, interleaved:** T3 and T5 with the
frozen margins. **New fixtures, same task on both arms:** W-A a timer
chain; W-B a checks chain over a fake `gh` that flips after N polls (no
live GitHub in the bench). **Counted on every leg:** wakes per chain,
the cold-prefix cost of each wake (the first request's fresh input),
expired waits, and — informational — final messages that promise a
future action with no wait registered.

Paid runs start only on the owner's word about the spend.

## What this ADR does not do

No resident host (a chain lives while the kiso process lives — a TTY
left open, or a session hosted by kiso-server); no webhooks; no `any`/
`all` over several waits; no recurring timers; no goal record (release
2a); no verdict on "done" (release 3); no kernel line.

## For hosts

- `TaskManager({ drivers })` registers wait drivers; `waitKinds()` lists
  them; `wait()` registers a wait.
- `session.useTasks(manager, { maxWakes })` — a host that relied on "one
  wake" sets `maxWakes: 1`.
- `ShellTasks.wait` / `waitKinds` are optional: a host that wires neither
  gets a `wait` tool that answers "waits are not available".
- `TaskState` gains `waiting`; `ended` may carry `wait: { outcome }`.

## Amendment 1 (2026-10-07) — withdrawn; the chain budget stays

**The owner's ruling (2026-10-07, in chat):** the `wait` tool is
withdrawn before it ships. Removed: the model-facing `wait` tool, the
`wait` task profile (its records, verdict, notice line and re-arm), the
`timer` / `task` drivers, the CLI's `gh-checks` / `gh-review` drivers,
`ShellTasks.wait` / `waitKinds`, `TaskManager({ drivers })`. Kept: the
chain budget (`maxWakes`, the setting and the host option) — ADR-0058
Amendment 9.

**Why.** Every case `wait` served is already a task. A foreground command
that outlives its wait becomes a background task and wakes the session
when it ends (ADR-0058 ruling 2): `gh pr checks <pr> --watch` waits for
CI and exits with its verdict; `sleep 1200` is a timer; a polling script
waits for a review; `timeout` gives any of them a deadline. With the
chain budget those wakes chain. What the tool added beyond that — no
process held while waiting, a structured payload, a deadline in the
record — did not pay for its rent: +150 tokens on EVERY request of a
session with tasks (measured, round wait-r1), whether or not it ever
waited, against a cost-weighted gain no round measured.

**What round wait-r1 still taught, kept:** the paired bench's noise on
the Command Code route (two runs of one comparison: +43.6% and −3.3%),
which is why the 0.48.0 gate runs at least 12 pairs per set and treats
any other count as INVALID; and "a discriminating run must prove its
premise before it is frozen".

This ADR keeps its number and its text above, as every withdrawn ADR
does (the immutability rule); the README's count of ADR files is
unchanged.
