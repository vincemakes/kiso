Translated from the original Chinese round record (2026-08-06)

# The todo extension round — the 4th official extension: long-horizon working memory, release 0.1.29

2026-08-06. Spec: "the todo extension round (the 4th official
extension, long-horizon working memory), release 0.1.29. Kernel + E1
loader: zero changes (core has 5 lines of headroom left — staying out
of core this round is a hard boundary)." Reporting discipline as usual.

## Evidence gathering (evidence before code)

- **The extension template** (extensions/skills/src/kiso-skills.mjs): a
  single .mjs file whose default export is the extension or a factory;
  `{name, tools, systemPrompt:{append}, approvals}`; the loader (E1)
  imports file by file — a plain .mjs with zero build works directly
  (safe-defaults is the precedent).
- **The do-not-compact mechanism already exists in core**
  (kernel/project.ts:46): the `DO_NOT_COMPACT` constant + two
  consumption sites — microcompact's clearance exclusion
  (loop.ts:1165's count accounting + project.ts:349's replacement
  pass) and the result-message tags passthrough (loop.ts:712's
  persistence). **todo_set is not in the MICROCOMPACTABLE whitelist**,
  microcompact never clears it — on this side the tag is defense in
  depth.
- **The /compact summary layer = the contract-hole checkpoint**:
  `summarizeConversation` (runtime) generates a summary of the covered
  range with SUMMARY_PROMPT, and the projection REPLACEs the covered
  content up to coversToSeq (ADR-0044) — if the covered range contains
  the latest todo_set round, the list is lost. The core projection
  semantics only know coversToSeq; **the boundary computation lives in
  runtime** (summaryBoundarySeq, called by session.summarize), so it
  can be closed without touching core: the boundary stops BEFORE the
  round of the newest do-not-compact result inside the covered range
  (a round boundary — the projection's never-split-a-message invariant
  holds).
- **The tui decoupling chain**: the CLI's consumeRun feeds body.*
  event by event (tool_result → body.toolResult); the tool_result
  event natively carries tags (no name). The render data shape is the
  tui's own RenderInput (render.ts, zero kiso-core imports). The
  checklist cell = a new BodyCell kind + a RenderInput variant; the
  CLI translates the tagged result into items (the key = the tag, not
  a name — whatever the extension declares is what the CLI renders; a
  parse failure falls back gracefully to a plain cell, never dropping
  information).
- **safe-defaults** = examples/extensions/safe-defaults.mjs (the
  tutorial extension): adding todo_set to its allow list satisfies
  "into allow (pure session state)".
- **Where the state lives**: the extension has zero internal state
  (pure validation + echo) — the list's persistence comes from the
  **event log** (the tool-result messages); after a kill -9, resume
  rebuilds it from the projection — contrasted with CC's in-process
  runtime state (the README selling-point sentence).

## Changes

1. **extensions/todo** (zero runtime dependencies, source-is-artifact —
   src/kiso-todo.mjs loads directly, no build):
   - `todo_set{items:[{text,status:"pending"|"active"|"done"}]}` — a
     whole-table replace (isomorphic to CC's TodoWrite, idempotent);
     validation: at most one active (more = invalid_input with the
     reason), the status enum, non-empty text (after trim), ≤50 items,
     text ≤500 characters — all invalid_input with an honest reason.
   - The result = a normalized echo:
     `[todo] N items — P pending, A active, D done` + one
     `[pending|active|done] <text>` line per item; deterministic (a
     pure function).
   - Result tags: ["do-not-compact"].
   - systemPrompt.append (≤15 lines of restrained English): ≥3 steps →
     build the list first (including one verify step) / mark active
     before acting (at most one) / mark done when complete / single
     steps don't need it / update after every step.
2. **The safe-defaults example extension**: todo_set into allow (pure
   session state, explained in a comment).
3. **The /compact summary layer closed** (runtime/src/summarize.ts,
   not core): summaryBoundarySeq's boundary is pulled in again — the
   newest do-not-compact tool result inside the covered range
   (prevPoint, base], the boundary stops before ITS round (that
   round's opening user_input); no tagged result in the round, or the
   result sits in the kept round → behavior unchanged; the protected
   round is the first round (boundary == prevPoint) → undefined
   (nothing to summarize).
4. **The tui checklist cell** (the tui package uses RenderInput's own
   shape — the decoupling discipline):
   - A RenderInput variant `{type:"checklist", header, items[{text,
     status}]}` + a renderEvent case (□ pending / ▖ active / ▣ done,
     the brick family, NO_COLOR-safe).
   - A BodyCell kind "checklist" + body.checklist(header, items) — the
     freeze semantics as usual (done:true, formed once); the
     passthrough path is byte-identical.
   - No resident pinning (v1).
5. **The CLI translation** (chat.ts consumeRun's tool_result branch): a
   result carrying the do-not-compact tag whose content parses as a
   checklist (one `[pending|active|done] <text>` per line) →
   body.checklist (header+items); a parse failure → the plain cell as
   before.

## Acceptance

- ① extension unit tests (todo.test.ts): whole-table replace
  idempotence / the single-active validation (more = invalid_input) /
  the status enum / the normalized-echo bytes / the empty-table echo /
  the bounds (50 items, 500 characters) / the do-not-compact tag /
  MICROCOMPACTABLE excludes todo_set (the core constant pinned).
- ② summarize unit tests: a tagged result inside the covered range →
  the boundary pulls back to before its round; no tagged → unchanged;
  tagged in the kept round → unchanged; the tagged round is the first
  round → undefined.
- ③ the long-horizon narrative PTY e2e (todo-e2e.test.ts, real PTY +
  real SIGKILL): build a 3-item list → complete 1 (the ask flow's y
  injection) → kill -9 (during round 7's slow shell execution) →
  resume (the rerun ruling) → the projection contains the newest list
  (do-not-compact working) → continue (the trajectory reaches
  terminal) → /compact → the projection still contains the newest list
  + the summary text, and round-1's old list is covered (the summary
  layer respects the tag — the contract hole is closed; if this
  checkpoint fails, stop and get a ruling per the stop clause).
- ④ pipe regression + gates zero regression: core not entered (hard
  boundary, zero diff); cli/tui have increments, inside the limits.

## Gates

- core 2000 (zero changes this round — the hard boundary) / cli 1856 /
  tui 1520 — the check record below.

## Release

0.1.29, the standard template flow (tag before publish; topology order;
post-publish verification).

## Acceptance

- clean-tree: `git status --short` empty + `git log origin/main..HEAD
  --oneline` empty (pushed).
- Out of scope: the /todos human command / pinned rendering / subtask
  nesting / priorities / activeForm.

## Release record (post-publish)

- **0.1.29 published, eight packages** (tag before publish; topology
  order core→evals→providers→tools-node→runtime→tui→cli; the
  `npm publish <path>` form hit npm's git-remote resolution pitfall
  (ls-remote ssh://git@github.com/packages/core.git garbled), switched
  to the `npm publish -w <pkg>` form, package by package success;
  post-publish verification: the registry's eight packages at 0.1.29,
  the global CLI at 0.1.29 after npm i -g --prefer-online).
- Gates: core **1995/2000 (zero diff — the hard boundary held)** · cli
  1573/1856 (+21: the checklist translation + hooks) · tui 1403/1520
  (+42: the checklist cell + RenderInput); **638 tests** (615 → +23:
  14 todo unit tests + 5 summarize-closing + 3 checklist rendering + 1
  long-horizon e2e); smoke 5 tiers PASS; demo PASS.
- The long-horizon e2e record: 7 user rounds (each round carries its
  own end_turn — /compact counts per round, a single-round long script
  has nothing to cover, and the FIRST e2e version died exactly there);
  the kill lands during round 7's shell execution (the predicate must
  match s1's started line, not a whole-file substring — the call_end
  line also carries name:"shell" and would kill early); resume's rerun
  ruling does **not re-execute** (the B group fills a denial), the
  trajectory continues to terminal; /compact runs in a separate chat
  process (resume is a one-shot command that exits when done); **the
  contract-hole checkpoint passed**: the summarized coversToSeq=9
  (round 2's input is at seq 10 — the closing pulled the boundary
  before the checklist round), the projection contains the newest list
  byte-for-byte + the summary text, round 1's old echo is covered.
- Out of scope unchanged: the /todos human command / pinned rendering /
  subtask nesting / priorities / activeForm.
