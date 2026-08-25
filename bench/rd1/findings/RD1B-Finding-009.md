# RD1B-Finding-009 — the session ID aliases sequential sessions

- **id:** RD1B-F9
- **class:** durable identity
- **severity:** P1 — a session silently inherits another session's durable
  history, in a product whose promise is durable sessions
- **agent:** kiso 0.15.1 (published) and every earlier version
- **found by:** the fable authority review of Roadmap v6; severity and
  mechanism corrected by an independent pass and then demonstrated
- **status:** FIXED (`3a9aaa9` + the F9a follow-up). Shipped in no release
  yet — it belongs in the same patch as RD1B-F1 and RD1B-F6.

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

It shipped first as **`it.fails`**, pinning the defect without leaving the tree
red, with the flip instruction written into it. The fix flipped it back to a
plain `it`: red on the aliasing, then green. **The alarm worked on its own
author** — flipping it was what produced the red.

## The fix

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

## F9a — the entropy claim was wrong, and the fix does not rest on entropy

The first version of the helper carried a doc comment calling the id
"collision-safe at any launch rate a human **or a script** produces". That was
an unmeasured claim and it is false. Measured, at a fixed second:

| draws in one second | collisions observed (5 runs) | P(at least one), theory |
|---|---|---|
| 100 | 0, 1, 0, 0, 0 | 7.27% |
| 1,000 | 7, 10, 2, 6, 7 | — |

A 16-bit suffix is thin at script rates, and scripted launches are exactly the
unattended path this finding is about.

**The correction was not "add entropy".** Widening the suffix would have pushed
the id past 24 characters — the session picker's id column cap
(`packages/tui/src/session-picker.ts:112`) — hiding the very bytes that
distinguish two ids. Instead `newSessionId` takes the sessions directory and
**will not return an id whose `.jsonl` or `.lock` already exists**; it draws
again, up to a bound, and throws rather than returning a colliding id.

So the guarantee is stated exactly:

- **sequential collision — eliminated by construction.** Entropy only decides
  how often a redraw is needed.
- **concurrent collision — still possible, and already correct**: the store's
  single-writer link lock fails the second writer loudly. Loud failure is the
  right outcome; silent sharing was the defect.

`apps/cli/tests/session-id-collision.test.ts` forces the redraw path with an
injected random source — waiting for a 1-in-65,536 event to occur naturally is
not a test — and pins the 24-character width and the sort order.

## Regression gate

Neither existing smoke could have caught F9: `bench/packed-pty-smoke.sh`
launched once, and `scripts/smoke.mjs` uses an explicit id (`cli-smoke`), so
the generator was never exercised twice. **The defect shipped through both.**

The packed smoke now launches twice with no explicit id into one fresh
`KISO_HOME` and asserts two distinct durable logs. It types a prompt in each
launch, because a run-less session appends nothing — an earlier draft of this
gate asserted on two `exit`-only launches and **would have passed on a broken
build by finding zero logs on both sides**.

## Release question

The fix is small and self-contained, so it can ride the same patch release as
RD1B-F1 and RD1B-F6. If the owner would rather not widen that release, F1/F6
go first — they are already landed and verified — and F9 follows. **What it
must not do is wait for a protocol round**: it is a durable-identity defect in
the shipped product.
