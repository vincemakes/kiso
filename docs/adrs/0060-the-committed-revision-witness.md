# ADR-0060: the committed revision witness — the runtime binds the revision a mutation is based on

- **Status:** **Accepted** — the owner, 2026-10-08, in chat, on kiso-doc
  `plan-revision-witness-2026-10-08.md` rev 1. Two external reviews were
  folded in. The kernel seam (three lines), same-turn chaining and the
  ruling text below were each approved by name.
- **Date:** 2026-10-08
- **Layer:** `packages/core` (the `bindInput` seam, `ToolContext.committed`,
  the result ack), `packages/runtime` (the recovery path),
  `packages/tools-node` (the binder, the two file tools' contract).
- **Amends:** the WR-1 v2 adjudication (kiso-doc `kiso-wr1-spec.md`), in
  its citation clause only. Every invariant v2 protects stands.

## The ruling

> Revision is runtime-owned concurrency metadata, not model-authored
> intent. `write_file` and `edit_file` may take their expected revision
> only from successful read/write/edit observations of the committed,
> non-voided trajectory — never from current disk state or a voided
> observation. The bound revision is persisted in
> `tool_execution_started.input` before the handler runs.

## Why

On the 24-turn bench session (T6) kiso made about 21–25 more requests
per leg than the reference implementation, on the same model and task.
The largest located mechanism was reading a file again right before
editing it: about 9 times per leg against 1.5.

Those reads returned the SAME revision as the last edit receipt (148 of
148, kiso-doc `report-edit-discipline-2026-10-08.md`). The model was
re-establishing a token it already held. Three prompt wordings failed to
move the step count: 2026-09-16 version 1, the 2026-10-08 edit-discipline
round, and H-REV. A deterministic program can carry this bookkeeping, and
now does.

## What WR-1 v2 decided, and what changes

v2 withdrew v1's process-local FileLedger, because a precommit-safe read
inside a turn that later voids would have authorised a write through a
side channel. v2 made the revision ride the tool RESULT, with the MODEL
citing it back. Authority lived in the committed context.

This ADR keeps the source and moves the citation. The witness is read
from the committed context: the projection, `projectMessages`, exactly
what the model sees. The model no longer has to copy it.

- **A voided draft is absent from the projection by construction.** The
  WR-1 gate pins this, so a voided read is never a witness. A draft that
  recovery COMMITS (a complete call, ADR-0047) is in the projection and
  is one.
- **The disk is never read for a witness.** Taking it from current bytes
  would make the stale guard compare the file with itself.
- **The stale guard is unchanged.** A write by anyone else after the
  witness is refused as before, and so is a non-atomic replace window.
  Atomic create via `link(2)` is unchanged.
- **An existing file with no witness is refused.** The message says
  "read it first". There is no blind overwrite.

## The mechanism

1. **`Tool.bindInput?(input, ctx)`** (core). It completes the model's input
   BEFORE the durable start. `runLedgered` persists the BOUND input in
   `tool_execution_started` and hands the same object to `execute` and
   `onPostTool`: the record is exactly what ran.
2. **`ToolContext.committed?()`** (core). It returns the projection; the
   kernel passes its own `derive`.
3. **The result ack** (core). `runLedgered` waits for its final event to be
   appended before it returns. The next exclusive call therefore binds
   against a log that holds its predecessor's receipt, and two edits of
   one file in one message chain through the first edit's receipt.
   - Edit 2's `search` text is itself an exact content check: if edit 1
     changed edit 2's target, edit 2 fails with nothing applied.
   - This is the in-order semantics `edits[]` already has.
4. **The recovery path** (runtime, `Run.#executePersisted`). An invocation
   that already STARTED reuses its persisted input and never re-derives
   it, so a resume never moves to a newer revision. One that never
   started is bound through the same `bindInput`.
5. **The file tools** (tools-node, `witness.ts`). The witness is the last
   `[rev:…]` trailer that a read_file, write_file or edit_file result shows
   for the same resolved path. A refusal that shows the current text
   counts as an observation.
   - `expectedRevision` becomes OPTIONAL. A value the model gives is kept
     as is.
   - The "cite the file's latest revision" guideline is gone (it was
     printed once per tool). The refusals no longer teach citation.

## Consequences

- **Kernel 2,194 → 2,197 of 2,200.**
- **Smaller tool table:** −307 bytes of guideline prose (the 0.40.6
  byte fixture regenerated once, the diff exactly those two lines).
  Every edit call is also shorter.
- **For hosts:** `ToolContext.committed` and `Tool.bindInput` are new
  optional fields. A host's own tools are unaffected unless they declare
  `bindInput`. The file tools no longer REQUIRE `expectedRevision`. A host
  that calls them directly, with no `committed`, gets the old behaviour:
  an omitted revision on an existing file is refused.
- **The evidence bar:** a paired T6 round (16 pairs, steps primary)
  decides whether this ships. The mechanism gate requires reads of an
  edited file to fall by at least half, with stale refusals not rising.

## When to overturn

- **If a model routinely relies on reading to SEE the file after its own
  edit**, and not to re-establish the token, the read-back will remain
  and the change buys only the shorter arguments. Then the next step is
  the edit result's content, not this binding.
- **If the projection ever stops dropping voided drafts,** this ADR's
  safety argument goes with it. The WR-1 gate and this ADR's tests are
  the tripwires.
