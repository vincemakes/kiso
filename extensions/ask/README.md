# kiso-ask-ext

The kiso official ask extension: `ask_user` option panels — the model puts
a real choice to the human, and the answers become durable facts.

One call carries 1-4 questions; each has 2-4 options with optional
one-line descriptions, single or multi select. The human can also type a
free-form answer, or decline — and a decline is recorded honestly, naming
the questions that went unanswered rather than passing for silence.

## How it is loaded

This extension ships **built-in** with the kiso CLI, and only on an
interactive terminal. The factory takes the panel bridge, so a headless
session has nothing to pass: its tool table never mentions `ask_user`, and
a piped run pays no prompt rent for a question nobody could answer.

The same artifact can be installed as a user-level extension (copy
`dist/kiso-ask.mjs` into `~/.kiso/extensions/`), in which case the
installing code supplies its own bridge.

## Durability

No new mechanisms. The call is durable as its `tool_call_end`, the answers
as its `tool_result`, and recovery is the ledger every other tool uses.
The tool declares `idempotent: true` — asking again is safe, because a
question has no side effect. An answered call therefore never re-asks,
including across `kill -9`; an interrupted, unanswered one is surfaced on
resume for an explicit re-ask.

## Configuration

None.

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
