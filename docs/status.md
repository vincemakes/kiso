# Status — what is delivered, and what the gates measure

Everything on this page is MEASURED by `npm run check`. The size gates:
the core is enforced, the cli/tui/tui-cells caps are report-only since
ADR-0043 Amendment 8 — those numbers are pressure readings, not passed
gates. The kernel rule itself is in [kernel-rule.md](kernel-rule.md).

**The Durable Execution Contract is frozen** (ADR-0051, the 0.2.x line): the
session format and its recovery semantics are contract, every invariant
enforced by the gates below, and the 0.2.x line is where the semver public
promise of that ABI is expressed (ADR-0051 Amendment 2, which superseded
Amendment 1's 1.0.0 wording; the real 1.0 is owner-decreed). The road here: the
reliable-session alpha and its four hardening rounds (areas 1-7, A-F,
one through nine, and the fourth adversarial round — see
`docs/plans/2026-08-03-reliable-session-alpha.md`), the **kiso code**
round (the coding agent: kill -9 gate, microcompact, byte discipline —
`docs/plans/2026-08-04-kiso-code.md`), the **extensions** round (E1:
the approval-policy extension system; E2: the compaction parameter and
systemPrompt append surfaces — `docs/plans/2026-08-04-extensions-e1.md`),
and the durability line R-E→R-H (the straddle ruling, recovery as
projection, the dead-holder takeover, the freeze itself). Everything
below is MEASURED by `npm run check` (the size gates: core is enforced,
the cli/tui/tui-cells caps are report-only since Amendment 8 — the
numbers are pressure readings, not passed gates):

- **core** (2,139/2,200 lines, enforced) — protocol, loop (single honest terminal;
  missing/duplicate stops and tool_use-without-a-call are structured
  errors; a retryable pre-stream failure retries in place, and a
  mid-stream cut retries over a durably voided draft — never a silent
  re-stream, never a glued projection (F4); one abort signal reaches
  backoff, approval waits, every pending tool, and the SDK), hooks,
  permissions, microcompact (a `microcompacted` boundary is a
  persisted fact — the projection derives the compacted view
  deterministically; whitelist read/list/search/shell, `do-not-compact`
  respected, recent turns intact), the extension policy chain (E1: a
  deny > allow > ask composition decided BEFORE the human flow — allow/deny
  recorded durably with `decidedBy`, a throwing policy counts as ask, a
  durable verdict survives kill -9 and the policy never re-runs), delivery
  truth, the lossless event-log projection (messages are a pure function of
  the log, ADR-0002 — and the prompt-cache byte discipline: the same event
  prefix projects to the same message prefix, byte for byte, pinned by
  three regression tests), and the execution ledger keyed by framework
  `executionId` (ADR-0025): a confirmed success is never re-run, a new
  logical call always runs, and uncertainty is the crash window alone — an
  execution that started and never reported (ADR-0038; a receipted failure
  is a clean failure whose result carries the honest partial-side-effect
  note, and the retry re-passes the approval chain).
- **runtime** — `createAgent` / durable multi-turn sessions / crash-safe
  JSONL store (torn-tail repair under a kernel-flock cross-process writer
  lock — upgrade requires QUARANTINE: stop every old-format process before
  starting the new version; the pidfile guard is best-effort, not a
  seamless rolling upgrade (the fifth round P1-4), strict
  load, contiguous-seq validation) / `session.resume()` continues the
  INTERRUPTED run across processes: durable approvals are applied (the
  original call executes once, denials write their result), missing
  receipts are filled, and the original run completes — no invented turns /
  `loadExtensions(dir)`: every *.mjs default export (or factory), loud
  startup failure on a bad file or duplicate name; extension tools merge
  into the registry (built-in collision = startup error), hooks compose
  AFTER the harness's own (existing-first), approvals enter the policy chain.
- **cli** (3,660 lines against a 1,920 report-only cap) — the coding agent: bare `kiso` enters chat;
  the startup extension scan — the built-in layer first (the three default
  official extensions load in-process by module import: mcp, skills,
  subagent; E5: task is opt-in — a user copy shadows loudly, a project
  copy is refused), then
  `~/.kiso/extensions/*.mjs` (banner `[3 extensions: built-in: mcp,
  skills, subagent]`, user names appended bare, project ones marked
  `project:`);
  a system prompt (coding-agent discipline: read before edit, careful
  shell) composed from a constant, with AGENTS.md/CLAUDE.md injected and
  truncated at 8KB; one-line tool summaries per call
  (`✓ edit src/foo.ts (+12 -3)` / `✗ shell npm test (exit 1)`), the status
  line (`[turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]` — usage
  events only, unknown fields omitted entirely, faux mode shows
  `[turn N · faux]`), and `/last` to print the most recent tool call's
  full input/output straight from the event stream. The first-run scaffold
  (0.1.45): the trust verdict is a fresh home's FIRST access of any kind —
  only after the grant does the config surface materialize (`config.json`
  + the sentinel), silently, and a sentinel-marked home never re-scaffolds
  or clobbers your config. v2a/v5/KC3 — **the identity is monochrome**:
  shades of black and white carry the interface, and colour is reserved
  for the three things that MEAN something. Bright-white BOLD (SGR 1) is
  the accent (the you> prompt, the banner tagline, ✓ marks, command
  names, the user block's ▍ rail, the input brick); a light-gray
  inline-code tint (256 color 252) marks backtick spans in assistant
  text; dim carries metadata. TUI2-MD — **assistant prose renders
  markdown** under that same discipline: headings are bold with the
  marker stripped and the numbering kept, `**bold**` is bold, `*italic*`
  is SGR 3 (an attribute, not a colour — the round's ONE addition to the
  alphabet, harmless on a terminal without italics), backtick spans take
  the existing tint, fenced code gets a dim `│` gutter and a dim language
  tag with ZERO highlighting, lists normalize to `•` with a HANGING
  indent so wrapped items align to their text column, tables draw with
  dim rails and degrade at narrow widths to one record per row rather
  than truncating anything, blockquotes get a dim `▏`, links render as
  bright text plus a dim `(url)`, and `~~strike~~` keeps its literal
  markers (SGR 9's terminal support is too fragmented to promise). CJK
  breaks per character, so a space-free run wraps correctly instead of
  overflowing. Streaming is BLOCK-FREEZE: a block that has closed commits
  to the native scrollback and is never re-rendered, so the live region
  holds one block no matter how long the message is. A pipe still gets
  the model's own markdown bytes, unchanged, and `/think` and `/last`
  stay raw. The functional exceptions are the only
  colour left in the interface: green for the approval diff's additions
  and red for errors — with yellow reserved for warnings under the same
  rule (the palette has no yellow entry today). Everything else is
  plain; `NO_COLOR` or a
  pipe disables it all (pipes carry zero ANSI); typed input is echoed by readline itself,
  never rendered twice; a spinner glyph shows liveness between the request
  and the first delta. v2b: thinking blocks fold to ONE dim line per block
  (first 100 chars + ` (… /think shows full)`, `/think` prints the last
  complete block), the `[result]` echo truncates at 160 chars +
  ` (/last for full)` — the content strategy is the same in pipes; on a
  color TTY the UI docks to the bottom (ADR-0039): four pinned rows — an
  upper dim separator, the `▌` input line, a lower separator, and a LIVE
  status bar (idle `▸ <mode> · /mode to switch · …` with the right-aligned
  dim `/ commands · ↑ history` hint — cut first when the window is
  narrow; running `▖ working Ns · esc stop · alt+⏎ redirect · …`); an ask panel takes
the same position and answers at the input line (`1-4 pick · t type · esc
decline`); the body scrolls
  with real LFs into the native scrollback (v2d-B, ADR-0040 — no scroll
  region); approval/uncertainty/trust questions take over the
  status position and are answered at the input line; SIGWINCH
  re-applies the region, bottom redraws are wrapped in CSI 2026
  synchronized output, and every exit path resets the terminal in a
  finally (`\x1b[r`) — a `kill -9` can leave the bottom rows stuck, and
  the terminal's `reset` command saves it. v2c: the TTY path draws its own input line (ADR-0039
  Amendment 2) — a zero-dependency raw-mode editor (display-width cursor
  math — CJK wide chars land on the right column, the hard acceptance —
  bracketed paste, horizontal scrolling with a dim … marker) with the
  kiso brick motif: a bold half-block ▌you> row and a dim dotted ╌
  separator; the sent line renders into the body exactly once, a turn
  submitted while another runs queues with a live `+N queued` status, and
  Esc aborts. KC1: the input is a MULTI-LINE composer — a paste keeps its
  newlines (LF/CR/CRLF all normalize to one), Ctrl+J (or Shift+Enter where
  the terminal encodes it) inserts a newline, Enter sends the whole block
  as ONE turn, and the box grows to at most 6 rows before scrolling
  internally. KC2: **Alt+Enter (or Ctrl+Enter) REDIRECTS** — one gesture
  aborts the running turn and sends what you just typed instead, ahead of
  anything already queued; Esc alone still just stops. KC3: **`@` opens a
  fuzzy file picker** — typed at a word boundary (never mid-word, so an
  email address stays an address), it lists the project's files above the
  composer: a case-insensitive subsequence match over the whole relative
  path, ranked by the longest contiguous run then the shortest path, the
  matched characters bold, five rows at a time with a `(n/total)` counter
  that says so when the list was capped. ↑↓ select, Tab or Enter accepts,
  Esc closes and leaves your sentence alone. Accepting inserts the
  **canonical path and nothing else** — never the file's contents: the
  model gets a reference it can choose to read, so an `@` mention costs a
  path instead of a file, and `read_file` pays only for the bytes it
  actually needs. The list is `git ls-files` (tracked + untracked, minus
  everything ignored) in a repo, a bounded walk outside one, and it is
  computed per open — no index, no daemon, no watcher.
  Known limitation: emoji ZWJ clusters are not width-perfect.
  Pipes keep readline byte-for-byte. v2d (ADR-0040): the body becomes a
  cell renderer — ONE writer owns the scroll region (event handlers only
  mutate cells, so interleaving is impossible by construction); completed
  cells freeze once, unfinished cells render in an active tail at the
  region's bottom and redraw in place; a tool's life is ONE line
  (`→ name summary` → ❯ → running spinner + Ns → `✓ name (summary, 1.2s)`),
  the [result] no longer flows into the stream (`/last` holds it); the
  pipe bytes stay byte-identical. `resume` is the recovery flow (uncertain executions are
  decided rerun/abandon — uncertainty belongs to the crash window alone,
  ADR-0038; a receipted failure is a clean failure whose result carries an
  honest partial-side-effect note, and a retry re-passes the approval
  chain); coding tools are bound
  to the workspace root (absolute paths, `..`, and symlink escapes are
  refused); the approval prompt shows the full shell command and full
  paths. The **kill -9 gate** (`apps/cli/tests/kill9.test.ts`) SIGKILLs a
  real chat mid-execution and resumes it in a fresh process — see
  [durability.md](durability.md).
- **workspace** — publishable monorepo (core, evals, runtime, tools-node,
  provider-anthropic, provider-openai, provider-openai-responses, tui,
  tui-cells, the five official extension packages (mcp, skills and
  subagent built in, ask on an interactive terminal, task opt-in), cli —
  15 npm surfaces), ESM + d.ts, exact-pinned
  internal versions (per-package counters, pinned at each release); CI is
  clean-checkout `npm ci` + the full gate.

`npm run check` = build → typecheck (packages + root scripts + tests) →
tests → size gate (core 2,200 enforced; cli 1,920 / tui 4,000 / tui-cells 1,280 report-only) →
pack gate (dist + README + LICENSE in every tarball) → whitespace gate (no
trailing whitespace, every file ends with a newline) → CJK gate (the tracked
tree stays CJK-free — `README.zh.md` is the only exemption)
→ `git diff --check` on the working tree and the index
→ consumer smoke tiers (runtime, NESTED install, providers, CLI, nested
  CLI with real Anthropic/OpenAI env)
→ demo start-and-exit gate. **2,792 tests green (378 files)** — 2,212 unit,
580 PTY. 39 ADRs (index: `docs/adrs/README.md`).
6 incident fixtures running on the real runtime.
