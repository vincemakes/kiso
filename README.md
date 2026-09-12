<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png"><img src="assets/hero.png" width="100%" alt="kiso — the durable runtime for AI agents"></picture></p>

<p align="center"><b>v0.35.0</b> · MIT · Node ≥ 22 · <a href="https://kiso.work">kiso.work</a> · <a href="README.zh.md">Chinese edition</a></p>

**kiso** is a durable runtime for AI agents. Every
approval, tool result and event is written to disk as it happens, so an agent
that is interrupted, crashes or is killed mid-task resumes exactly where it
stopped, with the same approvals and the same results. The kernel is 2,200
lines of TypeScript, event-sourced, and every design decision ships with an
ADR that says why, and when to overturn it.

**kiso-code** is the coding agent built on it: the daily tool, and the proof.
`kill -9` it in the middle of an edit, run `kiso resume`, and it continues the
interrupted trajectory in a fresh process. Everything below starts there;
[the SDK](#using-it) is where the runtime becomes yours.

[Quick start](#quick-start) · [Sign in](#sign-in) · [Models and effort](#models-and-effort) · [Sessions](#sessions) · [Modes](#modes) · [Interactive mode](#interactive-mode) · [What is verified](#what-is-verified-and-what-is-not) · [Durable execution](#durable-execution-in-one-screen) · [What is delivered](#what-is-delivered) · [Extending kiso](#extending-kiso) · [The SDK](#using-it) · [Docs](#documentation)

## Quick start

Node >= 22, on macOS or Linux. Windows is unsupported and untested — the
shell tool's process groups, the session-lock liveness probe and the PTY suite
are all POSIX-only.

```bash
npm install -g @vincemakes/kiso-code
kiso                              # the interactive session
```

Or run it without installing: `npx @vincemakes/kiso-code`.

A newer release announces itself under the banner at every start; `kiso update`
installs it (the same `npm install -g`, nothing more).

**The first run needs no key.** kiso opens in a keyless faux mode — a scripted
four-round trajectory, so the shape is visible before anything is spent. When
the script runs out the session exits non-zero with a set-a-key message: that
exit is the design, not a crash.

**Two steps reach a real model, not one.** [Sign in](#sign-in) stores a
credential under a *provider*; a *profile* selects the model that uses it. With
a credential and no profile kiso stays in faux mode — `kiso login` says so and
prints an example. [Models and effort](#models-and-effort) has the profile
shapes.

Then talk to it. The model gets six tools — read file, list directory, search
text, write file, edit file, shell — and writes and shell sit behind the
approval policy: the run **pauses**, asks, persists the decision, and resumes
the same run (ADR-0024). [Extensions](#extending-kiso) add the rest. The
five-minute walkthrough is [docs/cli-quickstart.md](docs/cli-quickstart.md);
the full command surface is [docs/cli.md](docs/cli.md).

## Sign in

`kiso login <provider>` stores a credential in `~/.kiso/auth.json` (mode
0600) — an API key for `anthropic` / `openai` / `deepseek` / `zai`, the
subscription OAuth sign-in for `chatgpt`:

```bash
kiso login chatgpt      # the subscription: a browser round trip, no key
kiso login deepseek     # a vendor key, typed once and stored
kiso auth               # what is stored, masked
kiso logout deepseek    # remove it
```

**A stored credential never leaves the vendor's own origin.** Point a profile
at a gateway or any other custom endpoint and it authenticates with that
profile's own env var alone — the key you signed in with is not forwarded
there. Anyone who signed in and then retargeted a profile needs that key in
the environment.

**A stored credential OWNS its provider.** An unusable stored one is a loud
error, never a silent fall back to the environment variable — what you signed
in with is what runs. Without one the env layer still works: `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY` alone is enough (with both exported, OpenAI wins), and
`OPENAI_BASE_URL` retargets any compatible endpoint.

## Models and effort

`/model` lists your profiles, each annotated available or unavailable, and
switches the session's adapter for the turns that follow; with no argument it
opens a picker. Legal effort levels are shown per profile and refused by name —
at `/model` and again by the run — when the endpoint lacks them.

Profiles live in `~/.kiso/config.json` (ADR-0045). **Credentials are never
inside it** — a profile only NAMES the environment variable holding its key, or
leans on `kiso login`. Precedence: **flags > env > project config > user config
> default**, and a broken config file fails loudly with the file named.

The block below is **annotated JSONC, not a file you can save as-is**: the file
is plain JSON, so strip the `//` comments before writing it. `kiso login` prints
a comment-free minimal profile you can paste directly.

```jsonc
{
  "model": "deepseek",                       // the startup profile
  "models": {
    "deepseek": {
      "kind": "openai-compat",               // "openai-compat" | "anthropic" | "openai-responses"
      "model": "deepseek-flash",                  // the vendor's current id; the legacy alias still works
      "apiKeyEnv": "DEEPSEEK_API_KEY",       // the key's env var — never the key
      "baseUrl": "https://api.deepseek.com"
    },
    "claude": {
      "kind": "anthropic",
      "model": "claude-opus-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "promptCaching": false                   // opt-in; see configuration.md
    },
    // the subscription: no apiKeyEnv — `kiso login chatgpt` owns it
    "chatgpt": { "kind": "openai-responses", "model": "gpt-5.5", "baseUrl": "https://chatgpt.com/backend-api" }
  },
  "mode": "default"                          // manual/default/accept-edits/plan/bypass
}
```

`kiso --model deepseek` beats everything, and `--model anthropic/claude-sonnet-5`
style direct writes work too. The full reference — registry rows with their
dates and sources, prompt caching, thinking modes, auto-compaction, the project
trust gate — is [docs/configuration.md](docs/configuration.md).

## Sessions

Sessions are append-only JSONL under `$KISO_HOME/sessions`. Exit, restart, and
`kiso resume <id>` continues the conversation with a contiguous seq. Since
0.32.2 the store is private by default — the directory `0700`, the log and the
history `0600` — so a transcript is not readable by every account on a shared
machine. Files that already existed are left as their owner set them.

```
kiso [sessionId]               interactive session (default; `kiso chat` is the same)
kiso resume                    pick a session to continue (the picker)
kiso resume <id> [prompt]      continue a session in a new process
kiso sessions                  list durable sessions, with their state
```

`kiso resume` with no id opens a picker: one row per session, arrows to walk,
type to filter, enter to continue. Each row wears a **durability badge** — the
state kiso will resume into, read from the session's own durable log:

| badge | means | what `kiso resume` will do |
|---|---|---|
| `✓` | the run ended cleanly | continue from a settled session |
| `✗` | the run ended some other way (error, aborted, max turns) | continue from where it stopped |
| `▌` | **no terminal event — interrupted mid-run** | resume the trajectory exactly, from its durable prefix |
| `?` | the uncertain ledger is not empty | ask you to rule on the interrupted side effect first |
| `◌` | a permission request nobody answered | put the question back in front of you |

**Context relief is on by default.** Past half the model window, one
`microcompacted` boundary event is appended and the projection derives the
compacted view from it — old read/list/search/shell output becomes a fixed
placeholder, writes and edits never do. `/compact` compresses the older
CONVERSATION into one durable summary. Both are persisted facts, so a crash and
resume land on the byte-identical projection — [docs/context.md](docs/context.md).

## Modes

`/mode` switches the session's approval posture. The five tiers are built ON
the extension chain, kernel untouched: each is an in-process `mode:<name>`
extension whose verdicts record `decidedBy: "mode:<name>"`, so the audit trail
names the tier that decided.

A tier is **one voice in that chain, not the verdict**. The chain composes
`deny > allow > ask`, so a tier that ASKS abstains in favour of anything that
ALLOWS: a saved "don't ask again" rule still allows, and the call runs without
a new question. Switching to `manual` is therefore **not a revocation** of
rules you already granted.

| tier | its contribution |
|---|---|
| `default` | reads allow; write/edit/shell ask the human; extension tools are the extensions' business |
| `manual` | every tool asks — a saved allow still allows |
| `accept-edits` | `default` + write_file/edit_file allow; shell asks — a saved allow still allows |
| `plan` | read/list/search/read_skill allow; everything else **denied** with `plan mode: read-only` — and a deny is what nothing overrides |
| `bypass` | everything allows — but a user extension's `deny` still wins |

**To be asked again, remove the rule.** Grants from "don't ask again" are
written to `~/.kiso/extensions/dont-ask-again.mjs`, which is human-editable and
human-deletable: drop a tool from its set, or delete the file, and the next call
asks. The file is allow-only by design — it can never deny or ask — so the mode
and safe-defaults moats keep their teeth.

Startup: `--mode <name>` or `KISO_MODE=<name>`; the status bar names the tier,
so the constraint is visible rather than encoded in a hue.

## Interactive mode

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

✦ took 22s · in 175 out 54 · cache 97% · ctx left ~98%
▸ bypass · /mode to switch · deepseek-v…s-on-0910 · CH 97% · ctx left ~98% · 186 tok/s
```

Both blocks are rows lifted from a real 100-column screen, not typed: a live
call carries its output while it runs and settles into a record of it. The
session is in `bypass`, which is why the command ran without the pause the
approval bullet below describes. `186 tok/s` is the decode rate of the last
call that could be measured, and the model name is shortened in its middle
because the row ran out of width — the facts never are.

**The keys**, the whole sheet `?` shows: `enter` send · `ctrl+j / shift+⏎`
newline · `@` files · `esc` stop · `alt+⏎ / ctrl+⏎` redirect · `/` commands ·
`↑↓` history / queue pop · `ctrl+o` expand cells · `ctrl+r` transcript · `tab`
complete · `?` this sheet · `alt+←→ / ctrl+←→` word motion · `alt+⌫ / alt+d`
delete word · `ctrl+x` copy the last answer · `ctrl+z / ctrl+y` undo / redo ·
`ctrl+v` attach a clipboard image.
In a panel, in the product's own words: `panels: ↑↓ move · ⏎ confirms · digits
act on their row · t types`. Space selects at the cursor and never commits, so
a stray one cannot answer anything.

- **Images.** `ctrl+v` attaches the image on your clipboard — the terminal's
  own paste only ever carries text, so the obvious gesture cannot reach it.
  A path in your message works too, which is what dragging a file into the
  window leaves behind: `look at shot.png` sends the picture with the words,
  in place. PNG, JPEG, GIF and WebP, identified by content rather than by
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
[docs/cli.md](docs/cli.md).

## What is verified, and what is not

Support is stated by the evidence behind it, not by the presence of code.

| provider | sign-in | status |
|---|---|---|
| DeepSeek and other OpenAI-compatible endpoints | `kiso login deepseek`, or a key in the env | **real vendor legs.** The credential-store path ran against the vendor on 2026-09-08, and the bench's task runs are on `deepseek-v4-flash`. |
| Anthropic | `kiso login anthropic` — API key only | **API key only**: the vendor prohibits third-party subscription sign-in. The current model line is registered with dated, sourced context windows, effort levels, thinking modes and prices (read 2026-09-07). Finding MG1-F1: the signed and redacted thinking-block replay is verified byte-identically through OpenRouter's Anthropic-format endpoint, not against the first-party beta surface. |
| OpenAI Responses, first-party | `kiso login openai` — API key | **offline-verified; real integration PENDING.** Proven against recorded byte rigs; the package README's support table says `unrun` until a real leg lands. |
| ChatGPT subscription | `kiso login chatgpt` — OAuth | **real leg 2026-09-09** on the owner's subscription: the stored sign-in drove a tool call and the next turn, effort passthrough (`xhigh` accepted, `none` refused by name), a mid-stream cancel with the durable void, and a vendor error mapped (`400 invalid_request`) with the session surviving. A subscription run is priced `null` (a subscription is not billed per token) and measured against the presets' 272,000-token window. |
| GLM through OpenRouter | a key in the env (`OPENROUTER_API_KEY`); no `kiso login` provider yet | **real leg 2026-09-09** (`z-ai/glm-5.3-flash`, the compat table's second row): the env key drove streaming with the think shown, a tool call and the next turn, `/model glm high` accepted and `xhigh` refused by name (`native: low/medium/high`), esc mid-stream recorded `aborted by user`, a wrong model id mapped to `invalid_request 400` with the session surviving. Three findings fixed on the way: the adapter dropped OpenRouter's `reasoning` deltas (GLM-F1), read an aborted stream as a provider error (COMPAT-F1 — DeepSeek had the same defect), and filed a transport body cut as non-retryable (COMPAT-F2). The upstream cut one long answer mid-body that evening; the retry recovered. Priced from OpenRouter's models API (2026-09-09). |

Prompt caching is **off by default** on Anthropic profiles: turning it on
changes the request bytes and the bill, and the default flips only after a
paired bench on a live leg proves the saving. For efficiency numbers — same
model, same tasks, three agents, protocol and honest footnotes included — see
[bench/README.md](bench/README.md). Nothing from it is summarized here.

## Durable execution, in one screen

> **Agents crash. Side effects don't rewind. kiso makes execution durable.**

The trajectory is the durable artifact, so a killed process costs nothing but
the process. Three facts are on disk before the crash:

- **The session.** Every run is an append-only JSONL stream of `seq`-numbered
  events, and the messages the model sees are a pure function of that log
  (ADR-0002) — a file you can read, replay and audit.
- **The verdicts.** An approval is a persisted fact recorded with what decided
  it (ADR-0024), you or a policy you installed. Already-decided calls are
  never re-asked, and a policy's `decide` never re-runs for one.
- **The receipts.** Tool calls carry durable receipts keyed by `executionId`
  (ADR-0025). A confirmed success is never re-run; an execution that started
  and never reported is `uncertain` and blocks until a human rules on it — the
  only honest answer to "did the side effect apply?"

The next `kiso resume` then asks only what the crash window made unknowable:

```
$ kiso chat k9                        # edit f1.txt → slow shell → edit f3.txt
$ kill -9 -PGID                       # mid-shell: the whole process group
$ kiso resume k9
interrupted execution: shell (ex-12) — rerun it? (y)es / (n)o y
  rerun
→ edit_file({"path":"f3.txt",...})    # the ORIGINAL trajectory continues
```

That is not a story: it is `apps/cli/tests/kill9.test.ts` — a real PTY, real
processes, a real SIGKILL — asserting that exactly one execution is `uncertain`,
that the interrupted command's marker file does not exist, and that the resume
CONTINUES the trajectory rather than replaying it. `scripts/demo-kill9.sh` runs
the same story against the published binary, twice in a row, fresh home each
time.

**The session format is frozen** (ADR-0051, adjudicated 2026-08-12) — a
contract with executable gates in `npm run check`, not a versioned API that can
drift: prefix-complete recovery, ambiguity never auto-repeats, turn commit,
committed intent before effect, durable start before side effect, stable intent
identity, single durable truth. Each invariant with the gate that pins it:
[docs/durability.md](docs/durability.md).

## What is delivered

Every row is proven by a gate in this repository.

| capability | delivered by | proven in |
|---|---|---|
| survives `kill -9` | event-sourced sessions; resume continues the interrupted run | `apps/cli/tests/kill9.test.ts` |
| durable human approvals | pauses persist across processes; verdicts never lost | `packages/runtime/tests/approvals.test.ts` |
| crash-consistent execution | durable receipts keyed by `executionId`; a confirmed success is never re-run (exactly-once within the framework's own window — the rest is explicit human-resolved uncertainty) | `packages/core/tests/execution-gate.test.ts` |
| extensions | policies / tools / hooks / systemPrompt / dispose | `packages/runtime/tests/extensions.test.ts` |
| built-in extension layer | mcp, skills and subagent load in-process at startup, ask joins them on a terminal; a user copy shadows loudly | `apps/cli/tests/builtin-layer.test.ts` |
| MCP bridge | official extension — built-in since 0.1.45, kernel untouched | `extensions/mcp/tests` |
| subagents | official extension — role-policy children, worktree isolation, the delegation contract | `extensions/subagent/tests` |
| skills | official extension — two-tier progressive loading | `extensions/skills/tests` |
| task | official extension — opt-in since 0.3.0, durable long-horizon working memory | `extensions/task/tests`, `apps/cli/tests/task-e2e.test.ts` |
| stored credentials | a credential owns its provider; no silent env fallback; `auth.json` at mode 0600 | `apps/cli/tests/credentials.test.ts`, `apps/cli/tests/oauth-chatgpt.test.ts` |
| the Responses dialect | both targets against recorded byte rigs — request bytes, streaming, tool turns, reasoning replay, cancel, error mapping, retry authority | `packages/provider-openai-responses/tests/or1-*.test.ts` |
| context economy | microcompact + `/compact` model summary + prompt-cache byte discipline | `packages/core/tests/prompt-cache.test.ts`, `packages/core/tests/summarize.test.ts` |
| project `.kiso` trust | content-digest gate, one ask, sticky refusal | `apps/cli/tests/project-trust.test.ts` |
| markdown under the mono discipline | a zero-dependency renderer streams assistant prose under BLOCK-FREEZE — a closed block commits to scrollback and is never re-rendered; attributes over colour, raw markdown bytes in a pipe | `packages/tui-cells/tests/tui2-md-*.test.ts`, `packages/tui/tests/tui2-md-compositor.test.ts` |

## Extending kiso

An extension is a plain `.mjs` file — no SDK, no build step — whose default
export supplies hooks, tools, an approval policy, a compaction parameter, or a
system-prompt append. Loading is **loud**: a broken file or a duplicate name
fails the process at startup with the file named. The cascade is **built-in →
user → project**; a user extension may shadow a built-in and say so in the
banner, a project extension may never shadow one. The official extensions are
written against that same contract — nothing they do is privileged:

- **MCP** — every MCP tool becomes `mcp__<server>__<tool>`, configured in
  `~/.kiso/mcp.json`. A server that fails to connect is a soft failure, and
  stdio children get provider credentials stripped.
- **Subagents** — one `delegate` tool runs 1-8 tasks in child kiso processes,
  4 at a time. Implementers work in a detached `git worktree` and the diff
  comes back; children are ordinary durable sessions, resumable even if the
  parent is killed. A task may name its allowed write paths (which costs it
  the shell tool) and an acceptance check the parent holds — a model never
  supplies the command.
- **Skills** — a directory with a `SKILL.md` under `~/.kiso/skills`. Its
  frontmatter becomes one resident index line, `read_skill` fetches the body
  on demand, and anything else there is read by path when needed.
- **Ask** — `ask_user` puts 1-4 real questions to you, 2-4 options each. The
  answers ride an ordinary tool result, so an answered question is never asked
  again, including across `kill -9`. A piped session never loads it at all:
  nothing pays prompt rent for a question nobody could answer.
- **Task** — a whole-table todo replace whose list is durable events rather
  than runtime state, so it survives `kill -9` and `/compact`. Opt-in since
  0.3.0: over 13 consecutive real sessions it paid rent every request and was
  never called.

A project's own `.kiso` directory is cloned code that would execute on your
machine, so it rides one content-digest trust gate: kiso lists the artifacts,
asks once, records the verdict, and re-asks only when the files change — with
deliberately no environment variable that skips the ask. The reference — the
contract's types, the `deny > allow > ask` composition, the `safe-defaults`
tutorial extension, each official extension in full — is
[docs/extensions.md](docs/extensions.md).

## Using it

```ts
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import Anthropic from "@anthropic-ai/sdk";

const agent = createAgent({
  model: "claude-sonnet-5",
  tools: [
    defineTool({
      name: "add",
      description: "Add two numbers",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
      execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
    }),
  ],
  store: new SessionStore("./sessions"),          // append-only JSONL
  adapter: createAnthropicAdapter(new Anthropic()),
});

const session = await agent.session({ id: "demo" });
for await (const ev of session.run("What is 2+3?")) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "terminal": console.log("\n", ev.outcome.kind); break;
  }
}
```

This is `examples/hello-agent.ts` (faux adapter there — zero keys) and the
consumer smoke test compiles and runs it in a clean project against the
packed tarballs. `scripts/hero-check.mjs` keeps the two in sync: any drift
in either direction turns the check red.

- Packages build to plain ESM JavaScript + `.d.ts` — installed artifacts run
  on any Node project, no tsx, no source access (`scripts/smoke.mjs` proves it
  in a clean temp project every check).
- Every fixture in `@vincemakes/kiso-evals` is a real production incident, run
  on the real session runtime rather than a test harness — the loop is proven
  against them, not just against happy paths.


## The kernel rule

> The core cannot exceed **2,200 lines**. Any PR that pushes it over gets
> closed, however good the feature is. CI enforces this before it installs a
> single dependency. If you need more, grow a package. That is the point.

Comments do not count — explain freely, implement tersely. The gate is a
snapshot discipline, not a self-adjusting ratchet: it has moved exactly twice,
each by adjudicated amendment, and the standing escape hatch is EXTRACTION
(ADR-0043). The core sits at **2,139 of 2,200** lines today. The product
surfaces run a different regime since Amendment 8 — printed every check for
visibility, never failing it, protected by the architecture gates instead.

The core owns the L1 protocol, the L2 kernel, the tool contract with its JSON
Schema validation, and the eval hooks. It refuses to own loop business logic,
UI, permission policy, billing, skills content and retrieval: those live in
packages, where the cap does not bind them. A core that decides them for you is
a blob, and a blob is the thing you eventually fight —
[docs/kernel-rule.md](docs/kernel-rule.md) has it in full.

## Documentation

| | |
|---|---|
| **Start here** | [cli-quickstart.md](docs/cli-quickstart.md) — five minutes to a working session · [getting-started.md](docs/getting-started.md) — ten minutes to an embedded SDK |
| **Reference** | [cli.md](docs/cli.md) — commands, approvals, modes, the keys · [configuration.md](docs/configuration.md) — models, effort, credentials · [extensions.md](docs/extensions.md) — the contract and the five official extensions |
| **The design** | [durability.md](docs/durability.md) — the runtime, the frozen contract, the `kill -9` proof · [context.md](docs/context.md) — microcompact, `/compact`, the byte discipline · [concepts.md](docs/concepts.md) — the vocabulary · [architecture.md](docs/architecture.md) — the responsibility map · [kernel-rule.md](docs/kernel-rule.md) — the 2,200-line rule and the two layers |
| **The surfaces** | [sdk.md](docs/sdk.md) — the public surface and the Event Stream Contract · [usage.md](docs/usage.md) — the canonical usage schema and the pricing table · [request-trace.md](docs/request-trace.md) — the request trace ledger |
| **The record** | [status.md](docs/status.md) — what is delivered, surface by surface · [docs/adrs/](docs/adrs/README.md) — 39 architecture decision records · [bench/README.md](bench/README.md) — the bench: same model, same tasks, three agents |

`npm run check` is the whole gate: build → typecheck → tests → size → pack →
API surface → hero → whitespace → CJK → versions → PTY manifest → dist
inventory → bench repro → bytes → `git diff --check` → consumer smoke tiers →
demo. **2,988 tests green in 412 files** (2,350 unit, 638 PTY), 6 incident
fixtures on the real runtime, 39 ADRs.

## Why another one

Because every agent framework hands you code and API docs, and none of them
hand you the reasoning. When the model changes next quarter and a design
decision stops paying for itself, the docs cannot tell you which one to pull
out. The ADRs can.

## License

MIT
