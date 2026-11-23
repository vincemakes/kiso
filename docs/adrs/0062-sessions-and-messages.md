# ADR-0062: Sessions and messages — Works that find, start and talk to each other, and the person's line into a running Work

- **Status:** Accepted (the owner, 2026-11-19). Shipped in 0.55.0, with the sessions extension
  off by default (`KISO_WEB_SESSIONS=on` turns it on; § 15's ship gate holds it there until the
  choice eval passes). Built 2026-11-16..17 through PRs #469–#481 into the integration branch
  `feat/messages`, with the follow-ups #484–#502, and merged into `main` once by #500. § 16 is the
  record of what was built. Drafted 2026-11-16 from the sessions design draft, adding the three
  runtime bounds an outside review of that draft asked for and the steer (§ 10), which the owner put
  in the same series. Baseline: `origin/main` e2a3dc43 (0.54.2).
- **Owner rulings this ADR records** (chat, 2026-11-05 and 2026-11-16):
  1. Three model tools, `list_sessions`, `start_session`, `message`, as one
     optional **sessions extension**, in Works the web host creates only.
     Files travel in `message` as local paths; no fourth tool.
  2. Messages are free: any Work to any Work it can reach, across folders,
     no permission, no per-turn count cap.
  3. `start_session` starts when the person asked in words, asks when the
     person named a task, and cards the model's own idea (reversing the
     2026-11-05 "card only").
  4. A child that `start_session` started wakes its parent when it ends a
     turn, at once, never waiting for siblings.
  5. A message from a narrower sender to a wider receiver is held for the
     person.
  6. Messages and handoffs show as default-collapsed rows; the receipt card
     is withdrawn.
  7. The model must know when to use `delegate` and when `start_session`,
     proven by a choice eval before ship.
  8. The design draft's crash-window rule and its web host counting the
     wake budget accepted.
- **Ruled 2026-11-16:** the durable inbox, the capacity defaults, S2, S3,
  the core line (§ 12). Nothing is open.
- **Layer:** runtime (inbox, delivery, wake, hold), web host (addressing,
  roster, cards, the counter), renderer (rows, cards, the steer), and a few
  lines of the core protocol (§ 12).
- **Companions:** ADR-0057 (Safe Admission: every incoming line enters at
  its boundary), ADR-0058 (Tasks: wake, delivery, Amendment 9's chain
  budget), ADR-0038 (the crash window).

## 1. Context

The owner runs one leader Work and many execution Works in kiso web, and
today relays between them by hand. A measuring round came first (stale
facts between Works turned out to be rare), then the design draft settled
what is worth building: Works that can find each other, start each other within the
person's authority, say things to each other, and report back without
polling. The draft was checked against the reference implementation's
session and message tools as a live session sees them, and took an outside
review. This record does not re-argue the draft; it fixes the contract and
the tests.

One position runs through it: **Works talk as peers; the parent link only
carries the automatic report.** Nothing forces a supervisor tree.

## 2. The extension, and how a Work is addressed

**The table.** Eleven built-ins become fourteen in a Work the web host
creates with the extension on; eleven everywhere else. **Amendment 1 (owner, 2026-11-20, § 17) reverses what follows:
a Work follows the host that opens it; the paragraph is kept as the record of what was first built.** The table is part
of the execution profile, fixed at creation, never changed mid-session (no
provider is asked to accept a tool addition; the prefix cache holds). A
web-created Work resumed in the terminal keeps its table; there each of
the three tools refuses with a reason the model can act on ("this needs
kiso web; tell the person, or continue without it") and no side effect.

**How "fixed at creation" is kept** (found while planning PR 1, on
2937a2d3). The execution profile records each tool's name and hashes but
does not fix the table: every process rebuilds its registry from its own
definition, and a recorded tool it lacks becomes a drift note nothing
reads (`profile.ts`, `assessProfileDrift`). So the fixing is done by a
**marker**: a sidecar tenant `origin: "web"` written when the web host
creates a Work (a Work with no records yet), carried by
`writeForkSidecar`. The web host gives the extension to a marked Work
when the extension is on; the terminal registers, for a marked Work, the
same three tools with the same schemas, each refusing as above. An
unmarked Work (created in the terminal) gets the extension nowhere. Until
the tool-schema round the extension is off by default
(`KISO_WEB_SESSIONS=on` turns it on), so default requests do not change.
The web host today carries no skills, ask or MCP extension; its table is
the coding tools plus the policy guards, and the sessions extension joins
those.

**The address.** A session id is minted per folder (a timestamp and four
hex digits, `2026-11-15T11-21-51-a78e`): unique within its folder, not
across folders, and it does not say where the Work lives. So the runtime
never addresses by id alone:

```ts
type SessionAddress = { readonly spaceKey: string; readonly sessionId: string };
```

`spaceKey` is the folder key the host's `spaces` map already uses
(`projectDirFor(home, workspace)`). Message ids, inbox location, causality
stamps, parent links and dedupe all use the full address. The model sees
titles and short refs only; the host resolves them.

**`list_sessions({ query? })`** — read-only: every Work the host can
reach, across folders, one line each: title, short ref, folder, state
(running, idle, waiting on the person, open in the terminal), last active;
most recent first; `query` matches titles. It is a tool result, paid only
when called. A short ref is the shortest unique suffix of the address the
host can print; a `to` that matches two Works is refused, naming both.

## 3. `message({ to, text, files? })`

**Delivery is the runtime's choice**, from the receiver's state; the model
never picks it:

| receiver | delivery |
|---|---|
| running | admitted at its next ADR-0057 boundary (the turn head, before the next model request), batched with everything else waiting |
| idle, host live | a wake: a run on the receiver's own log |
| no live host (web down, or open in the terminal) | the durable inbox (§ 4); admitted when the Work next opens |

A message never interrupts a tool execution. The sender's log records the
send; the receiver's log records the admission; the message id dedupes
across the three paths.

**One admission per message** (review M3). A boundary may admit several
messages, but each is its own `user_input` event carrying its own
`messageId`, all before the one model request that follows: each has its
own durable proof, its inbox file is confirmed and deleted on its own, and
a replay dedupes each. `Run.#admit` today merges neighbouring task notices
into one input (`run.ts`); peer entries are never merged, with each other
or with notices. The kernel already takes a list of admission inputs per
boundary, so this needs no loop change.

**What the receiver's log holds.** A message is admitted as a runtime
input, never as the person's: `source: "system"` and `via: { kind:
"peer", event: "message", from, messageId, rootId }` (§ 12; title and files
in the runtime's record keyed by `messageId`). It never
passes `onUserMessage`, and the model reads it framed as a message from
the named Work. A message cannot pose as the owner.

**Capacity** (the outside review's M2: the wake budget bounds runs, not
messages between two running Works or an inbox's growth). Proposed
defaults, each a host setting:

| bound | default | past it |
|---|---|---|
| one message's text | 16 KB | the send is refused with the size |
| `files` per message | 20 paths | refused |
| pending messages in one inbox | 200 or 1 MB, whichever first | the send is refused: "the receiver's inbox is full; send later" |
| one admission batch | 32 KB of message text | the rest stays queued, oldest first, for the next boundary |

A send that returned success is never dropped afterwards. There is still
no cap on how many messages one turn sends; the bounds are on what a
receiver must hold.

**The capacity check is atomic** (review M4): counting the inbox and
publishing the new file happen under the inbox's lock (the lock-file
pattern kiso already uses), so three senders racing for the last slot
cannot all win. An inbox's size is the bytes of its complete message
records (text, paths, revisions, stamp), not the text alone, so long path
lists cannot slip past the 1 MB bound.

**`files`** — local absolute paths; every Work is on one machine, so a
file is sent as its path, never copied:

- each must exist, and must be readable **by the sender** under its own
  file policy, or the send is refused naming it;
- the host records each file's revision (the file tools' own rev id;
  hashed streaming for a large file, never read whole into memory);
- the receiver reads with its own tools under its own policy; a path never
  widens what it may read; contents enter its context only when it reads;
- a reference, not a delivery: a deleted file cannot be opened; the
  receiving model reads each path with its revision when sent, so a read
  printing another revision is a changed file (v1, #480: nothing computes
  "changed since" for it).

**No file UI** (owner, 2026-11-16: "a file sent is only an address given
to the model; whether to show it to the person is the model's choice").
The paths and revisions are recorded in the receiver's log for its model;
the stream shows nothing of them: no attachment list, no "changed" mark,
and no card for a path in a reply. The existing artifact card stays as it
is.

## 4. The durable inbox (a named reversal of ADR-0057, for the owner)

ADR-0057 parked a durable inbox and made the admitted `user_input` the
durable fact. A Work's log is single-writer, so A cannot append to B's
log, and a message to a Work with no live process has nowhere else to
live. The smallest shape:

- one file per message, `<sessionId>.inbox/<messageId>.json`, in the
  receiver's folder, written whole by temp + fsync + rename (fork.ts's
  discipline);
- read at boundaries only; **the admission in the receiver's log stays the
  durable fact** (ADR-0057's rule kept); the file is deleted after the
  admission is on disk, and a file whose id the log already holds is
  deleted unread;
- no broker, no ordering guarantee beyond arrival time on disk.

**This reverses ADR-0057's parked durable inbox, because delivery across
processes has no other home.**

## 5. The crash window of a send (ADR-0038; accepted)

A send is an execution with an external effect: write-ahead
`tool_execution_started`, the inbox write, then the receipt. A crash
between leaves the execution uncertain. The message id is deterministic,
`hash(sender address, executionId, receiver address)`, so recovery is a
lookup: the file in the receiver's inbox, or the admission in its log.
**Found: the runtime settles the execution as sent, by itself. Not found:
ADR-0038's verdict, with "no trace in the receiver" shown beside it.** A
replay writes the same file name; rename over it is idempotent.

**As built** (PR 3 and #479, § 16): no "settled as sent" and no new resolution kind. On open the
uncertain send is resolved "rerun"; the model sends again, and the resend takes the cut-off call's
id (`retriedSendCallId`), so a first attempt that landed is taken once.

## 6. The causal wake budget, across Works (ADR-0058 Amendment 9; accepted)

Every input that can start a run carries a stamp the host writes and the
model never passes: `{ rootId, parentMessageId?, hop }`. A person's input
opens a root; a Work cannot forge one. The budget (`maxWakes`, default 20)
is counted **per root by the web host**, over messages and completion
wakes alike. Past it a message still queues durably but starts no run, and
the receiver's stream says "chain budget spent".

**The count survives a restart.** It is not an in-memory counter: the
stamps are written into every admission (`via`), so on start the host
rebuilds each live root's count from the logs it serves (the same reading
Amendment 9 already does within one log). A restart can never refill a
spent budget.

**One count for every autonomous wake.** A task wake (ADR-0058) inside a
Work counts against the root of the run that started the task; a message
or completion wake against the root it carries. One chain alternating
task notices and peer messages therefore spends one budget and cannot
refresh it by switching kinds. `hop` is diagnostic only. The stamp is a trace context; the
record claims nothing new about it.

## 7. The completion wake

A parent should not poll its child, and the child should not spend a
request saying "done". The runtime writes the notice.

**When** (the draft, corrected by the review's M1): a Work that
`start_session` started ends a run, and that run was its first, **or it
admitted at least one message from its parent** (at its head or at any
boundary). One notice per run, deduped by run id. Runs the person drives
in the child alone do not notify.

**What it says**: the child's title, the run's end state, the first 400
characters of its final reply, and a link. The end state is the run's own
terminal, read as one of: **finished**, **failed**, **waiting on the
person** (an ask or an approval open), **ended with tasks still running**
(a background task outlives the run: not shown as done). A run that ends
does not mean the work is done, and the notice never says it does.

**As built** (#491, #497; § 16): the excerpt is the child's last reply, up
to 4,000 characters, with a note when it is cut.

**How it lands**: parent idle, woken at once, whether or not other
children are running; parent running, admitted at its next boundary with
whatever else arrived. No timer and no waiting for siblings: waiting for a
whole group before going on is `delegate`'s group wake. Each wake counts
against the parent's root (§ 6). `delegate`'s children keep ADR-0058's
handoff record and group wake; this covers only `start_session` Works, so
nothing is woken twice.

Any other Work that needs the result gets it by `message`, from the child
or the parent.

## 8. The permission hold

A message must not lend a receiver's wider reach to a narrower sender.
When the sender's **effective reach** may be narrower than the
receiver's, the message is held in the receiver's stream for the person to
admit or drop, and until then it is neither admitted nor a wake. Effective
reach is the permission mode and the folders the Work may touch; today
every Work's folder access follows its mode, so the comparison is the
mode's, and a later per-Work folder grant (the environment plan) widens
the comparison without changing this rule. **When equality cannot be
shown, hold.** Whatever the receiver then does passes its own permission
checks. The owner works in the widest mode almost always, so this rarely
fires.

**Fixed after 0.55.0** (finding G1, from an outside review of 0.55.0). As shipped, the built comparison
(`reachesFurther`, `packages/runtime/src/chains.ts`) ranked the two modes and the folders each Work was
added, but never the Works' own folders, so a sender in one folder could drive a receiver in the same mode
in another folder with no hold. It now compares them too: a receiver's folder, its own or an added one,
that none of the sender's folders holds is reaching further, and a folder that cannot be read counts as
further. Two Works in full access are still never held (§ 16, PR 3).

## 9. `start_session({ title, brief, initiation, context })`

| `initiation` | when | host |
|---|---|---|
| `asked` | the person explicitly asked for a separate Work | starts it now; one collapsed "Started <title>" row |
| `named` | the person named a task without saying where, or asked whether to open one | the Work card (below); nothing starts first |
| `proposed` | the model's own idea | the same Work card; unanswered, it expires and leaves a "Suggestion expired" row |

**The Work card** (owner, 2026-11-16, after walking through the reference
implementation's flow; one shape for `named` and `proposed`): a header "New Work",
the task's title, two lines of the brief (truncated), a × in the corner
that dismisses it, and two buttons, **Do it here** and **Start**. While the
`start_session` call runs, the stream shows kiso's usual Working state and
then the card; no row of its own (owner, 2026-11-16, correcting the first
relay: the reference implementation's line is only its tool's running status). No
environment options in v1.

**The started Work** opens with a top line "Started from <parent title,
a link> · <folder>", and its first message is the parent's brief, verbatim,
as the user message that starts its first run (collapsible). The brief is
written for a reader who has seen nothing else.

- **What the host proves**: `asked` and `named` are accepted only on a run
  the person's own input started (not a wake, a message, a task notice or a
  completion wake); elsewhere they become `proposed`; on a run another
  Work's message started, the call is refused whatever its `initiation`.
- **What it does not prove**: that the person asked for a new Work. That
  is the model's reading, held to the tool's contract and measured by the
  choice eval. When unsure, `named`. A later explicit "new Work" action in
  the UI would let the host hold the confirmation itself.
- **`context: "fork"`** binds to the starting run's terminal: fork.ts cuts
  only there; an `asked` fork starts when the terminal is written, a card's
  button waits for it. fork.ts unchanged.
- **The started Work links to its parent** (`SessionAddress`); the sidebar
  nests it; the completion wake follows it.
- A fresh brief states the goal, the context the new Work lacks, the
  deliverable and its acceptance.

**`delegate`, `start_session`, or neither.** One question decides it: *do
I need its result before I answer this turn?*

| | `delegate` | `start_session` | neither |
|---|---|---|---|
| test | this turn needs the result | it ends in something of its own and this turn does not wait | a few tool calls finish it |
| what it is | a sub-agent: hands back and ends; not in the sidebar | a full Work the person can open, talk to, steer, review | this Work |
| parent | waits, uses it now | carries on; completion wake or message brings the result | — |

Plus: the person's explicit request for a separate Work wins over the
test; a result someone else needs goes to them by `message`; pieces of
one change, or a wide search, are `delegate`, not several Works.

Both descriptions carry this, each naming the other; `delegate`'s changes
only in Works with the extension. Two Works never writing the same file is
a rule for the model, not a runtime guarantee (a shell write passes no
revision check); nothing here claims a started Work is isolated.

**The choice eval.** About 20 labelled person inputs across the three
columns, weighted to the ambiguous ("should this get its own session?",
"also, the payment work needs fixing", "check these three files"), run on
the round's route. Two pass lines, frozen in the kit before the runs: the
share of correct choices, and **zero `asked` on a `named` input**; the
second is not averaged into the first. Below either, the descriptions are
revised and rerun; nothing ships.

## 10. The steer, and every incoming line

The owner, 2026-11-16: the reference implementation shows **Send now** on a line typed
during a run, and marks it read a moment later; kiso web copied that in
0.54.1 (8272e5dc), yet since the release the owner has never seen Send now
on their own steers. And lines from other Works that arrive while a question
card waits end up parked above the box. The steer and the message are one
series: **lines that arrive while a Work is busy.**

**What the tree does today** (read on e2a3dc43, and in the bundle the
owner's own host served, which contains it):

- The kernel admits a steer at the turn head (`loop.ts`, ADR-0057 site A),
  before the next model request, after the tool results are on disk: the
  same boundary as the reference implementation. A long foreground command is
  detached by a steer (ADR-0057 § 5).
- The renderer draws a waiting steer as a lighter row with "Read at the
  next step" and actions: copy, take back (×), **Send now** (stop the step,
  send the waiting lines as the next turn).
- **Why the owner never sees Send now:** the actions are drawn at
  `opacity: 0` and appear only on hover (`stream.css`, `.pend-acts`). A
  person who types and looks away never hovers the row. The commit message
  says "on hover"; the reference implementation shows it without one.
- **No read mark:** once admitted, the row simply becomes an ordinary
  steer; nothing says it was read, so the person cannot tell "taken" from
  "still waiting" at a glance.
- While an `ask_user` card or an approval is open, the run is inside a tool
  execution; there is no turn head until the person answers, so a steer
  waits behind the card.

**Decision: one queue; the controls visible, as in the reference implementation.**

- **S1. Send now is visible on a waiting steer**, not on hover; copy and ×
  stay on hover. When the run takes the line, the row turns into the
  ordinary steer with a faint **Read** mark, as in the reference implementation.
  Renderer only.
- **S2. A line typed while a question card is open answers the card**
  (owner, 2026-11-16: accepted): the box's placeholder becomes "Answer, or
  pick above"; Enter sends the text as the card's free-text answer and the
  run continues at once. Host and renderer only (the existing answer
  route).
- **S3. A line typed while an approval is open declines the action, and
  the line becomes the instruction to do instead** (owner, 2026-11-16:
  accepted). The host's order (review): (1) name the one approval the
  line answers, the card in view; (2) queue the line on the run's ingress;
  (3) decline that approval, so the run resumes; (4) the line is admitted
  once at the next boundary. With more than one approval open and no card
  plainly the one in view, nothing is declined and the line waits as a
  steer. Host and renderer only.
- **S4. Lines from Works, completion notices and task notices never park
  above the box.** The box holds only the person's own words. A line from
  elsewhere that arrives while the Work is busy shows in the stream as a
  collapsed row in the waiting state ("Message from <title>, read after
  your answer" while a card is open; "…read at the next step" otherwise)
  and is admitted automatically at the next boundary. No click is ever
  needed to deliver it; the row turns into the ordinary "Received message
  from <title>" row once admitted.
- **One order.** The person's steers, messages and notices share one
  admission queue in arrival order (task delivery already does this,
  `tasks/delivery.ts`); one batch per boundary. The 32 KB batch cap of
  § 3 counts only lines from Works: the person's own lines are always in
  the next batch, so the person is never queued behind a burst from
  peers.

## 10b. Rewind: take back the line just sent, fix it, send it again (rev 2, owner-approved 2026-11-16; built in PR 6, #478, see § 16)

**The owner, 2026-11-16, on rev 1** (a fork that took the old Work's place): "it is not that complicated: think of it as
sending again, but the cache must not be invalidated." Rev 1 is withdrawn: a fork changes the session id, and a route keyed
by session (a gateway's per-session header) or a provider caching by session would lose the whole prefix.

**What it is.** Take back the line just sent, with its text and attachments back in the box, and the stream shows neither
the line nor the run it started. v1 rewinds **only the last line, and only when its run did nothing**: the typical case is
send, Esc at once, before the stream starts. Not any earlier turn; no confirm; no archive; no pointer; same Work, same
session id.

**When ↺ is offered** (all must hold, read from the log): the Work is idle; the last run started with the person's own line
(not a message, a notice or a wake) and holds no other input; it ended `aborted`; it has no `stop` (no committed model turn:
a reply cut off mid-stream is already voided by the kernel's `model_output_abandoned`) and no `tool_execution_started`. While
the Work runs, ↺ is disabled ("stop it first (Esc)"); on any other bubble it is not shown.

**How the log says it, with zero core lines.** The log stays append-only. The core already has the record: a
`user_input_replaced` with `content: null` is a veto, and the projection (`projectMessages`, `packages/core/src/kernel/
project.ts`, which the kernel's loop and the runtime both call) renders nothing at the vetoed input's position. The aborted
run's other events render nothing either: `terminal` and `model_output_abandoned` are skipped, a voided draft is skipped, and
there is no `stop` or tool event by the rule above. So the runtime appends one `user_input_replaced { replaces: <that line's
seq>, content: null }` outside any run (the way `resolveUncertain` appends), and the next request is byte for byte what it
would have been had the line never been sent. Nothing in `packages/core` changes; core stays 2,196 / 2,200.

**Without ↺, nothing changes** (owner, 2026-11-16: "when I do not press it, Esc and then type in the box and send: that is
a second message, and the model still sees the first"). Checked on the tree: after a run aborted at once, the next request
carries the aborted line and then the new one as two user messages (a probe on `feat/messages-wake`, faux adapter: the log
holds `user_input`, `terminal` for the aborted run; the next request is `first`, `One.`, `typo line`, `second line`). Only ↺
removes a line from the requests after it. A test locks this default beside the byte test below.

**The cache, proven by bytes.** A test in the request-surface family: session A runs turn 1, then a line that is aborted at
once and rewound, then "fixed"; control session B runs turn 1, then "fixed". The serialized request of A's last call equals
B's byte for byte (system prompt, tools, every message), and the rewound text appears in no request after the rewind. Run on
the faux adapter, so it holds whatever the provider; the same session id keeps a route's session header and a provider's
cache key unchanged.

**Other readers.** The title, when the rewound line was the first one, comes from the next line (`sessionTitle` skips a
vetoed input). The page hides the vetoed line and the run it started (the wire already carries `user_input_replaced`). Task
receipts and messages are untouched: the rule forbids a run that admitted anything else.

**Attachments.** The line's blocks go back as sent: the first text block to the box, image blocks to the picture
attachments, file blocks (`name:` and a fenced body, the composer's shape) to file attachments.

**Beside the steer's controls:** × takes back a line still waiting (the log never had it); Send now stops the step and sends
the waiting lines; ↺ takes back the last line after Esc, when its run did nothing. The owner's habit, send, Esc, ↺, fix, send,
is the last row.

**Ruled** (owner, 2026-11-16): this rev 2 is approved as written: no core change, the `user_input_replaced` veto, ↺ only
on an aborted run that did nothing, attachments back as sent, PR 6 after PR 5, no terminal.

**Scope.** The terminal: not in v1. Its own PR 6, after PR 5 (the bubble and the stream are PR 5's): the runtime's `rewind()`
with its rule and the veto, a host door (`/desk/rewind`), the bubble's ↺, the byte test, a proof. The budget goes to the
leader when it opens.

## 10c. ask_user in kiso web (owner-approved 2026-11-16; built in PR 7, #477, see § 16)

The owner, 2026-11-16: kiso web gets `ask_user`, in this series (the owner had taken it for granted that the web already had it).
It follows the reference implementation as it looks now: the question card sits in the stream, not over the box; a light grey head
with the question and, for several questions, "‹ 1 of 2 ›"; one row per option (a radio, the label, one grey line of
description; the recommended option's label followed by "(Recommended)"); a last fixed row "Other" that takes typing when
chosen; at the bottom right "Skip" and a black "Next ⌘↩", "Submit ⌘↩" on the last question; while a question waits, the
stream ends on a "Needs your input" marker (an orange dot on light yellow); multi-select questions.

**1. The host's `ui.ask`.** The extension (`extensions/ask/src/kiso-ask.mjs`) registers `ask_user` only when its host gives
it a bridge with `ask(spec, signal, ctx)`; the web gives none today. The web host gives one:
- `ask` records a pending question under `(session, callId)` and returns a promise; nothing else is stored, because the
  call is durable as its `tool_call_end` and the answer as its `tool_result` (the extension's own rule: zero new mechanisms).
- The page draws the card from the log: an `ask_user` call with no result yet. A refresh or a reconnect draws it again from
  the same events; nothing on the page holds state the log does not.
- The answer goes back by `/desk/ask { session, callId, result }`: the host resolves the promise, the tool returns, the run
  goes on. Stop (Esc) aborts through the signal, as any tool.
- A host restart while a question waits leaves the execution uncertain; on open, an uncertain `ask_user` is resolved "rerun"
  (as `message` is, PR 3): the call is idempotent, so resuming the run asks the same questions again. A half-filled card is
  not kept (the extension's stated stop clause).
- The answer is the shape the terminal already returns: `{ answers: [{ q, choice } | { q, choices } | { q, custom }] }`.
  **Skip** marks that question declined: the result is `{ answers: [...], declined: [<skipped questions>] }`, and
  `{ declined: [...all] }` when every question was skipped, the terminal's decline shape.
- The sidebar shows a Work with a waiting question as waiting, as it does a waiting approval.

**2. S2.** While the card is open the box's placeholder reads "Answer, or pick above"; Enter puts the typed words into the
current question as Other (`{ q, custom }`) and moves to the next question, or submits on the last.

**3. What it costs, and how it is measured.** The web's tool table gains `ask_user` (its description and schema), so every
web request pays its bytes; they are counted with `wc -c` before the PR and stated in it. The CLI's request-surface snapshot
and the T3/T5/T6 paired bench do not move: both measure the terminal's headless composition, which has no `ask_user` (the
extension needs a person to answer). So the bench run before `feat/messages` merges into `main` cannot see this change, and
the record says so rather than citing it; the web's evidence is the byte count and a proof.

**4. Where.** Its own PR 7, after PR 5b (S3, S4) and before PR 6 (rewind) or after it, as the leader orders: the host's
bridge and `/desk/ask` (`src/main`), the extension added to the web agent, the card, the marker and the composer's S2
(`src/renderer`: a new `stream/AskCard.tsx`, `Process.tsx`, `Composer.tsx`, `WorkView.tsx`, `i18n/en.ts`, `stream.css`), a
proof with screenshots against the owner's reference screenshots. Rough budget: `src/renderer` +220, `src/main` +60,
`scripts/proofs` +100; the exact numbers go to the leader when it opens.

**10c.1 Amendment (owner, 2026-11-20, option A of finding #12) — a line from another Work ends the waiting question.**
Read on the tree, then reproduced live: while a Work's run waits inside `ask_user`, it cannot reach a step boundary, so a message
another Work sent it is handed to the run (`run.deliver` says yes) and then sits out of the log until the person answers; the
person sees the sender's "Messaged" row and nothing on the receiver. The owner's ruling:
- **The line ends the question.** When a live run accepts a peer line (`run.deliver` returned true) and one of its questions
  waits, the host resolves that question with the not-answered shape: `{ declined: [every question], replaced: true, reason }`.
  The reason says another session sent a message, the question is withdrawn and not declined by the person, and to call
  `ask_user` again with what is still needed, and that a withdrawn question is never the model's to decide: it asks it again or
  says plainly that it is still open (added 2026-11-23 after kit v4: the model decided one itself, once in 24 runs). The line is then admitted at the next boundary, as any peer line; the model
  reads it, and decides whether to ask again. No core change: the hook is `PeerDeliveryOptions.onAccepted` (runtime), the
  resolution is the web bridge's (`AskBridge.replaceWaiting`).
- **Caps.** One per question (once ended, it is over) and **three per run**; past the third, a line waits for the person's
  answer as before, so a sender cannot keep a question from ever being answered.
- **The stream.** The ended call is an ordinary step folded to one line, "Question replaced". The message row is in the log
  before the model's next call, so it is drawn above the new card. A question asked again that did not change keeps the
  person's picks (by its text; Other's words too); a changed question starts empty. A person's own line in the box is not a
  peer line: it stays the question's Other (§ 10c, item 2).
- **Not covered.** Task notices (`run.notify`) do not end a question: they were never the owner's case, and a long task's
  end is not a reason to withdraw a question. Revising a card in place (same call id) is not built; the model replaces a
  question by asking again.
- **What it costs.** No request byte moves: the web's `ask_user` description is unchanged. Proof: the `ask-replaced` proof
  (a pick made, a message from another Work, the result shape, the log order, the folded row, the kept pick, the cap).

## 11. In the stream

Collapsed rows, expandable, like any tool row: "Messaged
<title>"; "Received message from <title>" (expanded: the text only, owner
2026-11-16); "Started <title>"; "Suggestion expired"; "<child> finished /
failed / is waiting on you / ended with tasks running"; the waiting rows of
§ 10. No new log record for any row: they render events the log holds.

**Messages admitted together are one group** (owner, 2026-11-16): when one
boundary admits two or more messages none of which is held, the stream
shows one row "Received N messages ⌄"; expanded, one row each, "Received
message from <title, a link to that Work> ›". One message stays the single
row. A held message (§ 8) never joins a group: it keeps its own row with
the person's admit or drop.

(Files have no UI, § 3. The first draft drew paths as cards, and a later
one routed pages through the host's Previews; both are withdrawn by the
owner's 2026-11-16 ruling, and the existing artifact card is untouched.)

**How the page learns who sent a line** (review M2; **superseded in PR 5a**, #475: `user_input`
carries its `via` on the wire, so no host frame is sent; see § 16). The first draft's plan: the wire then sent
`user_input` as `["content", "source"]` (`packages/protocol`), without
`via`. The web host therefore emits a seq-bound frame beside each peer
admission (sender title and link, from the runtime's record keyed by
`messageId`; the files stay in the log for the model, § 3), the way it already pairs frames
with events. A cold open, an SSE reconnect and a replay all rebuild the
same rows from the log and that record; a test asserts the three agree.
This is host and wire work, not core.

## 12. What it touches, and the core question

| layer | change |
|---|---|
| core protocol (`packages/core/src/protocol/events.ts`) | three places (review M1): the `UserInputVia` union gains `{ kind: "peer", event: "message" \| "completion", from, messageId, rootId }`; `isRuntimeInput` is true for it; `isVia`, the event validator `user_input` passes through, accepts a well-formed `peer` and rejects a malformed one. No loop change, no request byte change (the projection never reads `via`). **Approved by the owner** |
| runtime | inbox writer/reader, delivery by state, capacity checks, admission as runtime input, the crash-window lookup, completion detection, the hold |
| web host | `SessionAddress`, the roster, the counter rebuilt from stamps, cards and the fork binding, file-policy checks for cards |
| renderer | the rows and their groups, the Work card, the started Work's top line, the steer (§ 10) |

**Core's line budget.** `scripts/check-size.mjs` gates `packages/core/src`
at 2,200 counted lines (comments and blanks free); `origin/main` e2a3dc43
counts **2,194**, six lines of room. **Measured** on a copy of that tree
with the three edits applied (the repository has no formatter that wraps
lines): **2,196 / 2,200**, two counted lines. Two separate kinds with typed payload
interfaces (the first draft's "about ten lines") would break the gate. One
`peer` kind adds the union member (one line), changes `isRuntimeInput`'s
existing line, and adds one line to `isVia`; the richer fields (title,
files, the address's parts, `parentMessageId`, `hop`) live in the
runtime's own record keyed by `messageId`, not in core. `rootId` stays in
core because the wake budget is rebuilt from it (§ 6). That fits with no
re-baseline. The alternative, raising the gate, needs an ADR-0043
amendment and is not proposed.

Without any core line, messages would ride as `source: "system"` with no
`via`: a message could not be told from other system inputs on replay, the
hook rule ("never passes onUserMessage") would rest on a convention, the
wake budget could not be rebuilt from the logs, and the rows of § 11 would
have nothing to render from.

## 13. Rejected

- **A fourth tool for files**: a path in `message` and a card for a path
  in a reply cover the one-machine case; device push is not v1.
- **Waiting for siblings before a completion wake**: holds a fast child's
  result behind the slowest.
- **A per-turn message cap**: loops are bounded by the wake budget,
  holding by the inbox caps.
- **An intent classifier for `asked`**: the host proves who started the
  run; the eval holds the model to the contract.
- **Messages in the terminal in v1**: no host sees every Work; a
  receiver-only terminal is a v2 candidate.
- **Hiding Send now behind hover**: the person who needs it is not
  hovering (§ 10).

## 14. Tests, each red before its fix

1. A message to a running Work is admitted at the next turn head, never
   inside a tool execution; to an idle Work it wakes; with the host down it
   lands in the inbox and is admitted once on open.
2. Two folders minting the same session id: messages, dedupe and parent
   links stay apart (`SessionAddress`).
3. Crash after the inbox write, before the receipt: recovery settles as
   sent; crash before the write: ADR-0038's verdict with "no trace".
4. A replayed send writes one file; the receiver admits it once.
5. Two running Works exchanging messages past the inbox cap: the sender is
   refused with "inbox full"; no accepted message is lost.
6. A→B→C→A past 20 wakes: the 21st queues and starts nothing; after a host
   restart the 22nd still starts nothing.
7. Parent message admitted mid-run in the child: the run's end notifies
   (M1); two parent messages in one run: one notice.
8. A child ending with a background task running: the notice says so, not
   "finished".
9. A child finishing while a sibling runs: the idle parent wakes at once.
10. A narrower sender's message to a wider receiver: held, no wake, until
    the person admits it.
11. `files` naming a path the sender may not read: refused; a file changed
    after sending: told to the model on read, nothing drawn; a 2 GB file:
    hashed without a 2 GB heap.
12. `start_session` with `asked` on a woken run: becomes `proposed`; on a
    message-started run: refused.
13. A fork started mid-run binds to that run's terminal seq.
14. A web-created Work resumed in the terminal: the three tools refuse,
    no inbox file, no card.
15. A message admitted as runtime input: never passes `onUserMessage`.
16. Steer: Send now is visible on a waiting row without hover; the row
    shows Read once admitted; a line typed under an open question card
    becomes its answer; a line typed under an open approval declines it and
    is admitted as the instruction.
17. A peer message arriving under an open card: never in the box; admitted
    at the boundary after the answer with no click.
18. Three unheld messages at one boundary: one "Received 3 messages" row,
    three rows inside; with one held among them, two in the group and the
    held one on its own row. A started Work: its first user input is the
    brief byte for byte; its top line names the parent.
19. A `user_input` with a `peer` via passes `isKisoEvent`, survives a write
    and reload; one with an empty `from`, `messageId` or `rootId`, or an
    unknown `event`, is rejected.
20. Three senders racing for an inbox's last slot: exactly one is accepted.
21. Three messages admitted at one boundary: three `user_input` events,
    three ids, one model request after them; a crash after the second
    replays only the third.
22. An inbox file whose deletion fails after admission: left as litter,
    never admitted twice.
23. A cold open, a reconnect and a replay draw the same message rows, with
    the same sender and files.
24. A chain alternating task notices and peer messages: **two budgets**
    (owner, 2026-11-16, amending § 6): task wakes spend ADR-0058 Amendment
    9's per-session count, message and completion wakes the chain's; neither
    spends the other's.
25. A line typed under an open approval while the approval resolves: the
    line is admitted exactly once; with two approvals open and none in
    view, nothing is declined.

## 15. Order of work

One ADR, five PRs as planned, each accepted on its own (built as eight: PR 5 split into 5a and
5b, ask_user became PR 7 and rewind PR 6, then #479 for coverage; § 16):

1. **Addressing and the roster**: `SessionAddress`, `list_sessions`, the
   extension's table, the terminal refusal.
2. **Inbox and delivery**, the strictest gate: its first commit is the
   core change alone (§ 12), run against the full core tests and the size
   gate before anything builds on it; then `message` with `files`, the
   three paths, atomic capacity, per-message admission, the crash window,
   the wire frame. Its invariants: a send that returned success survives a
   restart; one id is admitted at most once; the only inbox copy is never
   deleted before the admission is on disk; a failed delete leaves litter,
   not a second admission; racing senders never oversell capacity.
3. **Wake and hold**: the causal budget across Works with restart
   recovery, the completion wake, the permission hold.
4. **`start_session` and the cards**: initiations, the Work card (one
   shape for `named` and `proposed`), the fork
   binding, the parent link, the started Work's top line and first
   message, the sidebar nesting.
5. **The stream**: the rows and the message groups, and the
   steer of § 10 (UI session's work; S1 is a small fix that can go
   first, ahead of everything else).

**How it lands** (owner, 2026-11-16): the five PRs merge into an
integration branch, `feat/messages` (cut from `main` 0f5b9859), not into
`main`; each still has its own CI run and the owner's word. (The plan also merged `main` into
`feat/messages` after each PR; as built, `main` is frozen until 0.55 and was never merged in.) When
all five are in, the branch takes the full check, the size gates, the
choice eval, the paired bench (T3/T5/T6) and two dogfood sessions, then
merges into `main` once and ships as 0.55 (no 0.54.3).

**PR 2 as built** (owner, 2026-11-16, on the PR 2 plan): `to` resolves
to a short ref, else a title in any case, else the one title containing it,
and two or more matches are refused with the candidates; **this reverses
the design draft's "address by a stable id, never by title"**, by the owner's
ruling. The crash window's automatic settling (§ 5) moves to PR 3; until
then an uncertain send takes ADR-0038's verdict, and the receiver's dedupe
makes a re-send safe. The page's sender frame (§ 11) moves to PR 5. Until
PR 3's causal stamp, a message's `rootId` is the sender's own address.

**The ship gate** (owner, 2026-11-16: the model tells `delegate` from
`start_session` by which tool it picks, so the choice eval is the check
that matters): the extension is not turned on by default, and no release
note offers it, until the choice eval of § 9 passes both its lines.

Then the tool-schema round: the three schemas' and the two descriptions'
bytes counted with `wc -c`; the release bench as ruled on 2026-11-12
(T3/T5/T6 pairs on the kit's route); the choice eval; the owner's
decision to ship.

## 16. Implementation record (what PRs 1–7 and #479 settled, kept here so no one has to read the code)

The owner, 2026-11-16: "put these details in the ADR, so we do not forget them and have to read the code". Each line names
its PR and who ruled it; "built" means the decision was made while building and stands unless the owner reverses it.

**PR 1, #469, addressing and `list_sessions` (2026-11-16)**

- *The mark* (built; § 2 rewritten for it): the execution profile does not fix a tool table, so a sidecar tenant does:
  `sessionsTools: true` in `<id>.meta.json`, written only while the web host runs with the extension on
  (`KISO_WEB_SESSIONS=on`), on the first open of a Work that has no log yet. A fork carries it (`writeForkSidecar`). The
  web gives a marked Work the extension; the terminal registers, for a marked Work, the same specs
  (`packages/runtime/src/sessions-tools.ts`, shared by both apps), each refusing with a reason and no side effect. An
  unmarked Work never gets the tools, wherever it is opened, so no table changes mid-session.
- *Off by default* (owner, 2026-11-16, with the budget): until the tool-schema round and the choice eval, default requests do
  not change.
- *Short refs* (built): the shortest suffix of a session id, four characters at least, that no other listed id ends with; an
  id listed twice (two folders) is written `folder/id`.
- *The listing* (built): the sidebar's own cross-folder listing (`History.snapshot`), most recent first, 100 lines at most,
  this Work left out; `query` matches title or id in any case. States: running, waiting on the person, idle, open elsewhere
  (a live process other than this one holds the Work's lock: `heldElsewhere`). The tool waits for the first folder scan,
  3 s at most (CI showed the race), and says so if it is still incomplete; from PR 3 it also reads its own folder afresh, so
  a Work made a moment ago is listed (the history re-reads a folder at most every 3 s).
- *No approval* (built; owner ruled messages free, 2026-11-05): `list_sessions` and `message` are allowed without asking;
  deny > allow > ask, so a deny earlier in the chain still wins.
- *CI* (built): `sessions-tools.test.ts` reaches `ps` (the lock check), so it is in the pty list of `tests/pty-suite.json`.
- *Budget* (owner, 2026-11-16): `src/main` 3,500 → 3,620, `scripts/proofs` 3,560 → 3,630.

**PR 2, #471, `message` and the inbox (2026-11-16)**

- *Core* (owner, 2026-11-16): one `peer` kind in `UserInputVia`, `isRuntimeInput`, `isVia`; core 2,196 / 2,200, committed
  alone and run against the full core suite first.
- *The inbox* (§ 3–§ 4 as accepted; details built): `<id>.inbox/<messageId>.json`, written temp + fsync + rename, the
  directory fsynced through the task journal's `fsyncDir`, which skips it on win32 (opening a directory there
  fails with EPERM; CI's Windows run caught it); the file's own fsync stays. Limits: 16 KB of text, 20 files, 200 messages or 1 MB per inbox, counted on whole record bytes. The
  count, the size and the publish happen under one lock (a directory made atomically, taken over after 10 s), so racing
  senders never oversell; past a limit the send is refused in words; an accepted send is never dropped; a replayed id is a
  duplicate, not a second file.
- *Delivery* (built, modelled on task delivery): a running receiver gets each message at its next boundary as its own
  runtime `user_input` (`Run.deliver`; never merged with a neighbour or a task notice); an idle one wakes once with the
  oldest message as the run's input and the rest ride its first admission. A file is deleted only after its id is in the
  receiver's log; a file whose id the log already holds is deleted unread; a failed delete leaves litter, never a second
  admission. Ids handed to a run but not yet in the log are remembered, so nothing is handed twice; when the run settles
  the set is cleared and the inbox read again. Only the web host reads inboxes in v1; a Work open in the terminal keeps its
  messages until the web opens it.
- *`to`* (owner, 2026-11-16, **reversing the design draft's "by stable id, never by title"**): a short ref (or the full id),
  else a title in any case, else the one title containing it; two or more matches are refused with up to ten candidates.
- *Files* (§ 3; built): absolute paths that exist and that the sender may read (its folder or its added folders, compared
  through links; never a protected file); each recorded with its revision, `rev:` + the first 16 hex of sha256, hashed as a
  stream. The model reads the text and the paths; nothing of them is drawn (§ 3, owner 2026-11-16).
- *Moved out* (owner, 2026-11-16): the crash window's settling to PR 3; the page's sender frame to PR 5.
- *Budget* (owner, 2026-11-16): `src/main` 3,620 → 3,680, `scripts/proofs` 3,630 → 3,700.

**PR 3, #472, the chain budget, the completion wake, the hold (2026-11-16)**

- *The message id* (built): `hash(sender address, callId, receiver address, text)`, 24 hex. On open, an uncertain
  `message` execution is resolved "rerun". **Corrected by #479**: the record here said "the rerun writes the same id",
  which did not hold: "rerun" tells the model the send did not land, so it sends again in a new call with a new call id;
  see the #479 entry. No new resolution kind, no core or recovery change.
- *The chain* (§ 6; built): read from the session's own log: a person's line opens `<address>#<seq>`; a run a message
  started carries the message's `rootId`; a task notice keeps the chain before it; a session with no line yet is
  `<address>#0`.
- *The budget* (§ 6; built): 20 wakes per chain, one file per chain at `<kiso home>/chains/<sha256(rootId), 24 hex>.json`,
  written temp + rename, so a restart never refills a spent chain. Past it a message still lands but wakes nobody; it rides
  the receiver's next run.
- *Two budgets, not one* (owner, 2026-11-16, **amending § 6's "one count for every autonomous wake"**): task wakes keep
  ADR-0058 Amendment 9's 20 per session; message and completion wakes count per chain. Whether to merge them is decided after
  the 0.55 dogfood.
- *The completion wake* (owner, 2026-11-16, **narrowing ruling 4**): owed only for a child's first run and for a run that
  admitted a message from its parent; never for the person's own runs. The link is the sidecar tenant `startedBy`
  (`<key>/<id>`, written by `start_session` in PR 4). The notice: the child's title, the end state (finished; failed when the
  terminal is not `completed`; ended with tasks still running; waiting on you) and the first 400 characters of the run's last
  reply; framed to the model as "The session X, which this session started, ended a turn". Its id is `hash(child, runId,
  "completion")`, so a settle seen twice writes one notice. The parent wakes under the chain budget.
- *Never held in full access* (owner, 2026-11-16, ruling 5 kept): **two sessions in full access are never held**, whatever
  folders either was given; the rule lives in the runtime (`reachesFurther`, `chains.ts`) and unit tests lock it, so normal
  use never holds a message.
- *The hold* (§ 8; built): the receiver reaches further when its mode ranks higher (plan < default < accept-edits <
  full-access) or it has an added folder the sender lacks; an unknown mode counts as further. Such a message lands with
  `held: true`, is never delivered, and the sender is told it waits for the person. Releasing it is PR 5's control.
- *Where a message went* (owner asked, 2026-11-16, "how does it know the other is not there?"; built on #472): the receiver's
  look returns what became of the message, and `message`'s reply says it, so the model can decide whether to wait for an
  answer: "it is running and reads it at its next step" (handed to the live run); "it was idle and woke to read it"; "it is
  idle and was not woken (this chain's wake budget is spent); it reads it when it next runs"; "it is open elsewhere (the
  terminal) … waits in its inbox until kiso web opens it" (another process holds the Work, so it cannot be opened here). A
  held message says it waits for the person (above).
- *Budget* (owner, 2026-11-16): `src/main` 3,680 → 3,740, `scripts/proofs` 3,700 → 3,780.

**PR 4, #473, `start_session` and its cards (2026-11-16)**

- *Who started the turn* (owner, 2026-11-16): the first input after the log's last terminal. The person's own line keeps
  `asked` and `named`; a message from another Work refuses the call; a task notice, a completion notice or a wake turns it
  into `proposed`.
- *asked* (built): the new Work is made in the starter's folder (an id of the renderer's shape), linked by `startedBy`, named
  by the call's title, on the starter's tier and model (`settings.started`, split out of `forked`), and run with the brief,
  verbatim, as its first line (an ordinary person-source input: the person asked for it). A `fork` is queued until the
  starter's run settles and then cut at that run's end (`forkWork`), the brief as the fork's next line.
- *Cards* (built): a sidecar tenant `cards` on the starter, keyed by call id: `{ state: pending | started | dismissed | here,
  title, at, work? }` (not the global settings file, where two folders' ids could collide). `/desk/session-card` answers a
  card once: Start makes the Work from the call's own brief (a fork card refuses while the starter is still running); Do it
  here sends the starter "Do it here." as the person's line; × dismisses. A proposed card older than seven days draws
  "Suggestion expired: <title>". No row of its own while the call runs: kiso's Working state, then the card (owner,
  2026-11-16).
- *The page* (built, to the agreed mocks): the card and its rows render outside the folding group (`stream/SessionCard.tsx`,
  hooked in `Process.tsx`); the lead above a Work's first run moved to `stream/Lead.tsx` and gained "Started from <parent> ·
  <folder>"; the sidebar nests a started Work under its starter through `WorkRow.parent` (from `startedBy` in the listing).
  Known gaps: the completion notice still showed its raw text in the starter's stream until PR 5's rows (closed by PR 5a,
  #475); children list newest first, the fork rule the nesting reuses (open).
- *Budget* (owner, 2026-11-16): `src/main` 3,740 → 3,880, `src/renderer` 7,100 → 7,230, `scripts/proofs` 3,780 → 3,880.

**PR 5a, #475, the message rows (2026-11-16)**

- *The wire* (built; replaces § 11's host frame): `user_input` carries its `via` on the wire, an optional field
  (`packages/protocol`, `WIRE_FIELDS`), so the page draws a message or a completion notice from the event itself, alike on a
  cold open, a reconnect and a replay. Every `via` kind rides it (peer, tasks, skill); none carries anything the page did
  not already show.
- *The rows* (owner, 2026-11-16, to the agreed mocks): "Messaged @<to> <text…>" for a message sent (the `message` call, drawn outside
  the folding group like a card); "Received message from <title>" for one received, its text only when opened (the framing
  line and the file list the model reads are not drawn); consecutive messages admitted together are one "Received N
  messages" row; a completion is "<child> finished / failed / is waiting on you / ended with tasks running", the reply's
  opening when opened. The sender's title is the one it had when it sent; its name opens it (another folder's too).
- *The held row* (owner, 2026-11-16; the PR's last commit so it can be lifted out): `/desk/env` lists a Work's held
  messages; the page draws "Message from <title> · held" at the stream's end with Drop and Admit, reading the list every
  4 s; Admit writes the message again without the hold (`releaseMessage`, under the inbox's lock) and the Work looks; Drop
  deletes it.
- *Inbox tests* (built, on #471): the tests that fill an inbox (200 fsynced writes) get 30 s; on a loaded machine they passed
  the 5 s default.
- *Budget* (owner, 2026-11-16): `src/main` 3,880 → 3,920, `src/renderer` 7,230 → 7,400, `scripts/proofs` 3,880 → 3,980.

**PR 5b, #476, S3 and S4 (2026-11-16)**

- *S3* (§ 10, owner 2026-11-16): with exactly one approval open, the box reads "Typing declines this, and your words become
  the next instruction", or "Typing declines this" when the box is too narrow for the whole line (measured as its width
  changes); a typed line is queued as a steer first and the approval then declined, so it is admitted once, at the boundary
  after the decline; with several approvals open none is declined and the line waits as a steer. No host route: the order
  is the page's two calls.
- *S4* (§ 10): `/desk/env` lists the whole inbox (held ones marked); a message not yet in the log shows at the stream's end
  as "Message from X · read at the next step", or "· read after your answer" while an approval waits; the list is read again
  every 4 s; a message whose id the log holds is not drawn again.
- *The approval card's look* (owner, 2026-11-16: "why the yellow glow? the same as start_session's"): `.ask` takes the Work
  card's 1px grey border and 12 px corners; the amber shadow and its pulse are gone, the entrance kept; the warning icon in
  the text colour; `.ask.resume` and future question cards share it; the sidebar's amber waiting dot is unchanged.
- *Budget* (owner, 2026-11-16): `src/renderer` 7,400 → 7,430.

**PR 7, #477, ask_user in kiso web (2026-11-16)**

- *The bridge* (§ 10c, owner-approved): `src/main/ask-bridge.ts` gives the ask extension its `ui.ask`; a question waits under
  `(session, callId)` until `/desk/ask` brings the page's answer; Stop rejects the wait through the run's signal; nothing else
  is stored. On by default; `KISO_WEB_ASK=off` leaves the tool out. An uncertain `ask_user` is rerun when its Work opens.
- *Waiting* (built; the leader caught it): a Work with a question waiting is "waiting" both in the host's listing and in the
  page's own state for the open Work (`isAsking`), so the sidebar shows the amber dot, not the spinner.
- *The answer* (built): the terminal's shapes, `{ answers: [{ q, choice } | { q, choices } | { q, custom }] }`; skipped
  questions as `declined`, `{ declined: [...] }` when all are skipped.
- *The card* (owner's reference screenshots): in the stream, the Work card's frame; a grey head with the question and
  "‹ 1 of 2 ›"; a radio, or a box for multiSelect, per option, black (`accent-color`), with its description and "(Recommended)"
  for a label ending in "(recommended)"; a last row Other that takes typing; Skip and Next / Submit ⌘↩. The stream ends on
  "Needs your input" while it waits. Answered, the call is an ordinary step row again.
- *S2* (§ 10): while a question waits the box reads "Answer, or pick above"; Enter puts the line into the current question as
  Other and moves on, or submits on the last.
- *Cost* (owner, 2026-11-16): +1,280 bytes per web request (the tool 1,232, its prompt line 46); the terminal's request
  surface is unchanged; an existing web Work loses its prompt cache once after the upgrade; no paired bench (it measures the
  terminal's composition).
- *Budget* (owner, 2026-11-16): `src/renderer` 7,430 → 7,540, `src/main` 3,920 → 3,930; web depends on
  `@vincemakes/kiso-ask-ext`.

**PR 6, #478, rewind (2026-11-16)**

- *The rule* (§ 10b rev 2, owner-approved, with "a run that executed a tool cannot be rewound"): `AgentSession.rewindable()`
  reads the log: the session idle; its last run holding one input, the person's own; ended `aborted`; no `stop`; no
  `tool_execution_started`.
- *The record* (built; zero core lines): `rewind()` appends `user_input_replaced { replaces, content: null }` outside any run
  (persisted under the last run's id) and returns the line's content; `sessionTitle` skips a vetoed line.
- *The push* (built; the first proof run caught it): an append between runs is not pushed to a page, so
  `SessionService.rewind()` publishes it, as an idle verdict is published.
- *The page* (built): `/desk/rewind` (409 with the rule); the reducer drops the vetoed turn; the arrow (the refresh icon
  mirrored to ↺) shows with copy on the last qualifying bubble, disabled with "stop it first (Esc)" while the run is live;
  the line's text and its attachments (picture blocks, the composer's file blocks) come back into the box.
- *The byte tests* (owner, 2026-11-16): A (aborted, rewound, then the fixed line) equals B (the fixed line alone) byte for byte
  in system, tools and messages, and the rewound text is in no later request (checked red with the veto removed); C, without
  rewind, keeps the aborted line as its own message; refusals for a finished run, a run that executed a tool, a live
  session, a second rewind.
- *Budget* (owner, 2026-11-16): `src/renderer` 7,540 → 7,570, `src/main` 3,930 → 3,940, `scripts/proofs` 3,980 → 4,010.
- *A proof fixed on #476*: CI's Linux Chrome fits the whole S3 hint where macOS needs the short one; the proof checks the rule
  (whole if it fits, else short, never cut), not one machine's fonts.

**#479, the coverage tests and the crash-rerun fix (2026-11-17; the leader's list)**

- *Finding* (built; test 3 found it with a real kill -9): a first attempt that had reached the inbox before the crash was
  admitted twice, because the model's resend carried a new call id. *Fix*: `retriedSendCallId` (runtime `inbox.ts`): a
  send whose `to`, `text` and `files` match a `message` call resolved "rerun", and not re-sent since, takes that call's id;
  the inbox calls it a duplicate or the receiver's log holds it. Known edge: the resend of a message already admitted gets
  the idle receiver's reply, not "already delivered".
- *Moved, zero behaviour change*: `runStarter` and `startInitiation` (`chains.ts`), `shortRefs` (`sessions-tools.ts`),
  `peerMessageId` (`inbox.ts`) left `src/main` for the runtime, where they are tested; `src/main` 3,938 → 3,913.
- *Tests*: 3 in `message-crash-kill9.test.ts` (a SIGKILL child; killed after the write with the retry still queued, after
  the write with the message already admitted, before the write; red with the old id rule: two admissions); 12 in
  `chains.test.ts`; 2 in `sessions-tools.test.ts`.

**The merge** (the leader, 2026-11-17, on the owner's "merge in order once green"): #469 d7cbeee0, #471 e7fdcbb2, #472
be8c8229, #473 a4937f5f, #475 12e77568, #476 9b927f8b, #477 d7d7fd58, #478 556be7dc, each green on its own head. Sizes at
556be7dc: `src/main` 3,938 / 3,940, `src/renderer` 7,570 / 7,570, `scripts/proofs` 4,009 / 4,010.

**#480 and #481, the coverage gaps closed (2026-11-17; the owner: "fill them all in")**

The leader reversed the "not built before 0.55" of the earlier gap list; every gap has its test now, each red on a named
mutation of the code it pins (the PRs list them), then green.

- *Tests* (#480, packages): 21 and 1 in `peer-crash-kill9.test.ts` (a SIGKILLed holder: killed after the second of three
  admissions, the third admitted once after the cut-off run is resumed; written while nothing holds the receiver, admitted
  once on open, nothing on a second open); 5, 6, 7, 9 and 11 in `peer-coverage.test.ts` (two running sessions past the
  cap; A→B→C→A spending 20 wakes, then a restart with the budget read from disk; two parent messages, one notice; a
  sibling parked while the parent wakes; the revision reaching the model, and a 2 GB sparse file hashed with rss growth
  under 256 MB); 14 in `apps/cli/tests/sessions-twins-cli.test.ts` (through `kiso -p`: the three refuse; no inbox, card,
  session, parent link or chains directory afterwards).
- *Proofs* (#481, budget `scripts/proofs` 4,010 → 4,080, owner 2026-11-17): `start-refused` (a message-started turn's
  `start_session` refused end to end, no Work, no card); `approvals-ui` (25, first half: a line typed as the host answers
  the approval is admitted once, the approval decided once); `rows-ui` + 13 lines (23: the rows drawn live, on a cold open
  and after a host SIGKILL and reconnect are the same rows; the reconnect leg turns red only with both the client's
  `Last-Event-ID` seam and the store's seq skip broken, each holds alone).
- *Finding, fixed* (test 14): the terminal's twins refused without `errorKind`, so the kernel appended "its side effects
  may have partially applied; verify before retrying" to a refusal that says nothing ran; they are `precondition` now, as
  the web host's refusals are.
- *Finding, fixed* (test 11): the receiver's model never saw a file's revision, only its path (the revision was in the
  inbox file, deleted on admission), so § 3's "a changed file is told to the model" could not happen. The file line is now
  `- <path> (rev:… when sent)`; a read printing another revision is a changed file. That is v1; no "changed since" is
  computed for the model.
- *Moved, zero behaviour change*: `fileRevision` (`inbox.ts`) and `completionMessage` (`chains.ts`) left `src/main`;
  3,913 → 3,901.
- *Findings, recorded*: a host that wakes a session still holding an open run through `session.run` spins (the run is
  refused after `beginRun`, its settle pokes again); the web host does not, because the server's `run()` refuses with
  `OpenRunError` first. A message waiting behind a cut-off run is admitted in the wake after the resumed run, one run
  later than it could be, still once.
- *Unreachable, recorded* (test 25, second half: two approvals open, none in view, none declined; owner 2026-11-17, option
  (a)). No proof can stage it: (1) in one Work the kernel's ask gate holds an ask and every call after it until the person
  decides (`packages/core/src/kernel/loop.ts`, the ask gate), so one approval is open at a time; (2) delegate children
  never relay an ask: they run with `KISO_MODE: "bypass"` and "a child must never see an ask"
  (`extensions/subagent/src/kiso-subagent.mjs`, `childEnv`); (3) kiso web does not load the subagent extension. The
  page's several-open branch (`WorkView.tsx`, S3) is defensive. **The day the kernel allows parallel approvals, or the web
  relays a child's approvals, this proof is written first.**

**#484, #487 and #489, the UI walkthrough and the real-model rounds (2026-11-17)**

- *#484*: the ask_user card works for a streamed call. It mounts once its input is in, and its state never sizes itself from
  the questions at mount. Esc right after a send stops the run. An open approval, or a held message, shows the amber dot. A
  run cut off by a restart has no live approval and no live question card. A question cut off by a restart tells the model
  "Not answered … ask it again", not "[Permission denied]". Nothing is ever chosen for the person. Two lost-line races are
  fixed: a run that is closing makes the new run wait for it, and a send that meets a live run joins it as a steer. A new
  Work's row is read at once, and "Started from" keeps to one line.
- *#487*: a multi-select keeps its picks beside Other, and the words join the choices. A ref is drawn as its Work's title.
  `files` may be relative to the sender's folder. A rewound first line takes its auto-made title with it.
- *#489*: kiso web reads the terminal's `preferences.json` (it never did, on main too), so a remembered effort is sent, and
  the web's choice is remembered for both apps.
- *Known, not fixed* (the leader, 2026-11-17): if the first line is taken back while its title request is still on its way,
  the old title lands after the rewind and shows until the next line names the Work. The end state is right.
- *Known, not fixed* (#487): the host tells its own titles from the person's names by memory, so after a host restart a
  rewind keeps the title.
- *Not in 0.55* (on main too): a reload opens the home page, not the Work that was open.

**#490–#502, the follow-ups before the merge (2026-11-17..18)**

- *#490*: a forked child wakes its parent when its first run ends.
- *#491, #497*: the completion notice's excerpt is the child's last reply (not every text of its run), up to 4,000
  characters, with a note when it is cut (§ 7 said 400).
- *#492*: deleting a Work with Works under it asks whether to delete only it, so they move to the top level, or the whole
  tree.
- *#493*: a reply to the address in a message's header reaches its sender; every message and notice ends with a fixed
  footer: it comes from another session, not the person, so it is not the person's approval, and what it reports is that
  session's claim, not a checked fact.
- *#494*: `start_session`'s description v3, the text the owner approved on 2026-11-18.
- *#496, #499, #501*: a call a live run is executing is never uncertain, and a verdict sent while a run is live is refused
  (409); a verdict on an action still running is refused and a late receipt after a verdict is not written; a verdict and
  the result it fills enter the log together.
- *#498, #502*: a child's notice for a parent deleted while it was being made writes nothing; a deleted Work keeps a
  tombstone, so no request opens it again, even after a restart.
- *The merge*: #500 merged `feat/messages` into `main` once, and 0.55.0 shipped from it.

## Decisions for the owner

**Owner rulings, 2026-11-16:** the durable inbox accepted (§ 4, reversing
ADR-0057's parked ruling); the capacity defaults accepted (§ 3); S2 and
S3 accepted (§ 10). The owner corrected the first draft's § 10: Send now
is the reference implementation's behaviour and kiso copied it; the defect is that
kiso hides it behind hover and never marks a line read.

**The core line approved** (owner, 2026-11-16): one `peer` kind in
`UserInputVia` and `isRuntimeInput`, one to three counted lines within
core's six lines of room (2,194 / 2,200), no gate change. The owner's condition,
which the design meets: the person's own lines and lines from other Works
must be told apart. They are, three ways: in the log (the person's line is
`source: "user"` with no `peer` via; a Work's line is `source: "system"`
with `via.kind: "peer"` and the sender's address), to the model (a Work's
line is framed as a message from the named Work, never as the person), and
to the hooks (only the person's line passes `onUserMessage`). Test 15
covers the first and third; the choice eval's transcripts are read for the
second.

**Outside review of the draft, 2026-11-16** (conditional pass, forwarded
by the owner): all taken, checked against e2a3dc43 first. M1: `isVia` is
the third core place (measured: two counted lines in all). M2: the wire
drops `via`, so the host sends a seq-bound frame (§ 11). M3: one
`user_input` per message (§ 3). M4: atomic capacity on full record bytes
(§ 3). Also: S3's order (§ 10), one budget across task and peer wakes
(§ 6), PR 2's invariants and its core-first commit (§ 15), tests 19–25.

**Leader, 2026-11-16:** cleared to start; one stream; base is
`origin/main` 2937a2d3; src/main and scripts/proofs budgets are full
(3500/3500, 3560/3560), so any raise is sent to the leader with its size and
reason for the owner's ruling, as its own `chore(web)` commit; the first
PR of the series waits for the owner's call on 0.54.3 before merging;
the file card used the existing artifact card and Previews (§ 11; then
withdrawn by the owner, below).

**Owner, 2026-11-16, three UI rulings relayed by the leader:** (1) no
file UI: `files` is an address for the model, and a path in a reply gets
no card (§ 3, § 11); (2) messages admitted together without a hold are
one "Received N messages" group (§ 11); (3) the Work card follows the
reference implementation's flow: one card for `named` and `proposed` with × and
Do it here / Start, kiso's usual Working state while the call runs (no
row of its own: corrected the same day), the started Work's "Started from"
line and the brief as its first user message, no environment options in
v1; "Suggestion expired" stays (§ 9).

**Open (2026-11-19):** the choice eval (§ 9), which gates turning the extension on by default
(`KISO_WEB_SESSIONS`, off until it passes; its third round, on description v3, scored 79 of 96
against a pass line of 82, with 9 unauthorised edits, so 0.55.0 ships it off); a Work started in the terminal and opened in the
web has no sessions tools (decided 2026-11-20: Amendment 1, § 17); merging the task and message wake budgets, after the
0.55 dogfood; a terminal that only receives messages (v2 candidate). (The coverage gaps of § 16 were closed by #480 and #481.)

## 17. Amendment 1 — a Work follows the host that opens it (owner, 2026-11-20)

**Decision (owner, 2026-11-20, option b of finding #6).** The rule "a Work keeps the tool table it was created with" (§ 2, and
§ 16's PR 1 mark) is **reversed**. A Work has the sessions tools in a host whose table has them and not in a host whose
table does not: kiso web with `KISO_WEB_SESSIONS=on` adds them to every Work it opens, including one the terminal made; the
terminal drops them again, and no longer carries twins that refuse. Why: a Work the person started in the terminal and
continued in the web had no `list_sessions`, `message` or `start_session`, and the model, finding them missing, said it was
"restricted" and imitated a child by shelling out a second kiso, which then showed as a top-level Work. The table changing
between hosts is accepted: the prefix cache misses once per switch, as it does for a model switch.

**Mechanism.**

1. Each host says what its table is: `AgentDefinition.sessionsTools` (the web host: whether the extension is on; the terminal:
   `false`). A caller that does not say (an SDK) leaves the mark and the revisions alone.
2. The sidecar's `sessionsTools` tenant is no longer "created with" but "the host that last wrote to the Work had them". It is
   set or cleared by the runtime in `AgentSession.persist`, **after the first event is written**: the Work's single-writer lock
   is held by then, so a **refused open writes nothing** (a live terminal still holding the Work: the web's run fails with
   "locked by another writer" and the mark and the profile are as they were), and a **stale lock is taken over as before**
   (ADR-0050). Opening alone writes nothing, as for a new Work (DC-60).
3. When the host's tool table differs from the recorded one, the next **profile revision** records it, in the same place and
   under the same lock; revisions stay monotone per Work (1, 2, 3 …). A table that already matches writes nothing: not the
   mark, not a revision. A new Work's revision 1 already has its table, so it gets no second revision.
4. The web host no longer marks a Work at its first open (`sessionsFor` returns the extension whenever the host runs with it
   on); the terminal no longer registers the refusing twins (`refusingSessionsExtension` and `SESSIONS_REFUSAL` are removed).
5. A fork carries the mark and the profile as they were at the fork (`writeForkSidecar`, unchanged); opened by the other host
   it goes on from that revision, and its parent is untouched.

**Not changed.** No core change: `Adapter`, the protocol and the kernel are as they were. The request's bytes for a Work the
web opens are those of a Work the web made (same tool table, same hash in the trace). Nothing mid-run: the table is read at
open, so a run in flight keeps its own. Messages already in an inbox of a Work opened by the terminal wait for the web, as
before (§ 4).

**Tests, each red before its fix.** `packages/runtime/tests/follow-host.test.ts` (gains and drops with a revision, no write
when the table matches, an SDK caller untouched, a refused open writes nothing, a fork); the web proof `follow-host` (a
terminal-born Work held by a live writer: refused and unwritten; opened after it lets go: marked, revision 2, the request's
tool hash equal to a web-born Work's; back to a host without the tools: unmarked, revision 3, replay intact);
`apps/cli/tests/sessions-follow-cli.test.ts` (test 14, rewritten: the three tools are unknown in the terminal, the mark is
cleared, nothing they would have made exists); the `sessions` proof (a Work made with the tools off has them when a host with
them opens it).
