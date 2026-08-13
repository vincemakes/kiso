# Concepts

The ideas behind kiso's runtime, in one place. The implementation's source
of truth is the code and the ADRs; this document is the map.

## Durable sessions

A *session* is an append-only event log identified by a string id, stored
on disk (JSONL, one event per line, monotonically increasing seq). The
store is the session — there is no in-memory source of truth that matters
after a crash. Opening the same id in a new process continues the same
session. This is what makes kiso agents *durable*: a process can die at
any instant and the conversation resumes from the log, not from memory.

## Persist-first

Every event is written to the store **before** it is yielded by `Run`.
There is no ephemeral event plane: what a consumer sees is what is already
on disk. The price of this property is the draft — see *drafts and the
void* below.

## The stream is the state

A run is an async iterable of `Event` in seq order. There is no "session
object state" to inspect separately from the stream: multi-turn context is
a *projection* of the log (the kernel projects the log into the model's
context each turn), and a UI renders the same log. One stream, one record,
one projection — three consumers (kernel, TUI, audit) with no third copy
of state to keep in sync.

## The event union (27 frozen variants)

Every variant is durable and frozen — the forever-ABI (ADR-0051 §1). They
sort into three projection roles (see `docs/sdk.md` §2 for the full table):

- **committed/projecting** — the rows that render as messages
  (user_input, tool_result, text_*/assistant_* boundaries, …);
- **draft observation** — model output in flight (text_delta, thinking,
  tool_call_*): persisted like everything else, committed only when a
  boundary (stop / user_input / terminal / compaction / summarized) closes
  the turn;
- **control fact** — durable machinery facts (usage, stop, terminal,
  permission_*, tool_execution_*, compacted, …): rendered as nothing, but
  they are the audit.

The contract sentence: **durable observation ≠ committed conversational
history**.

## Drafts and the void

A crash between a draft delta and its boundary leaves a *draft suffix* on
disk. On resume the kernel appends `model_output_abandoned` and the
projection voids `(voidFromSeq, marker.seq]` — **model output only**
(text_delta, thinking, tool_call_start/input_delta/end). Framework facts
(permissions, executions, results, inputs, terminals) are never voided: a
permission granted stays granted, a tool result stays a tool result, even
if the text around them is abandoned. A tool call inside a voided range
was never executed.

## The honest terminal

Every run ends with exactly one `terminal` event, whose `outcome.kind`
is a truthful classification — `completed` only when the run genuinely
completed. An API error never wears `completed`. Consumers assert on the
terminal; that is why every example in this repository asserts it.

## Recovery

Recovery is *per-run*, keyed by run id: only the **last open run** (no
terminal event) is recovered on `resume()`. Earlier runs that terminated
have their dangling approvals closed (`permission_expired`) — a dead run's
approval is never re-presented or resurrected. A run with a terminal is
history; a run without one is a crime scene the kernel cleans up.

## Permissions

A tool's `permissionPolicy` can `allow`, `deny`, or `defer`. `defer`
pauses the run: the kernel yields `permission_requested` and waits; the
human's `approve(decisionId, allow, reason)` is the durable answer
(`permission_decided`), recorded before the tool ever executes. On
resume, an undecided request is re-presented; an expired one never is.

## The four surfaces

- **Durable surface** — the frozen event ABI (ADR-0051); never changes.
- **SDK surface** — the curated root manifest of `@vincemakes/kiso-runtime`
  (38 names, pinned by the surface gate; `docs/sdk.md`).
- **Model request surface** — what the kernel sends to a model; measured
  by the bench, delta-free across releases.
- **Product surface** — the CLI and the extensions; free to evolve.

## What the core is not

Loop business logic, UI, permission policy, billing, skills content,
retrieval. Those live in packages and extensions, not in the 2,000-line
core. A core that decides them for you is a blob.
