# The CLI reference — commands, approvals, modes, and the keys

`@vincemakes/kiso-code` is the flagship coding agent. The README covers
the first five minutes; this page is the whole surface. New here?
[cli-quickstart.md](cli-quickstart.md) is the five-minute walkthrough,
and [configuration.md](configuration.md) is the model and credential
reference.

## Commands

The CLI is a real npm package — install it globally, or run it directly
(new here? `docs/cli-quickstart.md` is the five-minute walkthrough):

```
npm install -g @vincemakes/kiso-code
kiso chat          # after the global install, the command is `kiso`
npx @vincemakes/kiso-code chat   # or run without installing
```

(Inside this repo, `npm run cli` runs the same binary.) The command set:

```
kiso [sessionId]               interactive session (default command)
kiso chat [sessionId]          same as above
kiso resume                    pick a session to continue (the picker)
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions                  list durable sessions, with their state
kiso help                      this help
```

- **Navigation (0.10.0).** `kiso resume` with no id opens a PICKER: one row
  per session, `↑↓` to walk, type to filter, `⏎` to continue, `esc` to
  leave. Each row wears a **durability badge** — the state kiso will
  actually resume into, read from the session's own durable log and
  nothing else:

  | badge | means | what `kiso resume` will do |
  |---|---|---|
  | `✓` | the run ended cleanly | continue from a settled session |
  | `✗` | the run ended some other way (error, aborted, max turns) | continue from where it stopped |
  | `▌` | **no terminal event — interrupted mid-run** | resume the trajectory exactly, from its durable prefix |
  | `?` | the uncertain ledger is not empty | ask you to rule on the interrupted side effect first |
  | `◌` | a permission request nobody answered | put the question back in front of you |

  `kiso sessions` prints the same rows on a terminal (its PIPED output is
  unchanged — that is a machine interface). `/model` with no argument
  opens the same kind of picker over your configured profiles.
- Tools: read file · list directory · search text · write/edit file · shell.
  Writes and shell sit behind the approval policy: the run **pauses**,
  asks, persists the decision, and resumes the same run (ADR-0024).
- **The approval is a selection, not a form (0.12.0).** The pause shows
  the full call — the whole command, the whole diff, never truncated —
  and a list with a highlight bar on it. The bar opens on **Yes, run
  it**, so the shortest path is *look, press enter*: one key, nothing
  typed. `↑↓` move it, **a click on a row takes that row**, a digit
  takes its row outright, `esc` cancels. Typing exists behind exactly
  one option — *No, let me tell it what to do instead* — and what you
  write there goes to the model, which proposes a different call.
  Option 2 grants a **durable** don't-ask-again rule for that tool: it
  writes a human-readable, human-deletable extension file, and deleting
  it is the revocation path. Mouse reporting is on only while a list is
  open and is reset on every exit — including defensively at startup,
  because a process killed with a panel open cannot clean up after
  itself.
- **Safer ways, on demand (0.12.0).** Option 3 asks the model for two or
  three narrower versions of the pending call and shows them as the same
  kind of list, each with a one-line reason. Picking one refuses the
  original *with instructions*, so the model proposes a new call and the
  panel re-presents it marked `(amended)`. It costs **one request, only
  when you press it** — a session that never asks makes no such request,
  and the one it does make is visible in the trace with `purpose:
  "safer-options"` and its own run id, so the cost is auditable rather
  than asserted. It sends no tools and no conversation history: its rent
  is its own short prompt and nothing else. If the answer cannot be read,
  it says so in one line and every original choice stands — it never
  invents alternatives.
- **Irreversible deletes say so.** Four commands carry one yellow line
  naming what goes: `rm -rf` (with the targets listed), `git checkout
  --`, `git reset --hard`, `git clean -f`. Everything else carries
  none — a warning on every dangerous command teaches the eye to skip
  warnings.
- **Scoped reads (0.1.27, the token round):** reads are rangeable —
  `read_file` takes `offset`/`limit` (1-based lines) and returns only the
  head 200 lines of a large file by default, `search_text` caps at 50
  excerpts, `list_dir` at 200 entries. Every SCOPED-READ truncation
  carries an actionable continuation note (`… N more lines (call again
  with offset=…)`, `… +N more matches (narrow the pattern)`) — for
  reads, the model always has a path to the full content,
  deterministically. The shell tool is the honest exception: output
  beyond its 100k-char cap is dropped and named (`… capped — N more
  chars dropped`), and the note's advice (capture to a file, narrow the
  command) is for the NEXT invocation — this run's overflow is gone
  (finding PH-F24; the recoverable-artifact design is the TR-0 round). The system
  prompt guides batching independent calls in one round (the parallel
  execution makes it fast), locating before reading, and never re-reading
  unchanged files.
- Sessions are append-only JSONL under `$KISO_HOME/sessions` — exit, restart,
  `kiso resume <id>`, and the conversation continues with a contiguous seq.
- Keyless faux mode out of the box — a SCRIPTED four-round demo. When
  the script runs out (about two user turns) the session exits non-zero
  with a set-a-key message: that exit is the design, not a crash.
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` switches to a real provider
  (`OPENAI_BASE_URL` is OPTIONAL — set it to retarget any
  OpenAI-compatible endpoint such as DeepSeek; unset, the key alone
  talks to the default OpenAI endpoint); with both keys exported,
  OPENAI wins (checked first). Env-only defaults: `ANTHROPIC_MODEL` falls back to
  `claude-sonnet-5`, `OPENAI_MODEL` to `gpt-4o` — export the `*_MODEL`
  variable to pick a model without touching the config file.
- Interrupted side effects are surfaced on resume (`interrupted execution`)
  and block until a human resolves them — a confirmed success never re-runs.

## Modes — the five built-in approval tiers

`/mode` switches the whole session's approval posture. Five tiers, built
ON the extension chain above — the kernel is untouched: each tier is an
in-process `mode:<name>` extension (chain head), so its automated
verdicts record `decidedBy: "mode:<name>"` — the audit trail names the
tier that decided, exactly like it names the extension.

| tier | semantics |
|---|---|
| `default` | reads allow; write/edit/shell ask the human; extension tools are the extensions' business (the tier stays out of it) |
| `manual` | EVERY tool asks the human |
| `accept-edits` | `default` + write_file/edit_file allow |
| `plan` | read/list/search/read_skill allow; everything else denied with `plan mode: read-only` (the deny reason guides the model to output a plan; the startup prompt adds a plan directive) |
| `bypass` | everything allows — but a user extension's `deny` still wins (the chain's deny>allow>ask composition; a deny wins over every tier, bypass included) |

- `/mode` prints the current tier and the list; `/mode <name>` switches
  immediately (the change applies to the next tool call), leaving a
  notice line in the session body. Startup: `--mode <name>` or
  `KISO_MODE=<name>`; default is `default`.
- The status bar names the current tier in the dim status row — `plan`
  reads `plan (read-only)`, so the constraint is visible at a glance
  rather than encoded in a hue (KC3: the identity is monochrome).
- The tiers are a CLI-side policy layer over the same extension approval
  chain the reference implementations express as permission modes — user
  extensions keep their votes on every call, and their denies always win.

## Visibility — the session tells you what it is doing

Six things the session already knew and never said. None of them costs a
token: no extra request, no extra event, no estimate presented as a
measurement.

- **Cards name their own key.** A collapsed tool cell that is hiding
  something says how much and how to see it — `· 22 lines · ctrl+o
  expands` — and an expanded block ends with `└ ctrl+o collapses`. A
  cell whose output is already whole on screen says nothing, because the
  affordance is a statement about hidden content. The suffix takes the
  width that is left and degrades (`· N lines · ctrl+o`, then `·
  ctrl+o`, then nothing) rather than cutting the path the row exists to
  name.
- **Exploration rolls up.** A consecutive run of read-only calls
  (`read_file` / `list_dir` / `search_text`) collapses to one line —
  `✓ explored 8 files · 14 searches (3.2s) · ctrl+o lists them` — and
  ctrl+o lists them per tool, with the repeated subjects counted.
  Writes, edits, shells and extension tools **never** group: a burst of
  side effects is a list of things that happened, and every row of it
  carries meaning. The grouping is display-only — the durable log is
  byte-identical, and `/last` still reaches the full outputs.
- **A running command shows its tail.** Long shells used to say
  "waiting for output" for as long as they ran. They now show the last
  lines as they arrive, in the same fixed three-row window, with
  `└ live tail · esc stop · alt+⏎ redirect`. It rides an
  observation-only sidecar in the OS temp dir — never durable state,
  removed at settle, and ignored if a `kill -9` ever leaves one behind.
- **`?` opens the keys.** One screen, on an empty composer only (a `?`
  mid-sentence is a question mark), closed by any key. The rows are
  generated from the one table the bindings live in, so the sheet cannot
  drift from the keys.
- **`/context` says where the context went.** The last request's rent
  ledger, as an attribution whose parts sum to the total: system prompt
  (base + extension appends), tool table, skills index, envelope,
  messages, free. It reads the trace sidecar — an observation surface;
  correctness never reads it — and a session that has not called the
  model yet says so rather than drawing an empty bar.
- **The status line shows the meter.** `CH 92% · $0.0042` — the cache
  hit rate over the total the model was given, and the canonical cost.
  A route with no rate in the pricing table records no cost, and no cost
  renders no number. kiso does not invent a price.

```text
  ✓ explored 8 files · 14 searches (3.2s) · ctrl+o lists them
  ▖ shell npm test (12s)
  │ packages/runtime  ✓ 184 tests
  │ packages/tui      ⠸ 88/120
  └ live tail · esc stop · alt+⏎ redirect
▸ default · /mode to switch · deepseek-v4-flash · CH 92% · $0.0042 · ctx left ~74%
```

`ctx left` is the estimated headroom counting every part of the next
request — the system prompt, the tool table, the messages with their
continuation envelopes, and the output reserve when the profile sets
one (A1a, 0.29.0); it is still an estimate (chars / 4), marked `~`. The
auto-compact trigger reads its own number, unchanged this round.

**The keys:** `enter` send · `ctrl+j / shift+⏎` newline · `@` files ·
`esc` stop · `alt+⏎ / ctrl+⏎` redirect · `/` commands · `↑↓` history /
queue pop · `ctrl+o` expand cells · `ctrl+r` transcript · `tab` complete · `?` this
sheet.
Panels: digits select · space toggles · `t` types an answer.

## Images

`ctrl+v` attaches the image on the clipboard. The terminal's own paste
(Cmd+V, Ctrl+Shift+V) only ever carries TEXT, so an image on the clipboard
cannot arrive by the gesture a reader would try first — which is why the key
is on the `?` sheet rather than left to be discovered.

The buffer shows a capsule, `[Image #1]`, and the file stays beside it: a
pasted screenshot never puts a path in the line, so it can never be read as a
slash command. A capsule whose file has gone stays as literal text rather than
failing the turn.

Naming a file works too, and is what dragging one into the window leaves
behind:

```text
▌ look at shot.png and tell me what is wrong
```

The words are kept in place around the picture — the question is half of the
turn. PNG, JPEG, GIF and WebP are accepted, identified by their content and
not by the extension, up to 5 MB each; anything else is left as the text it
already was.

## Theme

kiso asks the terminal for its colour scheme and its background — `CSI ?996n`,
then `OSC 11` — and picks the dark or the light palette from what comes back.
Neither question is waited on: a terminal that answers neither leaves the
ground `unknown`, which is a supported palette rather than a failure. Inside a
multiplexer the answer may be the multiplexer's rather than the terminal's.

To decide it yourself:

```json
{ "theme": "dark" }
```

in `~/.kiso/config.json` — `"dark"` or `"light"`, nothing else. `KISO_THEME`
outranks it for a single run.

It is a USER setting on purpose. A terminal is a property of the person
sitting at it, not of the repository they happen to be in, so a `theme` in a
project-level config is a LOUD error rather than a silent win — the same rule
the rest of the project surface follows.
