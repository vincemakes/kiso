# ADR-0061: `edit_file` speaks `oldText`/`newText`

- **Status:** Accepted (the owner, 2026-10-08)
- **Date:** 2026-10-08
- **Layer:** `packages/tools-node` (`edit_file`'s schema and executor),
  `apps/cli` (one prompt line), `packages/tui-cells` and `packages/tui`
  (the readers of edit input). **No kernel line.**
- **Number:** 0060 is not reused. It was the committed revision witness,
  which was not adopted (PR #278, closed unmerged).

## The finding

A replay of the 2026-10-08 paired round's 38 kiso T6 legs rebuilt each
leg's files from the fixture and re-ran every edit call against the file
as it stood.

- **The replay is faithful:** 1,082 of 1,082 successful edits re-apply,
  and 86 of 86 failed ones fail again at the same hunk for the same
  reason.
- **80 of the 86 failures are `search` and `replace` swapped.** `replace`
  holds the text the file has (the anchor); `search` holds the anchor plus
  the new code. Swapped back, each matches exactly once.
- **The model mostly recovers.** The next edit of the file un-swaps 74 of
  the 80; a turn with one takes 5 requests instead of 4.
- **The in-order rule (ACI-3) caused 0 of the 86.**
- **The owner's own sessions show it too.** On the owner's disk (458
  session logs, counts only), 45 of 151 "pattern not found" failures carry
  the swap signature, against a base rate of 8% among successful hunks.

The words allow both readings. "replace" reads as "the text to replace";
kiso's own approval panel prints `search` under the label "replace:".
Inside `edits[]` neither field carried a description. A pair named old
and new cannot be read backwards.

## The decision

The model sees one form:

```
path              Workspace-relative file
edits             1-32 replacements, each { oldText, newText }
  oldText         Exact text to replace at this step; must match exactly
                  once after the earlier edits in this call
  newText         Replacement text for oldText
expectedRevision  The file's latest revision token
```

All three are required, and no other key is accepted.

**The description** asks for changes to the file that are already known
to go in one call. That is not "one call per file per turn": an edit
made after a test result is a new piece of evidence, not a split batch.
The system prompt loses "Prefer many small edits over one large write",
which pulled the other way.

**The principle:** compatibility belongs in the executor, and vocabulary
belongs in the schema. The executor still takes:

- legacy `{search, replace}` hunks;
- the legacy top-level `search`/`replace` pair;
- a hunk-level `expectedRevision`, which it ignores as before.

These reach it only from callers that skip schema validation: an approved
call persisted before the upgrade, a host calling `execute`, a test. A
hunk that mixes the two vocabularies takes neither half: the schema
refuses it from the model, and the executor refuses it from anyone else,
naming both sets.

**The swap hint.** When a hunk's `oldText` matches nowhere and its
`newText` matches exactly once, the refusal says so and names both
readings: "either this change is already applied, or oldText and newText
are swapped". A repeated edit and a swap leave the same evidence, so the
tool does not guess between them and applies nothing (ACI-2).

**The schema stays in a small portable subset by choice, with no
`oneOf`.** The validator (Ajv) would accept one, but with `edits` as the
only form there is nothing left to choose between.

## What this reverses, by name

- **WR-1E2's single-hunk XOR batch form** leaves the model-facing schema;
  the executor keeps it.
- **ACI-3's schema tolerance of a hunk-level `expectedRevision`.** The
  model no longer sees the key, and a model that still sends it gets a
  schema refusal. The executor still ignores it.
- **ACI-3's in-order matching is kept.** Its code comment had called it
  "the reference implementation's multi-edit". It is not: the reference
  matches every edit against the original and refuses overlaps. The
  comment is corrected.

## Durable logs written before the change

Recovery reaches an old-name call on two paths, and both are pinned by
`packages/runtime/tests/edit-fields-recovery.test.ts`.

- **Approved, not executed.** The EXECUTE step runs the persisted input
  without re-validating it, and the executor's legacy mapping applies it.
  The durable `tool_execution_started.input` keeps the original names; it
  is never rewritten.
- **Undecided.** The DECIDE_PERMISSION step preflights the call against
  today's schema (0430-F1). It is refused once as `invalid_input`, with no
  decision, no approval prompt and no execution. On continuation the model
  sees that result and may re-issue the call in the new vocabulary. Kiso
  guarantees only that the refusal reaches the model.

## For hosts

- **A host that builds `edit_file` calls itself** must send `edits` of
  `{oldText, newText}`. Schema validation refuses the old names; a direct
  `tool.execute` call still takes them.
- **A host that renders edit inputs from a log** should read both
  vocabularies. `hunksOf` in `@vincemakes/kiso-tui-cells/diff` does.

## Measured

The static request surface shrinks by 115 chars:

| part | before | after |
|---|---:|---:|
| `edit_file` schema | 995 chars | 918 chars |
| tool lines | 1,456 chars | 1,451 chars |
| system base | 1,723 chars | 1,690 chars |

Whether the steps move is decided by a paired round on the `op` route,
under criteria frozen before it runs (kiso-doc
`plan-edit-fields-2026-10-08.md`):

- **It ships as a reliability fix** if swaps fall to at most 0.2 times
  the control's, every guard passes, and T6 steps are non-inferior.
- **It also claims fewer steps** only if T6 requests fall at least 5%,
  with the bootstrap interval below zero.

## When to overturn

- **A model that swaps `oldText`/`newText` as often as it swapped
  `search`/`replace`.** That would mean the swap is not about the words.
  The hint stays in either case.
- **A provider whose tool dialect cannot express this schema.**
