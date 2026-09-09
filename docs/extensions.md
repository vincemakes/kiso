# Extending kiso — the extension contract and the official extensions

One mechanism underneath all of it: an extension is a plain `.mjs` file
whose default export supplies hooks, tools, an approval policy, a
compaction parameter, or a system-prompt append. The four official
extensions are written against that same contract — nothing they do is
privileged. The README names them in a paragraph each; this page is the
reference.

## Extensions — approval policies beyond the human

**Four official extensions ship built-in in the CLI**: `mcp`, `skills`,
and `subagent` (0.1.45+) are registered at startup by module import — a
fresh install has all three with zero disk setup — and **`ask`** joins
them on an interactive terminal (KC3.5), where the banner reads
`[4 extensions: built-in: mcp, skills, subagent, ask]`. A piped or
headless session has nobody to answer a question, so it never loads
`ask` at all: its banner still reads
`[3 extensions: built-in: mcp, skills, subagent]` and its tool table
never mentions `ask_user`. Nothing pays prompt rent for a question that
could not be answered.

The fourth official extension, **task** (durable long-horizon working
memory), is **opt-in since 0.3.0**: on 13 consecutive real-provider
sessions it paid its rent on every request and was never called — not
even on the planning guidance's own designed trigger (measured dead
weight, findings E5-F1/E5-F2). Its capability is preserved: install it
per the [Task](#task--durable-long-horizon-working-memory) section below.

On top of the built-ins, the classic layers still load, in cascade order:
**built-in → user → project**. An extension is a plain `.mjs` file — no
SDK, no build step. kiso scans `~/.kiso/extensions/*.mjs` at startup
(`KISO_EXTENSIONS_DIR` overrides) and names what loaded in the startup
banner. Loading is **loud**: a broken file or a duplicate extension name
fails the process at startup with the file name — an extension that cannot
load must never silently change behavior.

- **A user extension may SHADOW a built-in by name** — loudly: the
  built-in leaves the loaded set and the banner drops it
  (`[extensions] user extension "mcp" shadows the built-in — the built-in
  is not loaded`). Your copy, your rules.
- **A project extension may NOT shadow a built-in** — a project extension
  whose name collides with a built-in is refused with a loud error: a
  repo you cloned must never silently replace the CLI's own behavior.

The contract is pure types (`packages/core/src/protocol/extension.ts`):
each file's default export is the extension, or a factory returning it.

```ts
export default {
  name: "safe-defaults",              // unique per installation
  hooks: { /* ... */ },               // optional — compose AFTER the harness's
  tools: [ /* ... */ ],               // optional — merged into the registry
  approvals: [{ decide(call, ctx) { /* ... */ } }], // optional — the policy chain
  compaction: { thresholdTokens: 50_000 }, // optional — supplies the loop's
                                        // microcompact params when the
                                        // session sets none
  systemPrompt: { append: "..." },   // optional — EXTEND the system prompt
};
```

`systemPrompt.append` is appended to the end of the session's own system
prompt (`\n\n`-joined, extensions in load order) — append-only, never
replace: adding an extension can never remove existing guidance (the same
monotonicity as the approval chain and the veto short-circuit). The
composition is deterministic — the same extension list always assembles
the same prompt, byte for byte.

A policy's `decide` returns `{ action: "allow" }`, `{ action: "deny",
reason }`, or `{ action: "ask" }`. The chain runs **before** the human
approval flow and composes across all loaded policies:

- **deny > allow > ask** — any deny wins (the FIRST denial's reason reaches
  the model); else any **allow** wins — a later allow overrides an earlier
  ask (the allow-only don't-ask-again extension must be able to override
  a mode tier's ask; `packages/runtime/src/compose.ts`); a chain in which
  nobody allowed and someone asked goes DIRECTLY to the human approval
  pause (the CLI prompts `approve ...? (y/n)` — never through the static
  policy hook, which must not answer for the human; ruling A, the E1 ask
  semantics fix).
- A policy that throws counts as **ask**; `ask` with no approval channel
  configured (no `resolveApproval`) degrades to an honest denial — judged
  by the channel's presence, not the hook's.
- allow/deny are recorded durably as `permission_decided` with
  `decidedBy: <extension>` — never a human pause. A policy verdict is a
  PERSISTED FACT like any human decision: `kill -9` the agent and the
  already-decided calls are never re-asked — a fresh-process resume applies
  the durable verdicts and the policy's `decide` is never re-run for them.

### safe-defaults — the tutorial

`examples/extensions/safe-defaults.mjs` is the reference extension: allow
the cheap read-only tools outright, deny the most dangerous shell
commands, ask for everything else. Install it with one line:

```
mkdir -p ~/.kiso/extensions && cp examples/extensions/safe-defaults.mjs ~/.kiso/extensions/
kiso chat     # → [4 extensions: built-in: mcp, skills, subagent · safe-defaults]
```

Now every `read_file`/`list_dir`/`search_text` auto-allows (no prompt); a
`shell` command matching `\bgit\s+(stash|reset|checkout\s+--)|rm\s+-rf` is
denied, with the reason fed back to the model; every write and every other
shell command is still asked of the human. The gate is automated in
`apps/cli/tests/extensions-e2e.test.ts` — a real PTY session, a real
`kill -9`: the read is auto-allowed, the write is asked, the destructive
shell is denied, and the resume re-presents only the one undecided request
while the extension's own call log (a marker file written per `decide`
call) proves the policy never re-runs across the kill.

## `/reload` — read the extensions again, without losing the conversation

`/reload` rereads the extension directories, the skills, and the config into
the session you are already in. The conversation is untouched: its truth is
the durable log on disk, so a reload is invisible in the record — nothing the
model said or did changes.

It is a REBUILD, and it has to be. The system prompt and the approval chain
are composed per run, so those would follow a swapped array on their own, but
the tool registry is built once when the agent is constructed and has no
unregister, and hooks are frozen into the session's config. Reloading two of
those four surfaces would be worse than reloading none: a system prompt that
announces a skill whose tool is not in the table is a change that appears to
have happened and did not.

What that buys you:

- an extension you just edited takes effect, source and all;
- a skill you just wrote is in the index AND readable by `read_skill`;
- an extension you deleted stops being callable;
- `config.json` is read again;
- a wedged MCP server is torn down and started again, which makes `/reload`
  the way to recover one without losing your session.

What it does not do: it does not reload kiso itself, and a run in flight
refuses it — let the turn finish, or stop it with esc.

A broken extension does not cost you the session. The new set is loaded FIRST
and swapped in only if it is sound; a file that throws leaves one line saying
so and the previous set still in force. The one case that fails cleanly rather
than silently is a stdio MCP server holding an exclusive resource such as a
port or a lock: two of them are briefly alive during the swap, so the second
will not start, and the reload reports the failure.

The cost, stated plainly: kiso appends a per-load nonce to each extension's
import URL, because Node caches ES modules by URL forever and would otherwise
hand back the code you just edited. Node has no module unloader, so every
reload leaves one unreachable module object per extension file allocated for
the life of the process. The only real resources an extension holds are its
MCP servers, and those are disposed.

## MCP — external tools over the MCP bridge

**Ships built-in in the CLI** — every `kiso chat` has the `mcp__` bridge
loaded already, no install step. `extensions/mcp` is the official
extension's source: self-host or customize by building and copying
`dist/kiso-mcp.mjs` into `~/.kiso/extensions/` (a user copy shadows the
built-in, loudly). The bridge is an ordinary extension — a self-contained
single file (the MCP SDK inlined) — with the four kernel packages
untouched:

```
cd extensions/mcp && npm install && npm run build   # only to self-host/customize
cp dist/kiso-mcp.mjs ~/.kiso/extensions/
```

Configuration: `$KISO_MCP_CONFIG` (default `~/.kiso/mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "SOME_VAR": "1" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    },
    "legacy": { "command": "node", "args": ["server.js"], "disabled": true }
  }
}
```

- Every MCP tool becomes a kiso tool named `mcp__<server>__<tool>`; the
  input schema passes through as-is. `mcp__status` (zero args) reports each
  server's connection state and errors — connection is a load-time fact
  and the CLI has no new UI for it, so the tool itself presents it.
- A server that fails to connect is a SOFT failure: its error lands in
  `mcp__status`, every other server keeps working. A missing config file
  means no servers (never an error); a broken config throws loudly at
  startup (the E1 loader convention).
- stdio children get provider credentials STRIPPED (the same list as the
  shell tool — `ANTHROPIC_/OPENAI_` KEY/BASE_URL/MODEL plus every
  `*_API_KEY`/`*_AUTH_TOKEN`) plus the config's `env` — the explicit env
  wins and may deliberately re-add a variable.
- Calls carry the run's abort signal and a 60s timeout — an interrupted
  call returns an error, never a hang.
- **The task contract (DT-1a, 0.30.0).** Each task may add:
  `scope` — allowed WRITE paths (globs relative to the worktree); a
  scoped task has **no shell tool** (a shell writes anywhere; the
  worktree is the only boundary a shell respects) and every
  `write_file` / `edit_file` target is checked after path
  normalization (symlinks resolved); `acceptance` — `{ "check": "name" }`
  names an entry of the config's `checks` map (`"checks": { "test":
  "npm test" }`, user-authored or trust-gated project config) or
  `{ "evaluator": "/abs/path" }` names a script the PARENT holds outside
  the project; **a model never supplies a command** — anything else is
  refused before a child runs; the parent runs the acceptance in the
  child's worktree after a `completed` child (own process group, the
  child's timeout, output capped, killed on abort); a check's exit code
  proves the command ran on the tree as the child left it, only an
  evaluator proves correctness; `model` — a configured profile name;
  `after` — a completed implementer's child id (tester only; the tester
  runs in that worktree); `timeoutMs`. Every child sees the parent's
  `HEAD` — uncommitted parent changes are not visible, and the section
  says so. Each task writes `<sessions>/subagent/<childId>.result.json`
  (status, changed files from `git diff --numstat` / `--name-status`,
  patch path, verification, the child's `UNRESOLVED` list or "not
  reported", usage as responses-with-usage plus abandoned attempts).
- **Approval: no auto-allow.** `mcp__` tools fall in the ask tier — an
  external tool must pass human review before it runs. Write your own
  policy extension to allow specific ones:

```ts
export default {
  name: "allow-my-mcp",
  approvals: [{
    decide: (call) => call.name === "mcp__filesystem__read_text_file"
      ? { action: "allow" } : { action: "ask" },
  }],
};
```

Tools only: MCP resources/prompts and OAuth are not bridged this round.

## Subagents — delegate to child kiso processes

**Ships built-in in the CLI** — the `delegate` tool is loaded at startup,
no install step. `extensions/subagent` is the official extension's source:
self-host or customize by copying `dist/kiso-subagent.mjs` into
`~/.kiso/extensions/` (a user copy shadows the built-in, loudly). The
extension is a zero-dependency single file — no SDK, no build step beyond
the copy:

```
cd extensions/subagent && npm install && npm run build   # only to self-host/customize
cp dist/kiso-subagent.mjs ~/.kiso/extensions/
```

The extension adds ONE tool, `delegate`, which runs 1-8 subagent tasks in
child kiso processes (the same binary), at most 4 concurrently:

| role | allowed tools | cwd | isolation |
|---|---|---|---|
| explorer | read/list/search | parent's cwd | role policy |
| reviewer | read/list/search | parent's cwd | role policy |
| tester | all six | a `git worktree` — the implementer's kept one when `after` names it, else fresh from HEAD | role policy |
| implementer | all six | a detached `git worktree` | diff comes back |

- **Role policies are generated per child** (a temporary extensions dir):
  only allow/deny — never ask (a headless child cannot answer an approval
  prompt). Explorer/reviewer may only read; implementer/tester may change.
- **implementer isolation**: the child works in a detached `git worktree`
  (parent must be a git repo — otherwise the task fails honestly); after
  the child exits, `git diff` (with its `--stat` header) comes back in the
  result. A worktree with changes is KEPT and its path returned; a clean
  one is deleted.
- **Results come from the child's own session JSONL** — terminal outcome,
  the final assistant text, and the tool-call count — never from stdout
  (stdout rides along only as a diagnostic when the child exits non-zero
  or the JSONL is missing). Children land in the normal sessions directory
  (`sub-<parent>-<n>-<role>`): they are durable, auditable, and resumable
  with `kiso resume` even if the parent is killed — the subagent selling
  point.
- **Depth guard**: `KISO_SUBAGENT_DEPTH ≥ 1` (set on every child) makes
  the factory return no tools — subagents can never nest.
- **Timeouts**: 10 minutes per child by default (`KISO_SUBAGENT_TIMEOUT_MS`
  overrides); a timeout or the parent run's abort SIGKILLs the child's
  whole process group.
- **Provider credentials deliberately pass down** with the parent's
  environment — the difference from the shell tool (#7): shell runs
  arbitrary commands (stripped by default); delegate is a CONTROLLED spawn
  the human just approved.
- **Approval: no auto-allow.** `delegate` falls in the ask tier — a human
  sees every delegation and can deny it.

## Skills — two-tier progressive skill loading

**Ships built-in in the CLI** — skills load at startup, no install step.
`extensions/skills` is the official extension's source: self-host or
customize by copying `dist/kiso-skills.mjs` into `~/.kiso/extensions/`
(a user copy shadows the built-in, loudly):

```
cd extensions/skills && npm install && npm run build   # only to self-host/customize
cp dist/kiso-skills.mjs ~/.kiso/extensions/
```

A skill is a directory with a `SKILL.md` under `$KISO_SKILLS_DIR`
(default `~/.kiso/skills`), e.g. `~/.kiso/skills/review/SKILL.md`:

```markdown
---
name: review
description: a review checklist for pull requests
---

# Review checklist

... the skill body ...
```

- **Tier 1 — resident index.** Every skill's frontmatter (a `---` wrapped
  YAML subset; only `name`/`description` are read — no dependency, no
  parser) becomes one line of the system prompt, sorted by directory name:
  `Available skills (load with read_skill):` followed by one
  `- <name>: <description>` per skill. A `SKILL.md` without frontmatter is
  skipped with a warning line at the index tail — a soft failure, like the
  MCP bridge. No/empty skills dir → an empty extension, never an error.
- **Tier 2 — on demand.** The `read_skill` tool returns the full `SKILL.md`
  (capped at 32KB with a truncation note); an unknown name is an honest,
  actionable error listing the installed skills.
- **Tier 3 — progressive, zero new mechanisms.** Files other than
  `SKILL.md` are NOT auto-loaded: the skill body tells the model to read
  them with `read_file` by relative path when it needs them.
- **Compatible with the common skill format.** The other agents that read
  skills use the same frontmatter shape; the name/description subset
  parses them as-is — drop such a skill directory into `~/.kiso/skills/`
  and it works.
- **Approval:** `read_skill` reads user-installed local docs — the
  safe-defaults example allows it (read_file trust); everything else
  about skills is plain file access governed by the existing policy.

## Ask — the model puts a real choice to you

**Ships built-in in the CLI, on an interactive terminal only.** The
model can stop guessing and ask: `ask_user` carries 1-4 questions in one
call, each with 2-4 options and optional one-line descriptions, single
or multi select.

```text
│ which bundler? ‹ 1/2 ›
│ bundler
─ pick one ─
│  1 ◉ vite — fast dev server
│  2   esbuild — one binary
│  t   type your own answer
│ 1-4 pick · t type · esc decline
└
```

- **The keys.** Digits pick (a single-select question answers and moves
  on; a multi-select one toggles and waits for enter), space selects at
  the cursor without committing, ↑↓ move it, ← walks back a question,
  `t` opens a free-form answer line, and esc declines.
- **A decline is an outcome, not silence.** The result names every
  question that went unanswered, options included — the model learns
  that you chose not to choose, which is different from not being asked.
- **The answers are durable facts.** They ride the ordinary
  `tool_result` of an ordinary tool call, so **an answered question is
  never asked again — including across `kill -9`**. A question that was
  interrupted before you answered it is surfaced on the next `kiso
  resume` for an explicit re-ask (`an unanswered question was
  interrupted — ask it again? — 1 re-ask · 3 drop`), because an
  unanswered question is not a side effect that may have applied.
- **No new durable machinery.** No new event kinds, no per-keystroke
  persistence: a crash re-presents the whole call rather than a
  half-filled form.
- **Approval:** `ask_user` is allowed by the ask extension itself —
  requiring approval to ask a question would put two panels in front of
  one decision, and the panel can already be declined. A user
  extension's deny and plan mode's read-only refusal still win.

## Task — durable long-horizon working memory

**Opt-in since 0.3.0** (it shipped built-in from 0.1.45 to 0.2.2; on 13
consecutive real-provider sessions it paid its rent on every request and
was never called — not even on the planning guidance's own designed
trigger, findings E5-F1/E5-F2 — so it left the default composition).
`extensions/task` is the official extension's source
(`src/kiso-task.mjs` — source IS the product, no build step); install or
customize by copying it into `~/.kiso/extensions/` (a plain user
extension — task is no longer a built-in, nothing to shadow):

```
cp extensions/task/src/kiso-task.mjs ~/.kiso/extensions/
```

A plan-carrying session keeps its durable plan on resume under the new
default — the plan lives in the log, not the extension. The edge: with
the extension absent there is no `task_set` to *update* the plan; the
opt-in restores it.

The `task_set` tool is a whole-table replace (the shape the reference
implementations use for a todo list):
the model sends the complete current list every time, with at most one
item `active` (a second active is refused loudly — the same discipline).
The result echoes the normalized list and carries the `do-not-compact`
tag. The echo renders in the terminal as a checklist cell
(□ pending / ▖ active / ▣ done, the brick family), and the system prompt
gains a restrained planning discipline (3+ steps → plan first with a
verification step; mark active before starting; mark done immediately).

The selling point is the contrast with the usual todo tool, whose list
is **runtime state** — it dies with the process. kiso's list is **durable
events** — the echo is a tool-result message in the session log, so it
survives kill -9 (a resume rebuilds the projection from the log) and
/compact (the do-not-compact tag makes the summary layer's boundary pull
back before its round — the latest list is never lost to a summary).

## Project-level `.kiso` — trusted by content digest, not by directory

A repo's own `.kiso` directory is a capability surface: cloned code that
executes on your machine the moment you run `kiso chat` in it. Three
artifact kinds are recognized there — `extensions/*.mjs`, `mcp.json`, and
`skills/<name>/SKILL.md` — and they share ONE trust gate (ADR-0037):

- **First discovery.** The CLI lists every artifact (file name + digest
  short prefix) and asks once: `trust this project's .kiso? (y/n)`. The
  verdict is recorded in `~/.kiso/trust.jsonl` (append-only,
  `KISO_HOME`-aware).
- **Granted** — the project's extensions load (marked `project:` in the
  banner: `[5 extensions: built-in: mcp, skills, subagent · safe-defaults · project: lint-rules, mcp]`), its
  `mcp.json` merges with your user config (a server name in both is a loud
  startup error), and its skills merge into the skills scan (a skill name
  in both: project wins, one stderr note). A project extension whose name
  collides with a built-in is refused with a loud error — a cloned repo
  must never silently replace the CLI's own behavior.
- **Refused** — nothing loads, and the refusal is sticky: it is never
  re-asked. Re-evaluate by deleting the `trust.jsonl` line for that
  project, or by changing an artifact file.
- **The trust dies with the files.** The digest is a sha256 over the
  sorted artifact paths and contents — `git pull` that changes `.kiso`
  makes you decide again. Same project, same files, same verdict: the
  gate never re-asks.
- **Non-TTY (CI, pipes).** Never asks, never loads — one stderr line
  explains. To pre-grant for CI, run `kiso chat` interactively once in
  the repo, or write the record yourself: a `trust.jsonl` line
  `{"root": "<realpath of <repo>/.kiso>", "digest": "<bundle sha256>", "decision": "granted", "ts": "..."}`.
  There is deliberately NO `KISO_TRUST`-style skip-ask environment
  variable — the gate is not a toggle.
- **Your home is never a project.** When you run kiso in your home
  directory, `<cwd>/.kiso` IS your user-level config directory — discovery
  returns nothing and the gate never runs (discovery#10). A stale
  `trust.jsonl` grant for the home dir is inert and can be left alone.
