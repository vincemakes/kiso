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
kiso sessions [--all|--current]  list durable sessions, with their state
kiso help                      this help
```

- **Navigation (0.10.0).** `kiso resume` with no id opens a PICKER: one row
  per session, `↑↓` to walk, type to filter, `⏎` to continue, `esc` to
  leave. Each row SAYS the state kiso will actually resume into, in words
  (never a glyph), read from the session's own durable log and nothing
  else:

  | the row's note | means | what `kiso resume` will do |
  |---|---|---|
  | `completed clean` | the run ended cleanly | continue from a settled session |
  | `failed`, or the outcome (`aborted`, `max turns`) | the run ended some other way | continue from where it stopped |
  | `interrupted mid-run — resumes exactly` | **no terminal event** | resume the trajectory exactly, from its durable prefix |
  | `N uncertain — needs your verdict` | the uncertain ledger is not empty | ask you to rule on the interrupted side effect first |
  | `N asks pending` | a permission request nobody answered | put the question back in front of you |

  `kiso sessions` prints the same rows on a terminal (its PIPED output is
  unchanged — that is a machine interface). `/model` with no argument
  opens the same kind of picker over your configured profiles, with the
  cursor on the profile the session is on (`/mode`'s on the tier in
  force), so Enter on a panel opened to look changes nothing. A switch
  that moves the bill — another endpoint, or another credential there —
  adds one line under the switch notice: `paid by @api.deepseek.com ·
  stored key from the next turn — was @…` (0.40.7, finding MP-1).
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
- Sessions are append-only JSONL, one folder per project under
  `$KISO_HOME/projects` — exit, restart,
  `kiso resume <id>`, and the conversation continues with a contiguous seq.
- Keyless faux mode out of the box — a SCRIPTED four-round demo. When
  the script runs out (about two user turns) the session exits non-zero
  with a set-a-key message: that exit is the design, not a crash.
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` switches to a real provider
  (`OPENAI_BASE_URL` is OPTIONAL — set it to retarget any
  OpenAI-compatible endpoint such as DeepSeek; unset, the key alone
  talks to the default OpenAI endpoint). **A retargeted or custom origin
  authenticates with the profile's own env var ONLY: a credential saved by
  `kiso login` never leaves the vendor's own origin** (R1, 0.32.2). If you
  signed in with `kiso login` and then pointed a profile at a gateway, that
  profile now needs its key in the environment — before this it silently
  sent the stored vendor key to the gateway, which is what the change stops.
  With both keys exported,
  OPENAI wins (checked first). Env-only defaults: `ANTHROPIC_MODEL` falls back to
  `claude-sonnet-5`, `OPENAI_MODEL` to `gpt-4o` — export the `*_MODEL`
  variable to pick a model without touching the config file.
- Interrupted side effects are surfaced on resume (`interrupted execution`)
  and block until a human resolves them — a confirmed success never re-runs.

## Modes — the five built-in approval tiers

`/mode` switches the whole session's approval posture. Four offered
tiers (and `manual`, still accepted), built ON the extension chain above — the kernel is untouched: each tier is an
in-process `mode:<name>` extension (chain head), so its automated
verdicts record `decidedBy: "mode:<name>"` — the audit trail names the
tier that decided, exactly like it names the extension.

| tier | semantics |
|---|---|
| `default` | reads allow, and shell commands proven read-only (`ls`, `cat`, `git status`/`log`/`diff`); write/edit/other shell ask the human; extension tools are the extensions' business (the tier stays out of it) |
| `manual` | EVERY tool asks the human (a saved allow still allows). Still accepted in config and by `--mode`; no longer offered by `/mode` or shift+tab |
| `accept-edits` | `default` + write_file/edit_file allow — except a write into `.git/` or `.kiso/` (as written or through a symlink), which asks in every asking tier and is never carried by a saved allow: both hold configuration that runs |
| `plan` | read/list/search/read_skill allow; everything else denied with `plan mode: read-only` (the deny reason guides the model to output a plan; the startup prompt adds a plan directive) |
| `full-access` | everything allows — but a user extension's `deny` still wins (the chain's deny>allow>ask composition; a deny wins over every tier, full-access included), and so does the catastrophe floor. Its old name `bypass` is still accepted |

- **The don't-ask switch** is a second setting, not a tier: whether kiso
  may stop for a person. It composes with every tier and changes no tier's
  decision. On, the chain's final ASK is denied at the ask endpoint with a
  one-line notice (the reason is the tool result, and the run goes on);
  `ask_user` leaves the tool table; an uncertain execution is left
  unresolved, never guessed; an untrusted project `.kiso` is not loaded and
  not asked about. Every allow still allows — reads, read-only shell, a
  saved allow. Set it with `--dont-ask`, `KISO_DONT_ASK=1`, `"dontAsk": true`
  in either config, or `/dont-ask [on|off]`; it is off at every start
  unless one of those says otherwise. The `/mode` panel lists the tiers
  alone and names the switch in its header when it is on. The old tier
  name `dontAsk` still works and means `default` with
  the switch on; a switch that arrived that way leaves when the tier
  changes, as leaving the old tier did.
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
- **Every call gets its own card.** Read-only calls used to collapse into
  one `✓ explored …` line; that rollup was retired at R13 and the string
  it produced no longer exists anywhere in the product. A call now shows
  as a card — the tool, its subject, a bounded preview, and what it cost
  — and `ctrl+o` expands the one under the cursor. A burst of calls is a
  list of things that happened, and every row of it carries meaning. The
  card is display-only: the durable log is byte-identical, and `/last`
  still reaches the full outputs.
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
- **The status line shows the meter.** `CH 97% · 186 tok/s` — the cache
  hit rate over the total the model was given, and the decode rate of the
  last measurable call. The canonical COST is recorded (the trace ledger,
  `/context`) and deliberately not rendered here: live prices move and the
  table is an approximation, so a four-decimal figure on the status bar
  claimed a precision the data never had. A route with no rate in the
  pricing table records no cost either — kiso does not invent a price.

Rows from a real 100-column screen, while a call runs and once it settles:

```text
● shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    1s · esc stops · alt+⏎ redirects
✦ working 19s ↓ 94 tokens · 186 tok/s · esc stop · alt+⏎ redirect · ctx left ~98%
```

```text
  shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    exit=0
    exit 0 · 4 lines · 2.6s

✦ took 22s · fresh 175 out 54 · cache 97% · ctx left ~98%
▸ bypass · /mode to switch · deepseek-v…s-on-0910 · CH 97% · ctx left ~98% · 186 tok/s
```

`fresh` and `out` are the **turn's** figures — every model call the turn
made, summed. `fresh` is the input the turn bought at full price (the
provider's own total minus what it served from cache, E2), `out` is what
it wrote back, and the `cache %` beside them is cache/(fresh + cache):
the share of the turn's prompt the provider had already seen. A turn that
makes nine calls reports all nine. The row used to report the LAST call
alone while reading as the turn's — the owner's nine-call turn, which had
spent 120,358 prompt tokens and 4,608 output tokens, printed `in 412 out
924 · cache 98%`. `in` is renamed `fresh` in the same round so that the
number says what it is. The raw cached total is deliberately never
printed: a sum over calls counts the same prefix once per call, so that
figure lives in the request ledger, not on the row. A call whose usage the
provider did not report makes the whole turn's figure unknown — the row
says nothing rather than a lower bound read as a total.

`ctx left` is the estimated headroom counting every part of the next
request — the system prompt, the tool table, the messages with their
continuation envelopes, and the output reserve when the profile sets
one (A1a, 0.29.0); it is still an estimate (chars / 4), marked `~`. The
auto-compact trigger reads its own number, unchanged this round.

`N tok/s` is the DECODE rate of the last model call whose rate could be
measured: its output tokens over the seconds from the call's first
streamed event to its usage event. The wait before the first token is
excluded, so this is the speed of text arriving rather than the speed of
the whole call. It counts reasoning and thinking tokens too, so on a
model that thinks before it answers the figure can run well ahead of the
visible text.

It shows nothing when there is nothing to show: a provider that reports
no usage, a call under half a second, or a model binding that has not run
yet. A call that cannot be measured leaves the figure the previous one
earned rather than blanking the row, so a turn of quick tool round-trips
does not make the number flicker.

The half-second floor is on TIME rather than on token count, and that is
deliberate. The rate's error comes from timing — when a chunk is observed
and how coarse the clock is, together on the order of 50 ms — divided by
the elapsed window. That is about 10% at half a second and about 50% at a
tenth of one, and counting more tokens does not shrink it. A fast model
answering a short question can decode in around 100 ms; the rate there
would be a large number with an error bar to match, so kiso does not
print it. The consequence is worth stating plainly: on a fast model doing
short turns you will often see no rate at all.

The row has a WIDTH BUDGET. When it does not fit, the model name is
shortened in its middle first (its head and tail are kept, so the binding
is still recognisable), and then the `/mode to switch` hint is dropped.
The facts — the tier, the cache figure, the context estimate and the rate
— are never dropped and never cut. The shortening is on the row only:
`/model`, the session log and the request trace all keep the name whole.

**The keys:** `enter` send (while a run works: steer, ADR-0057) · `ctrl+j / shift+⏎` newline · `@` files ·
`esc` stop · `alt+⏎ / ctrl+⏎` redirect · `/` commands · `↑↓` history /
take back a steer · `ctrl+o` expand cells · `ctrl+r` transcript · `tab` complete · `?` this
sheet.
Panels: digits select · space toggles · `t` types an answer.

## Long-running tasks

Interactive tasks continue until they finish or you stop them with `esc`.
They do not pause for confirmation after a fixed number of model turns:
turn count alone cannot distinguish a healthy long task from a loop.

Repeated identical failing tool calls are still refused with a reason, and
stalled model streams still time out. These protections address specific
failure modes; they do not detect every possible loop. Explicit `maxTurns`
limits supplied by SDK, task, or subagent callers still take effect.

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

## Sessions

Sessions are append-only JSONL, one folder per project under
`$KISO_HOME/projects`, and a session resumes only in its own project. Exit,
restart, and `kiso resume <id>` continues the conversation with a contiguous
seq. Since
0.32.2 the store is private by default — the directory `0700`, the log and the
history `0600` — so a transcript is not readable by every account on a shared
machine. Files that already existed are left as their owner set them.

```
kiso [sessionId]               interactive session (default; `kiso chat` is the same)
kiso resume                    pick a session to continue (the picker)
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions [--all|--current]  list durable sessions, with their state
```

`kiso resume` with no id opens a picker: one row per session, arrows to walk,
type to filter, enter to continue. It opens on the sessions that started in
this directory — only those; tab shows every session, each tagged with where it
started. Sessions from before 0.40.0 recorded no workspace (no event in their
log names one); they are counted in one line and listed under tab. Each row
SAYS the state kiso will resume into, in words:

| the row's note | means | what `kiso resume` will do |
|---|---|---|
| `completed clean` | the run ended cleanly | continue from a settled session |
| `failed`, or the outcome (`aborted`, `max turns`) | the run ended some other way | continue from where it stopped |
| `interrupted mid-run — resumes exactly` | **no terminal event** | resume the trajectory exactly, from its durable prefix |
| `N uncertain — needs your verdict` | the uncertain ledger is not empty | ask you to rule on the interrupted side effect first |
| `N asks pending` | a permission request nobody answered | put the question back in front of you |

**Context relief is on by default, inside a run.** The context is measured by
the provider's own count of the last request. Past half the model window (at
most 400K), kiso compacts at the next round that ends a phase — the checks ran,
the edits finished, the reading finished, or a new turn began; past 80% (at
most 700K) it compacts at the next round regardless. The summary is requested
on the run's own cached prefix and lands as one durable `summarized` event;
the most recent tenth of the window (at most 100K) stays verbatim. If the
provider still refuses the context, kiso compacts once and retries once.
`/compact` does the same on demand. Every boundary is a persisted fact, so a
crash and resume land on the byte-identical projection —
[docs/context.md](context.md).

## How a mode composes, and the catastrophe floor

A tier is **one voice in that chain, not the verdict**. The chain composes
`deny > allow > ask`, so a tier that ASKS abstains in favour of anything that
ALLOWS: a saved "don't ask again" rule still allows, and the call runs without
a new question. Switching to `manual` is therefore **not a revocation** of
rules you already granted.


**To be asked again, remove the rule.** Grants from "don't ask again" are
written to `~/.kiso/extensions/dont-ask-again.mjs`, which is human-editable and
human-deletable: drop a tool from its set, or delete the file, and the next call
asks. The file is allow-only by design — it can never deny or ask — so the mode
and safe-defaults moats keep their teeth. It never carries a destructive command,
a write into `.git/` or `.kiso/`, or a command across the **remote boundary**:
those reach you every time.

**The remote boundary.** Two kinds of command change state that other people
share, so a rule remembered by tool name does not carry them: a destructive
`git push` (`--force` / `-f`, `--force-with-lease`, `--force-if-includes`, a
`+` refspec, `--mirror`, `--delete` / `-d` or a `:branch` refspec, `--prune`;
a `-n` / `--dry-run` is exempt), and a direct `npm` / `pnpm` / `yarn` publish
(not `npm run publish`, not `--dry-run`). Authority you give now still runs
them: full access does, and so does an extension of yours that allows them.
With don't ask on, they are refused with the reason, and the run goes on. Only
direct invocations are read — `npm run release`, a script, a git alias are
not seen; it is a guardrail, not a sandbox.

**The catastrophe floor.** In every mode, full access included, kiso refuses a
destructive command (`rm`, `git clean -f`, `git reset --hard`,
`git checkout -- <paths>` / `.` / `-f`, `git restore`, `git switch -f`,
`find … -delete` with no selecting primary) whose target cannot be recovered:
`/`, a system root or what is inside it (temp directories excepted), your home
directory, the workspace root or anything above it, the workspace's `.git`,
`~/.ssh`, `~/.config`, `~/.kiso`, `~/.gnupg`, `~/.aws` or anything inside them,
a wildcard over any of those, or a target that is only a variable
(`rm -rf $DIR/`). Everything else runs as the mode says — `rm -rf /tmp/probe`
runs in full access. A refusal is recorded as `decidedBy: floor`, and the model is
told why. The floor reads the command line; it is not a sandbox. `"floor": "off"`
in `~/.kiso/config.json` turns it off — a project config cannot — and the status
row then says `floor off`.

Startup: `--mode <name>` or `KISO_MODE=<name>`; the status bar names the tier,
so the constraint is visible rather than encoded in a hue.

## The interactive screen

```text
  read  suite.sh · 7 lines · 0.0s · ctrl+o expands

● shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    1s · esc stops · alt+⏎ redirects
✦ working 19s ↓ 94 tokens · 186 tok/s · esc stop · alt+⏎ redirect · ctx left ~98%
```

and the same turn once it settles:

```text
  shell ./suite.sh; echo "exit=$?"
  └ packages/core      ok  184 tests
    packages/runtime   ok  221 tests
    packages/tui       ok  120 tests
    exit=0
    exit 0 · 4 lines · 2.6s

✦ took 22s · fresh 175 out 54 · cache 97% · ctx left ~98%
▸ bypass · /mode to switch · deepseek-v…s-on-0910 · CH 97% · ctx left ~98% · 186 tok/s
```

Both blocks are rows lifted from a real 100-column screen, not typed: a live
call carries its output while it runs and settles into a record of it. The
session is in full access (`bypass` on the row is its old name — the
capture predates the rename), which is why the command ran without the pause the
approval bullet below describes. `186 tok/s` is the decode rate of the last
call that could be measured, and the model name is shortened in its middle
because the row ran out of width — the facts never are.

**The keys**, the whole sheet `?` shows: `enter` send · `ctrl+j / shift+⏎`
newline · `@` files · `esc` stop · `alt+⏎ / ctrl+⏎` redirect · `/` commands ·
`↑↓` history / take back a steer · `ctrl+o` expand cells · `ctrl+r` transcript · `tab`
complete · `?` this sheet · `alt+←→ / ctrl+←→` word motion · `alt+⌫ / alt+d`
delete word · `ctrl+x` copy the last answer · `ctrl+z / ctrl+y` undo / redo ·
`ctrl+v` attach a clipboard image (macOS).
**Thinking, hidden (0.40.6).** `ctrl+t` hides the model's thinking: each
block becomes one italic line — `thinking…` while it runs, `thinking… ·
/think` once it settles — and none of its text is drawn. Press it again
to show thinking. The choice is remembered in `~/.kiso/preferences.json`
(kiso's own file; `config.json` is never written), so the next session
starts the same way. Shown is the default. The session keeps every
thinking block whole either way: `/think` prints the last one.

In a panel, in the product's own words: `panels: ↑↓ move · ⏎ confirms · digits
act on their row · t types`. Space selects at the cursor and never commits, so
a stray one cannot answer anything.

- **Images.** `ctrl+v` attaches the image on your clipboard — the terminal's
  own paste only ever carries text, so the obvious gesture cannot reach it.
  **That gesture is macOS-only**: elsewhere there is no clipboard reader, so
  kiso says the gesture is macOS-only rather than claiming your clipboard is
  empty. Use a path instead, which is also what dragging a file into the
  window leaves behind and works on both: `look at shot.png` sends the picture with the words, in
  place. PNG, JPEG, GIF and WebP, identified by content rather than by
  extension, up to 5 MB.
- **The palette follows the terminal.** kiso asks it for its colour scheme and
  its background, and picks dark or light from the answer; a terminal that
  answers neither is treated as unknown, which is a supported outcome rather
  than a failure. To decide it yourself, set `theme` to `"dark"` or `"light"`
  in `~/.kiso/config.json`; `KISO_THEME` outranks that for one run. It is a
  USER setting — a terminal belongs to the person at it, not to the project —
  so a `theme` in a project config is a loud error, never a silent win.

- **The approval is a selection, not a form.** The pause shows the full call —
  the whole command, the whole diff, never truncated — with the highlight bar
  already on *Yes, run it*: look, press enter. One option grants a **durable**
  don't-ask-again rule by writing a human-readable, human-deletable extension
  file, and deleting that file is the revocation path. Another asks the model
  for two or three narrower versions of the call, one request, only when pressed.
- **Irreversible deletes say so.** Four commands carry one yellow line naming
  what goes: `rm -rf` with its targets listed, `git checkout --`,
  `git reset --hard`, `git clean -f`. Nothing else does — a warning on every
  dangerous command teaches the eye to skip warnings.
- **The interface is monochrome** — colour is reserved for the three things
  that mean something: green for a diff's additions, red for errors, yellow
  for warnings. `NO_COLOR` or a pipe disables all of it, and a pipe carries
  zero ANSI.

None of this costs a token: the per-call cards, the live shell tail, `/context`'s rent
ledger and the status meter all read what the session already knew — no extra
request, no estimate presented as a measurement. The whole surface — every
command, the scoped-read rules, each visibility mechanism — is
[docs/cli.md](cli.md).
