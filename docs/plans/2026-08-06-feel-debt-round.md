# 手感批+技术债轮 — A 手感 / B 装修 / C 清账 (0.1.21)

2026-08-06. Spec: "手感批+技术债轮,发 0.1.21。汇报纪律照旧(clean-tree 两行);
各包 gate 内,逼近即停。"

## A — 手感

1. **A1 菜单 Enter 直提交**: the menu Enter submits directly when the
   selected item EXACTLY equals the typed input (完全体); a partial keeps
   the completion semantics. PTY e2e: "/compact⏎" ONE Enter executes —
   demonstrated RED on the old implementation, green now.
2. **A2 输入历史 ↑↓**: session-scoped in-memory history (cap 100, never
   persisted); ↑↓ browse ONLY from an empty input or while browsing
   (mid-edit keeps cursor semantics — the simple ruling); Esc exits the
   browse. Unit tests + PTY e2e (recall-and-resubmit runs a real turn).
3. **A3 MCP stderr 收纳**: the stdio child's stderr is CAPTURED into a
   per-server memory ring (tail 4KB, byte-safe UTF-8 trims — a trim never
   splits a multi-byte char) instead of leaking into the host terminal;
   mcp__status attaches each server's recent stderr; a failed handshake
   carries its dying stderr (ConnectError). e2e: RED on the old bundle
   (the noise landed BEFORE the banner at byte 127 vs the banner's 377),
   green now (the only appearance is inside the mcp__status result).
   Implementation note: cross-spawn REJECTS a raw Writable in the stdio
   array — the SDK's own `stderr: "pipe"` PassThrough path is the way in.

## B — 装修

### 4. 装修清单裁决 (the extraction round's recorded wishes)

Compiled from the plans' recorded out-of-scope lists (tui-v2a §4, v2b §8,
v2c §8, v2d §6, v2e §6, v3 §2 — "the decoration wishes go to the next
round's plan"). 逐条标注 做/不做/待办:

| wish | source | ruling |
|---|---|---|
| history ↑↓ | v2c/v2e | **做 — DONE (A2)** |
| menu Enter 直提交 | the 手感批 spec | **做 — DONE (A1)** |
| markdown 渲染 | v2d | 待办 (feature, on demand) |
| 语法高亮 | v2d/v2e | 待办 (feature, on demand) |
| word-level diff | v2e | 待办 (feature, on demand) |
| shell-output diff | v2e | 待办 (feature, on demand) |
| scrollback navigation | v2e | 待办 (feature, on demand) |
| expand interactions (key-select) | v2d | 待办 (feature, on demand) |
| i18n / 多语言 | v3 | 待办 (feature, on demand — UI stays English) |
| autocomplete | v2a/v2b/v2c | **不做** — the slash-menu completion IS the product shape |
| multiline editor | v2c | **不做** — single-line is a stated design |
| mouse | v2b/v2c/v2d | **不做** — the raw-mode keyboard model is the design |
| alt-screen | v2a/v2b | **不做** — contradicts the single-view redraw |
| differential rendering | v2a/v2b | **不做** — the cell renderer IS the answer |
| sticky bottom bar | v2a | **不做** — the dock IS the bottom bar |
| component systems | v2a/v2b | **不做** — the flat renderer is the design |
| images | v2a/v2b | **不做** — text terminal, honest markers instead |
| pi-tui deps / shape-copying | all | **不做** — the extraction exists to avoid pi coupling |

### 4b. 两大卫生 (pure moves, zero behavior)

- **apps/cli/index.ts (1512 lines) 拆模块**: state.ts (shared process
  state + setters), trust-ui.ts (trust gate / merges / ask / uncertain),
  faux-glue.ts, chat.ts (REPL + consumeRun + the C5 translator), dispatch.ts
  (the slash dispatcher, DispatchCtx), resume.ts; index.ts keeps the entry
  (banner, input sources, A 区 prompt, makeAgent, main). The moved exports
  (applyProjectMerges) are re-exported so the test imports never change.
- **runtime/session.ts (1192) 拆**: session.ts (AgentSession + SessionConfig),
  run.ts (the Run class), recovery.ts (openRunId / ABORTED / abortable /
  MergedSignal), compose.ts (E1/E2 composition); index re-exports all four.
- Acceptance: ZERO test-file edits; 558 tests green (was 548); the pipe
  run byte-identical vs the pre-split baseline; gates core 1914/2000 ·
  cli 1173/1320 · tui 1309/1520.

## C — 清账

5. **C5 tui 解耦 (P3)**: render's input is the tui's OWN data shape —
   `RenderInput` (a 16-member union defined in render.ts); the CLI
   translates Event→RenderInput (`toRenderInput` in chat.ts, null for
   events without a render). `grep @vincemakes/kiso-core` in tui = ZERO
   (only doc prose mentions remain). README experimental annotation
   dropped (API stays 0.x semantics). Zero behavior: 128 tui+cli tests
   green with assertions untouched, pipe byte-identical.
6. **C6 microcompact 边界计数 (P4)**: `microcompactBoundarySeq` now
   EXCLUDES do-not-compact-tagged results — 计数与清除口径一致. A tagged
   result is un-clearable forever, so counting it stole a keep-window
   slot and could anchor the boundary at a result the projection refuses
   to clear. Unit tests: red on the old count, green now.
7. **C7 跨 provider reasoning 护栏 (P4)**: the openai provider's
   thinking-mode detection is scoped to the CURRENT turn (messages after
   the last user message). The simple no-marker judgment, commented: the
   current turn's messages carry no source marker → the current session
   adapter is their source; OLD turns' reasoning (e.g. an
   anthropic-thinking history continued by an openai adapter) never flips
   the mode — the adapter would otherwise tag a turn it has no business
   tagging with `reasoning_content: ""`. Unit test (red→green).
8. **C8 /compact 自动触发 (opt-in)**: `AutoCompact { thresholdRatio }` —
   default OFF; only `KISO_AUTO_COMPACT=<ratio>` (0 < r < 1) enables it;
   checked after EVERY completed turn AND the startup recovery; reuses
   the /compact dispatch FULL path (same notices, same chain ordering,
   same mid-run refusal — the check's own isRunning guard just skips the
   refusal noise). PTY e2e: a seeded session sits at ~0.65 (the recovery
   microcompacts r0); one live turn adds 50K chars of model TEXT (tool
   results cap at OUTPUT_CAP = 100K and would displace a seed result from
   the kept window — the e2e's first attempt red this exact lesson) →
   post-turn ~0.71 → the auto notice + a durable summarized event, zero
   keystrokes.
9. **C9 MCP resources/prompts → 待办**: the MCP bridge exposes tools only;
   resources/prompts is a FEATURE (not debt) — 待办, trigger on demand
   (按需触发). Recorded here; nothing in the C 组 backlog.

## 范围外 (recorded)

- settings 文件 / `model` 命令 → 待办 (the spec's out-of-scope).
- resume 的 autoCompact: one-shot sessions end immediately; the next
  chat's recovery + turn check covers the ratio (recorded, not built).

## Evidence

- clean-tree at delivery: `git status --short` empty, `git log
  origin/main..HEAD --oneline` empty.
- Full suite: 558 → the round's additions (see the release record).
- Gates: core 1914/2000 · cli 1173/1320 · tui 1309/1520 — all inside.
- Release 0.1.21: eight packages, the standard template (post-publish
  notes appended below by the release record).
