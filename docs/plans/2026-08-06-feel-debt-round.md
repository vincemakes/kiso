Translated from the original Chinese round record (2026-08-06)

# The ergonomics batch + technical-debt round — A ergonomics / B decoration / C settling (0.1.21)

2026-08-06. Spec: "the ergonomics batch + the technical-debt round,
release 0.1.21. Reporting discipline as usual (the two clean-tree lines);
stay inside each package's gate — approach the limit and stop."

## A — ergonomics

1. **A1 the menu's Enter direct-submit**: the menu Enter submits directly
   when the selected item EXACTLY equals the typed input (the full-form
   case); a partial keeps the completion semantics. PTY e2e: "/compact⏎"
   ONE Enter executes — demonstrated RED on the old implementation,
   green now.
2. **A2 input history ↑↓**: session-scoped in-memory history (cap 100,
   never persisted); ↑↓ browse ONLY from an empty input or while
   browsing (mid-edit keeps cursor semantics — the simple ruling); Esc
   exits the browse. Unit tests + PTY e2e (recall-and-resubmit runs a
   real turn).
3. **A3 MCP stderr containment**: the stdio child's stderr is CAPTURED
   into a per-server memory ring (tail 4KB, byte-safe UTF-8 trims — a
   trim never splits a multi-byte char) instead of leaking into the host
   terminal; mcp__status attaches each server's recent stderr; a failed
   handshake carries its dying stderr (ConnectError). e2e: RED on the
   old bundle (the noise landed BEFORE the banner at byte 127 vs the
   banner's 377), green now (the only appearance is inside the
   mcp__status result). Implementation note: cross-spawn REJECTS a raw
   Writable in the stdio array — the SDK's own `stderr: "pipe"`
   PassThrough path is the way in.

## B — decoration

### 4. The decoration-list ruling (the extraction round's recorded wishes)

Compiled from the plans' recorded out-of-scope lists (tui-v2a §4, v2b §8,
v2c §8, v2d §6, v2e §6, v3 §2 — "the decoration wishes go to the next
round's plan"). Each item is marked do / don't / backlog:

| wish | source | ruling |
|---|---|---|
| history ↑↓ | v2c/v2e | **Do — DONE (A2)** |
| menu Enter direct submit | the ergonomics-batch spec | **Do — DONE (A1)** |
| markdown rendering | v2d | Backlog (feature, on demand) |
| syntax highlighting | v2d/v2e | Backlog (feature, on demand) |
| word-level diff | v2e | Backlog (feature, on demand) |
| shell-output diff | v2e | Backlog (feature, on demand) |
| scrollback navigation | v2e | Backlog (feature, on demand) |
| expand interactions (key-select) | v2d | Backlog (feature, on demand) |
| i18n / multilingual | v3 | Backlog (feature, on demand — UI stays English) |
| autocomplete | v2a/v2b/v2c | **Don't** — the slash-menu completion IS the product shape |
| multiline editor | v2c | **Don't** — single-line is a stated design |
| mouse | v2b/v2c/v2d | **Don't** — the raw-mode keyboard model is the design |
| alt-screen | v2a/v2b | **Don't** — contradicts the single-view redraw |
| differential rendering | v2a/v2b | **Don't** — the cell renderer IS the answer |
| sticky bottom bar | v2a | **Don't** — the dock IS the bottom bar |
| component systems | v2a/v2b | **Don't** — the flat renderer is the design |
| images | v2a/v2b | **Don't** — text terminal, honest markers instead |
| pi-tui deps / shape-copying | all | **Don't** — the extraction exists to avoid pi coupling |

### 4b. The two hygiene cleanups (pure moves, zero behavior)

- **apps/cli/index.ts (1512 lines) split into modules**: state.ts
  (shared process state + setters), trust-ui.ts (trust gate / merges /
  ask / uncertain), faux-glue.ts, chat.ts (REPL + consumeRun + the C5
  translator), dispatch.ts (the slash dispatcher, DispatchCtx),
  resume.ts; index.ts keeps the entry (banner, input sources, the
  A-area prompt, makeAgent, main). The moved exports
  (applyProjectMerges) are re-exported so the test imports never change.
- **runtime/session.ts (1192) split**: session.ts (AgentSession +
  SessionConfig), run.ts (the Run class), recovery.ts (openRunId /
  ABORTED / abortable / MergedSignal), compose.ts (E1/E2 composition);
  index re-exports all four.
- Acceptance: ZERO test-file edits; 558 tests green (was 548); the pipe
  run byte-identical vs the pre-split baseline; gates core 1914/2000 ·
  cli 1173/1320 · tui 1309/1520.

## C — settling

5. **C5 tui decoupling (P3)**: render's input is the tui's OWN data
   shape — `RenderInput` (a 16-member union defined in render.ts); the
   CLI translates Event→RenderInput (`toRenderInput` in chat.ts, null
   for events without a render). `grep @vincemakes/kiso-core` in tui =
   ZERO (only doc prose mentions remain). README experimental annotation
   dropped (API stays 0.x semantics). Zero behavior: 128 tui+cli tests
   green with assertions untouched, pipe byte-identical.
6. **C6 the microcompact boundary count (P4)**: `microcompactBoundarySeq`
   now EXCLUDES do-not-compact-tagged results — the count and the
   clearance share one accounting. A tagged result is un-clearable
   forever, so counting it stole a keep-window slot and could anchor the
   boundary at a result the projection refuses to clear. Unit tests: red
   on the old count, green now.
7. **C7 the cross-provider reasoning guardrail (P4)**: the openai
   provider's thinking-mode detection is scoped to the CURRENT turn
   (messages after the last user message). The simple no-marker
   judgment, commented: the current turn's messages carry no source
   marker → the current session adapter is their source; OLD turns'
   reasoning (e.g. an anthropic-thinking history continued by an openai
   adapter) never flips the mode — the adapter would otherwise tag a
   turn it has no business tagging with `reasoning_content: ""`. Unit
   test (red→green).
8. **C8 the /compact auto-trigger (opt-in)**: `AutoCompact {
   thresholdRatio }` — default OFF; only `KISO_AUTO_COMPACT=<ratio>`
   (0 < r < 1) enables it; checked after EVERY completed turn AND the
   startup recovery; reuses the /compact dispatch FULL path (same
   notices, same chain ordering, same mid-run refusal — the check's own
   isRunning guard just skips the refusal noise). PTY e2e: a seeded
   session sits at ~0.65 (the recovery microcompacts r0); one live turn
   adds 50K chars of model TEXT (tool results cap at OUTPUT_CAP = 100K
   and would displace a seed result from the kept window — the e2e's
   first attempt red this exact lesson) → post-turn ~0.71 → the auto
   notice + a durable summarized event, zero keystrokes.
9. **C9 MCP resources/prompts → backlog**: the MCP bridge exposes tools
   only; resources/prompts is a FEATURE (not debt) — backlog, triggered
   on demand. Recorded here; nothing in the C group backlog.

## Out of scope (recorded)

- the settings file / the `model` command → backlog (the spec's
  out-of-scope).
- resume's autoCompact: one-shot sessions end immediately; the next
  chat's recovery + turn check covers the ratio (recorded, not built).

## Evidence

- clean-tree at delivery: `git status --short` empty, `git log
  origin/main..HEAD --oneline` empty.
- Full suite: **563 green** (was 548 — +15: A1/A2 feel e2e, the A2 unit
  tests, A3 ring units + e2e, C6, C7, C8 PTY e2e + the C8 pipe pin).
- Gates: core 1914/2000 · cli 1231/1320 · tui 1334/1520 — all inside.
- Release 0.1.21: eight packages, the standard template (post-publish
  notes below).

## Post-publish notes (0.1.21 + the 0.1.22 CLI patch)

- Registry: all eight @vincemakes/kiso-* at 0.1.21 (direct curl, all
  present immediately). Fresh-install smoke PASS across all five consumer
  tiers on packed artifacts. Three bare runs of the installed CLI
  (exit 0: `~`, `/`, an empty non-git dir) + the real-extension run
  (`[4 extensions: mcp, skills, subagent, safe-defaults]` — and the A3
  capture held: no stdio chatter). Published-artifact idle probe: 8s
  idle → 293B, clean close, no dangling CSI.
- **The published-artifact verification caught a real race (C8)**: in
  PIPE mode the auto-compact silently never ran — EOF closes the input
  early, so the exit-time `await chain` captured the chain BEFORE the
  turn's auto-compact append. Fixed: the exit re-awaits the chain once
  after the turn (a turn-internal await would be circular — the appended
  segment chains after the turn's own promise); pinned by a pipe-shape
  regression test (red on the pre-fix code). The CLI shipped the patch
  as **0.1.22** (cli-only; the other seven packages stay at 0.1.21, deps
  unchanged). Published-artifact pipe smoke on the installed 0.1.22:
  `[/compact] saved ~97,598 tokens` + a durable summarized event.
- The mcp bundle (A3) is a drop-in extension artifact: the running
  `~/.kiso/extensions/kiso-mcp.mjs` is refreshed by the E1 convention
  (copy the rebuilt bundle in) — noted, not part of the npm release.
- Gates after the fix: core 1914/2000 · cli 1231/1320 · tui 1334/1520.
