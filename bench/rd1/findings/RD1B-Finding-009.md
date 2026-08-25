# RD1B-Finding-009 — the session ID aliases sequential sessions

- **id:** RD1B-F9
- **class:** durable identity
- **severity:** P1 — a session silently inherits another session's durable
  history, in a product whose promise is durable sessions
- **agent:** kiso 0.15.1 (published) and every earlier version
- **found by:** the fable authority review of Roadmap v6; severity and
  mechanism corrected by an independent pass and then demonstrated
- **status:** OPEN. Red test landed
  (`apps/cli/tests/session-id-identity.test.ts`); fix proposed, not applied.

## The behaviour

An auto-generated session ID is minute-granular with no entropy:

```
new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)   →  2026-08-25T02-22
```

generated identically at four sites (`apps/cli/src/index.ts:790,802,917`;
`apps/cli/src/dispatch.ts:410`). `SessionStore` is one file per ID
(`packages/runtime/src/store.ts:132`). So **two sessions started in the same
wall-clock minute are the same session.**

Demonstrated — two independent `kiso chat` launches, isolated `KISO_HOME`:

```
sessions/ after two launches:  1 file — 2026-08-25T02-22.jsonl
its user_input rows:           ["turn from session 1", "turn from session 2"]
```

The second launch presents as a fresh session and is transparently appending
to the first one's durable log.

## What it is NOT — the first write-up got this wrong

An earlier version of this finding said "two concurrent `kiso -p` runs silently
merge histories". **That is false and it would have sent the fix at the wrong
layer.** The store holds a single-writer link lock (ADR-0050), and
`packages/runtime/tests/storage.test.ts:112` already pins that *"a second writer
cannot append while the first holds the lock"*. **Simultaneous** writers fail
loudly and correctly.

The defect is **sequential identity aliasing**, not a race. Recording the
correction because the wrong mechanism was stated confidently and would have
produced a fix for a bug that does not exist — the same failure this round has
already paid for twice.

## Why it matters here

kiso's differentiator is that a long task keeps its history across
interruption. An ID that can silently name someone else's history is a
durability defect on exactly that promise. The unattended path is where it
bites: scripted or CI launches cluster in time far more than human ones.

## The red test

`apps/cli/tests/session-id-identity.test.ts` — two sequential launches must
produce two durable logs, each carrying input from one launch.

It carries a **timing-honesty guard**: the aliasing is only observable if both
launches land in the same minute, so the test checks the boundary, retries
once, and **fails loudly if it never observed the window** rather than passing
because it missed it. A test that goes green for want of an observation is
worse than one that goes red.

It is committed as **`it.fails`**, which pins the defect without leaving the
tree red. The body is the assertion the fixed product must satisfy; it throws
today (*"two launches produced 1 durable log(s)"*), so `.fails` passes. **When
F9 is fixed this case starts FAILING** — that is the alarm — and the fix flips
`.fails` back to a plain `it` in the same commit. `it.fails` here pins the
defect; it does not bless it.

## Proposed fix (not applied — owner's call)

Extend the stamp to seconds and add a short random suffix, from **one shared
helper** rather than four copies:

```
2026-08-25T02-22        ->  2026-08-25T02-22-30-a4f2
```

Blast radius, measured:

- **Ordering survives.** The only consumer of ID shape is
  `store.ts:353` — `metas.sort((a, b) => a.id.localeCompare(b.id))`.
  Lexicographic order still tracks time across minutes, and the suffix only
  breaks ties inside one second. Verified by construction.
- **Nothing parses an ID back into a date.** `store.ts` validates the id and
  never interprets it.
- **Old sessions are untouched.** No rename, no migration: existing files keep
  their names, still resume by ID, and still sort before same-minute new IDs.
- **Explicit IDs are unaffected** — `kiso chat <name>` never enters this path.
- Four duplicated expressions become one helper, which is also how they would
  otherwise drift apart.

## Release question

The fix is small and self-contained, so it can ride the same patch release as
RD1B-F1 and RD1B-F6. If the owner would rather not widen that release, F1/F6
go first — they are already landed and verified — and F9 follows. **What it
must not do is wait for a protocol round**: it is a durable-identity defect in
the shipped product.
