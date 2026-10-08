# ADR-0057: Safe Admission — new input enters a running run only at a quiescent boundary

- **Status:** **Accepted** (§8 "no autonomous runs" overturned in part by the chain budget, 2026-10-06 — see the amendment at the end) — ratified by the owner on 2026-09-28, in
  their own words, together with Appendix A (the estimator leaving core,
  approved explicitly). Rev 2: rev 1 went through one external review and
  its four findings are applied (ingress sealing, the `maxTurns`
  eligibility rule, human vs runtime admission, the crash matrix's
  wording). Nothing is built yet; the code follows in its own round, red
  tests first. Baseline: **0.44.0** (released 2026-09-28, `74101d92`).
- **Implementation:** three steps — 2a the kernel seam and the `Run`
  ingress (the tests of §"Gates" 1–14 and the crash rows), 2b the HTTP
  transport (test 15), 2c the CLI. Released together as 0.45.0.
- **Owner rulings this ADR records (2026-09-28, in the owner's words in
  chat):** Enter while a run is live is a steer; there is no queue; steer
  is taken out of the parked in-run injection family and enters the
  roadmap now; same-run admission rather than "abort + new run".
- **Layer:** the kernel loop (one new admission seam), the runtime `Run`
  (an ephemeral ingress), the HTTP transport (one route), the CLI (Enter
  becomes steer). The kernel budget is paid by ADR-0043 Amendment 13
  (Appendix A), which moves one incumbent out of core; the cap stays
  2,200.
- **Companion:** ADR-0058 (Tasks) reuses this admission for task notices
  and supplies the "detach" that lets a steer pass a long foreground
  command.

## The hazard, first

**This ADR lets input reach the model while a run is still working.**
Two failures follow from getting the boundary wrong, and both are silent:

1. **Input admitted while an effect is in flight.** The model reasons
   about a world that has not settled. The only mid-run gesture kiso has
   today, the redirect, avoids that by aborting — and the abort is what
   manufactures uncertain executions: a tool killed mid-effect leaves an
   outcome nobody knows, and the next turn must ask the person first
   (KC2 §4).
2. **Input the host saw but the log did not.** Across a crash it is
   either lost without a trace or delivered twice.

Safe Admission answers both with one rule: **input may ARRIVE at any
time, but it is ADMITTED — made a durable fact that affects the next
model request — only at a quiescent boundary.** Arrival is intent;
admission is the fact.

## What the product does today, verified in the tree

| | |
|---|---|
| the documented stance | `docs/architecture.md:367` — "No mid-stream steering, no durable queue … input lands between runs" |
| the Run's definition | `docs/architecture.md:166` — "§5 Run — one user turn" |
| the redirect | `apps/cli/src/chat.ts:1591` — aborts the run, then submits the text as the next turn ahead of the queued ones |
| the queue | `apps/cli/src/chat.ts:1643` — `pendingTurns`, ephemeral process state; each line becomes an ordinary `user_input` of a later run |
| the cost of the redirect | `apps/cli/src/chat.ts:1763` — the fresh-turn uncertainty gate: an abort mid-tool leaves an uncertain execution the person must resolve before the next turn starts |
| the turn head | `packages/core/src/kernel/loop.ts:585` — abort check, then the END_TURN scan (`:590`), `maxTurns` (`:603`), the compaction point (`:609`), `onPreLlm` (`:621`), the request |
| a turn without tool calls | `loop.ts:~975` — ends the run on its own stop reason; nothing is asked of anyone |
| a turn with tool calls | the committed stop, then `drainSettled()`: every started execution lands its receipt before the next turn head |
| `onUserMessage` | runs ONCE, at the run's start, on the run's input (`loop.ts:211–258`); a veto persists `user_input_replaced(null)` and ends the run `completed` (`:256`) |
| the projection | already holds a `user_input` until outstanding call/result pairs resolve (`packages/core/src/kernel/project.ts:253`) |
| recovery | already treats `user_input` as a committed boundary (`packages/runtime/src/recovery-plan.ts:54`); a durable input with nothing after it recovers as `CONTINUE_MODEL` |

The last two rows are why this is smaller than it sounds: the log shape
"committed turn, receipts, then a `user_input`, inside one run" is one
the projection and the recovery already accept. What is missing is a
place in the loop that admits input, and a definition of when that is
legal.

## Decision

### 1. Definitions

- **Arrival** — the host hands the runtime input for the active run.
  Arrived input is ephemeral: it is held in memory by the `Run` and is
  not part of any trajectory.
- **Admission** — the kernel appends the input as a `user_input` event,
  persisted before it is yielded (the existing write-ahead path). From
  then on it is the only truth about that input.
- **Quiescence** — the state in which admission is legal:
  1. the current model turn is committed (ADR-0052), or no model turn
     has started;
  2. no permission decision is unresolved;
  3. no tool invocation is running or waiting to launch;
  4. every started execution has its receipt;
  5. no draft is pending a void.

  Condition 2 is stated separately on purpose: a call waiting for
  approval has not started, so "every started execution has a receipt"
  alone would call that state quiescent. It is not.
- **Eligibility** — quiescence is necessary, not sufficient. Admission
  also requires that the run may issue another model request: it is not
  aborted, and `turns < maxTurns`. **Hard limits win over admission;
  END_TURN does not.** An input admitted into a run that can no longer
  ask the model would be a durable user turn that is never answered.
- **Sealing** — the moment the run decides to end, its ingress closes.
  From then on nothing can be admitted, and `run.steer()` rejects (§5).

### 2. The Run, redefined — DECLARED REVERSAL

**Overturns** `docs/architecture.md` §5 ("Run — one user turn") and the
sentence at `:367` ("input lands between runs"), because a steer is only
worth having if it changes the work in progress, and ending the run to
deliver it (the "safe yield + new run" variant, considered and dropped on
2026-09-28) buys nothing the log needs: the log shape is the same minus
a terminal, and task notices (ADR-0058) could not use it without writing
a terminal that says `aborted by user` when no person stopped anything.

New text: **a Run is one continuous foreground execution, from its
initial input to exactly one terminal. It may admit further input at
Safe Admission boundaries.** A model turn is still a model turn; a user
input is still a user input; the words stop being synonyms for "run".

**Also overturns, for steer only,** the owner's 2026-09-26 parking of the
in-run injection family (product ledger #10). The owner lifted it for
steer on 2026-09-28. The rest of the family — a turn-end continuation
hook, a durable inbox — stays parked.

### 3. The three admission sites

Admission is attempted at exactly three places, through one helper:

| site | where | why |
|---|---|---|
| A | a tool turn has settled — after the committed stop and `drainSettled()`, at the next turn head: after the abort check, **only if `turns < maxTurns`**, and **before the END_TURN scan** | a result tagged END_TURN must not end the run over input that has already arrived; the admitted `user_input` also stops the scan, which already walks back only to the latest `user_input`. `maxTurns` is checked first because it wins |
| B | a turn with no tool calls, before its terminal, if eligible | a steer sent while the model writes its final answer continues the same run instead of becoming the next one — one rule, whatever the timing. This site **takes or seals** atomically (below) |
| C | after request-mode compaction, before `onPreLlm` | a steer that arrives during a long in-band summary is seen by the very next request; the compaction itself is never cancelled |

**Sealing closes the terminal race.** `terminal()` awaits `onStop`
before it appends the terminal (`loop.ts:194–199`), so without a seal a
steer could be accepted after the last check and land in a run that is
already ending — and a transport's `202` would be a lie. Therefore:

- at site B the runtime answers atomically: pending input is taken and
  the run continues, or the ingress is sealed and the run ends;
- every other terminal (END_TURN, `max_turns`, abort, error) seals the
  ingress first, inside the terminal helper;
- input that arrived but was not admitted when the ingress sealed is
  handed back to the host with the terminal — never dropped in silence.
  The host starts a new run with it (the CLI does so itself).

The overflow path (`why === "overflow"`) is untouched: it keeps its own
error semantics, and a refusal-driven compaction does not admit.

Nothing is admitted mid-stream. The model's output is never cut for
input, and no started effect is ever cancelled by a steer.

### 4. The kernel seam

```ts
// LoopConfig
readonly admit?: (mode: "take" | "takeOrSeal" | "seal") => Promise<readonly AdmissionInput[]>;

interface AdmissionInput {
	readonly kind: "human" | "runtime";
	readonly content: string | readonly ContentBlock[];
	readonly source?: MessageSource;
	readonly via?: UserInputVia;
}
```

Sites A and C call `admit("take")`, site B `admit("takeOrSeal")`, the
terminal helper `admit("seal")`. For each returned input the kernel:

1. appends and yields a `user_input` (existing event, no new variant);
2. **if `kind` is `"human"`,** runs `onUserMessage` on it exactly once,
   persisting the existing `user_input_replaced` event — the same code
   path as the run's initial input, factored into one helper. **A
   `"runtime"` input skips the hook:** it is a fact the runtime owes the
   model (a task's terminal, ADR-0058), and an extension that could veto
   it could make the model believe a finished task still runs;
3. re-derives the messages.

**A veto of an admitted human input drops that input and the run
continues.** This differs from the initial input, whose veto ends the
run `completed` because there is nothing left to do; the helper takes
the difference as a parameter and the code says why. A rewrite projects
the replacement at the input's position, as today.

The kernel does not know the words "steer" or "task" — only "a person's
input" and "the runtime's input". `admit` absent is byte-identical
behavior: no call, no event, no new branch taken.

Estimated cost: 18–24 counted lines (the helper, three call sites, the
seal in the terminal helper, the config field), paid for by Appendix A.

### 5. The runtime: an ephemeral ingress on `Run`

- **`run.steer(content)`** — the Run holds arrived human input in memory
  and serves it to `admit()`. It never owns durable state: the log owns
  what was admitted. A second host (the HTTP transport, an IDE) gets the
  identical semantics by calling the same method — nothing to
  re-implement (`docs/architecture.md:84`).
- **Batching.** All human input pending at a site becomes ONE
  `AdmissionInput` of kind `"human"` whose content is the lines in
  arrival order, one text block each. One hook call, one event, one new
  user turn for the model. **Batches are homogeneous:** runtime notices
  (ADR-0058) form their own `"runtime"` batch and are never merged with
  a person's words.
- **Crash before admission loses arrived input.** Stated, not hidden:
  pending steers are in memory until a site admits them. After admission
  the `user_input` is durable. A durable inbox stays parked.
- **After the ingress seals**, `run.steer()` rejects with a typed
  `RunClosed`; input still pending at the seal is returned with the
  terminal. Either way the host starts a new run with the text. The CLI
  does this itself, so the person sees no difference.
- **A pending approval** keeps the run non-quiescent: the steer waits.
  The steer never answers an approval for the person.
- **A long foreground command** would keep the run non-quiescent for its
  whole duration. When a steer arrives while a detachable execution runs
  (a shell, per ADR-0058 §2), the runtime asks it to detach through its
  TaskManager (ADR-0058 §6) — never through the host: the process
  continues as a Task, the tool call returns "continued as task t17",
  the run reaches quiescence, and the steer is admitted. Non-detachable
  executions (edits, approvals) are waited for. Esc remains the hard
  stop.

### 6. The HTTP transport and the client

`POST {prefix}/:id/steer` with a body `{ content }` → `202` when the
active run's ingress accepted it, `409 { reason: "idle" | "closed" }`
otherwise (the host starts a run). `202` means accepted, not admitted:
an accepted steer is either admitted (its `user_input` appears on the
stream) or returned in the terminal frame as not admitted. The client
gains `steer(sessionId, content)`. Both are additive; no existing route
changes.

### 7. The CLI

- **Enter during a run = steer.** The steer row reads
  `◇ steer <text> · lands at the next step`, or
  `· delivers after approval` while an approval is open.
  *As built (2c):* the Graphite restyle is its own round, so v1 keeps
  today's chip rows (the dim `□` gutter) for steers that have not landed,
  and the status hint is `+N steer` — a longer hint does not fit beside
  the running status at 80 columns and would be dropped whole. While an
  approval panel is open the panel owns the status row, so the "after
  approval" variant has no row to ride; the chips stay.
- **No queue.** The pending-turn queue (`pendingTurns`, the W22 chips)
  is removed. **Overturns** the Graphite spec's `tab` = queue (its §7
  "waits on the inbox" row), by the owner's ruling of 2026-09-28.
- `↑` on an empty editor pulls back steers not yet admitted.
- **Esc** aborts the run exactly as today; steers not yet admitted return
  to the editor.
- **alt+Enter** keeps today's hard redirect (abort + send). Steers that
  had not landed ride the correction as ONE next message, the correction
  first (KC2 §3: it corrects them).
- A run that seals with steers still pending (`max_turns`, an END_TURN
  result, an error) hands them back; the CLI sends them at once as the
  next turn — they are the person's next message.

### 8. What this ADR does not do

No stream injection, no cancellation of started effects, no durable
inbox, no turn-end continuation hook, and no autonomous runs — waking an
idle session belongs to ADR-0058 and is bounded there.

## Recovery: the crash matrix

| kill -9 at | durable state | on restart |
|---|---|---|
| after arrival, before admission | nothing about the steer | the run recovers as today; the steer is lost (stated in §5) |
| after the seal, before the terminal is persisted | no terminal | the run recovers as an open run, exactly as today; the returned steer was never admitted, so nothing refers to it |
| after the `user_input` is persisted, before the hook's replacement | the input, no replacement | the run recovers to the turn head; the hook runs once for that input (the existing "at most once per input" rule, keyed by the replacement event) |
| after admission, before the request | input (+ replacement) | `CONTINUE_MODEL`; the model answers the steer |
| during the request that carries the steer | input + a draft | the draft is voided as today; `CONTINUE_MODEL` re-asks with the steer |

**Safe Admission itself introduces no new uncertainty:** it only acts
at quiescence, so no execution is in flight when an input is admitted.
Executions that start after the admitted input — the next request may
well call tools — keep the ordinary execution-ledger semantics,
uncertainty included.

## Gates and evaluation (pre-registered)

**Causal tier (BM-1 §3):** an execution/recovery round. The crash matrix
above and the kill -9 gates block. Request bytes: a run with no admission
must be byte-identical to 0.44.0 (the trace-bytes gate, extended with a
no-`admit` and an empty-`admit` case). The live paired bench is
informational for this ADR alone; **if it ships in one release with
ADR-0058's tool-schema change, the strictest tier applies and the paired
bench blocks.**

**Red→green tests the implementation must carry:**

1. A steer that arrives while an effect executes: the effect settles with
   its receipt; the steer is admitted after it, never before.
2. A result tagged END_TURN plus a pending steer: the steer is admitted
   and the run continues.
3. A steer during a final answer (no tool calls): admitted at site B; no
   terminal between.
4. A steer during request-mode compaction: the compaction completes; the
   next request carries the steer.
5. Overflow compaction with a steer pending: overflow semantics
   unchanged.
6. Three steers before one site: one `user_input`, three text blocks, one
   `onUserMessage` call.
7. A vetoed steer: `user_input` + `user_input_replaced(null)`; the run
   continues; the next request equals the request without the steer.
8. A steer while an approval is open: not admitted until the decision is
   durable.
9. A steer during a detachable foreground shell: the shell becomes a
   Task, the call's result says so, then the steer is admitted.
10. No `admit`, and an `admit` returning `[]`: request bytes identical to
    0.44.0.
11. The five crash-matrix rows, by kill -9.
12. **The terminal race:** a steer accepted while `onStop` is awaited is
    never admitted into the ending run; it is returned with the terminal,
    and `run.steer()` after the seal rejects with `RunClosed`.
13. **`maxTurns` wins:** a steer pending when the run reaches its limit
    is not admitted; the run ends `max_turns` and returns the steer.
14. **A runtime input skips the hook:** an extension whose
    `onUserMessage` vetoes everything still sees a `"runtime"` input
    admitted and projected; a `"human"` input is still vetoed.
15. **The transport never lies:** every `202` steer is either admitted or
    listed as not admitted in the terminal frame.

## Declared reversals (summary)

| overturned | by | reason |
|---|---|---|
| architecture §5 "Run — one user turn" | §2 | a run may admit input at quiescence |
| architecture `:367` "input lands between runs" | §2 | same |
| ledger #10 parking, for steer only | owner, 2026-09-28 | steer entered the roadmap |
| Graphite spec §7, `tab` = queue | owner, 2026-09-28 | no queue |
| the ADR-0043 Amendment 11 ledger row for `compaction.ts` ("must") | Appendix A | its tenancy ended with ADR-0044 |

## Open for review

1. The name of the seam (`admit`) and of the Run method (`steer`) — the
   method is the product word on the SDK surface; the kernel stays
   generic.
2. Whether the transport should return the admitted `user_input`'s seq
   in a later frame, so a remote host can mark a steer "landed".

(Rev 1's question "should site B admit at `max_turns`?" is settled by
the eligibility rule: no.)

---

## Appendix A — the kernel budget

Recorded as ADR-0043 Amendment 13 and landed first (#172): the token
estimator, which the kernel never called, left core for the runtime
(2,198 → 2,161), so this ADR's seam fit under the unmoved 2,200 cap.
The seam landed at +24 counted lines (2,161 → 2,185), the top of the
18–24 estimate.

## Amendment 1 (2026-10-06; trimmed 2026-10-07) — §8's "no autonomous runs" is overturned in part

An idle session may wake on a task's terminal many times in a row, under
a budget derived from the log (`maxWakes` autonomous wakes since the last
run a person started, default 20; ADR-0058 Amendment 9). §8's other
clauses stand: no stream injection, no cancellation of started effects,
no durable inbox, no turn-end continuation hook. The crash rows above are
unchanged. (As first written this amendment named ADR-0059's waits — a
timer, a host-registered event — as wake sources; ADR-0059 is withdrawn,
and a task's end is the only one.)
