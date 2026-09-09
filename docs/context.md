# Context economy — microcompact, `/compact`, and the byte discipline

Three mechanisms, in the order a session meets them: a zero-API boundary
that clears old tool output, a model summary that compresses the
conversation itself, and the byte contract that keeps both of them
cache-friendly and replayable.

## MicroCompact — zero-API context relief

**The CLI ships it ON by default**: threshold = half the model window
(`KISO_CONTEXT_WINDOW` override included — 200k window → 100k tokens).
Library users opt in with `microcompact: { thresholdTokens }` in
`createAgent`. When a session's projected context crosses the threshold,
the loop appends **one** `microcompacted` boundary event to the stream —
never a per-turn progressive clearing. The projection then derives the
compacted view deterministically: tool results older than the boundary
whose tool is in the whitelist (`read_file`, `list_dir`, `search_text`,
`shell`) are replaced by the fixed placeholder
`[old tool output cleared: <tool> <arg>]`. write/edit outputs are never
touched; results tagged `do-not-compact` are never touched; recent turns
stay intact.

The decision is a persisted fact, not runtime state: the same events always
derive the same messages — a crash/resume replays the boundary and lands on
the byte-identical projection (see the byte discipline below). No counting
API, no price table, no tokens spent on the compaction itself.

**The model-summary layer (`/compact`, ADR-0044)**: the mechanical clearing
works on tool results only — the CONVERSATION still grows. `/compact`
(summarize the older conversation to free context) compresses the covered
rounds — everything before the most recent 4 rounds, from the last summary
point — into one durable `summarized` event via an off-loop call through
the session's own adapter. The projection replaces the covered range with
a single assistant summary message; the original events stay on disk
forever (the raw log, /last, and /think still reach them); a crash before
the persist is "nothing happened", after it the resume projects the
compressed view. The classic auto-compaction (`config.compaction` +
`compacted` events) was retired into the boundary by ADR-0044 — old logs
with `compacted` events replay verbatim, forever. (Matrix note: context
economy ◐→● — ◐ was the mechanical clearing alone, 0.1.19; ● adds the
model summary, 0.1.20.)

Wired end to end and test-verified: a session running through the real
runtime records the boundary on disk and a reloaded session projects the
placeholders (`packages/runtime/tests/microcompact-e2e.test.ts`); the CLI
resumes an over-threshold session with a tiny window and the boundary
lands (`apps/cli/tests/microcompact-cli.test.ts`).

## Prompt-cache byte discipline

Contract: the same event-stream prefix projects to a **byte-identical**
message prefix (`JSON.stringify`, element for element). New events only ever
change the projection at the tail — the one exception is the `microcompacted`
boundary, itself a persisted fact whose replay derives the same projection
every time. The contract is pinned by three regression tests
(`packages/core/tests/prompt-cache.test.ts`): ① the same log projects
identically twice, ② appending a turn leaves the old prefix byte-identical,
③ a microcompact boundary replays byte-identically after a JSON round-trip
(the crash + resume shape).
