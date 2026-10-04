# ADR-0058: Tasks — execution that outlives the tool call that started it

- **Status:** **Accepted** — ratified by the owner on 2026-09-28, in
  their own words, with the group rule as written in §8 (a failure never
  wakes on its own). Rev 2: rev 1 went through one external review and
  its findings are applied (a visible one-release alias, `background` vs
  `readyWhen`, durable journal writes, verifiable runner identity, no
  generic dedupe, batched delivery receipts, the TaskManager seam, no
  default child lifetime, one wake per group). Baseline: **0.44.0**
  (released 2026-09-28, `74101d92`; the old task extension retired in
  #167). **Amendment 1** (2026-09-30, at the end) records what the build
  settled: the alias schedule, who owns a promoted command, the wake
  depth for v1, and an unconfirmed stop.
- **Implementation:** 3a the foundation and the shared process module
  (#183); 3b the task-aware shell and `task_stop`; 3c delivery and wake;
  3d background subagents; 3e the steer's detach and the CLI panel; 3f the
  pre-registered evaluation (§11). Released together as 0.46.0.
- **Owner rulings this ADR records (2026-09-28, in chat):**
  1. v1 covers one-shot commands, long-lived services, and background
     subagents.
  2. A foreground command that outlives its wait is promoted to a task,
     never killed; the default wait is 60 s.
  3. Three model-facing shell parameters in v1: `foregroundMs`,
     `background`, `readyWhen`. `killAfterMs` and `delivery` stay
     runtime/host API only.
  4. `timeoutMs` survives as an alias and is removed at 0.46.0 (rev 2:
     visible, not hidden — §3 says why).
  5. No count cap on background processes; background subagents are
     capped at 20 concurrent per session (configurable), refused at the
     cap, depth 1.
  6. Completions of subagents dispatched in the same turn are grouped:
     one delivery when the group is done; failures deliver at once.
  7. The cost is evaluated before release (§11), same tasks, before vs
     after.
- **Layer:** tools-node (the shell tool, the runner), the subagent
  extension (`delegate`), the runtime (the task registry, delivery,
  wake), the TUI (Graphite §9, already specified). **Expected kernel
  cost: 0 lines** — notices ride ADR-0057's admission seam; the detach
  channel travels through the tools' own options.
- **Roadmap:** post-launch item 1 ("Durable Work Runtime").

## The hazard, first

**A task is an effect that keeps happening after the run has moved on.**
The failures that detached work produces elsewhere are well documented
in the public trackers of the surveyed agents: orphaned processes that
outlive the session; the same dev server or subagent started twice after
a compaction made the model forget the first; completion notices lost,
replayed, or delivered twice; exit codes reported wrongly; and wake turns
that spend a full model call while no person is present. Every one of
these is a question kiso already answers for tool calls — who owns the
effect, what is durable, what is known after a crash — asked of work
that no longer sits inside a tool call.

## What the product does today, verified in the tree

| | |
|---|---|
| shell timeout | 30,000 ms (`packages/tools-node/src/index.ts:85`); the description says "Fails loudly on timeout" (`:1265`); the process group is killed |
| shell spawn | `detached: true` (own process group), `stdio: ["ignore", …]` — stdin is closed, so a prompt fails instead of hanging (`:1291–1296`) |
| delegate | spawns child kiso processes with their own durable sessions (`extensions/subagent/src/kiso-subagent.mjs:1–19`); foreground only; `CONCURRENCY = 4` per call, `TIMEOUT_MS` = 10 min per child; depth guarded to 1 |
| background work | none — no tool can leave a process running past its call |
| read_file | refuses any path outside the workspace (`index.ts:202`) |

**What the real logs say** (the owner's `~/.kiso/projects`, 151 session
files, aggregate counts only):

| | |
|---|---|
| shell executions | 9,373; p50 0.1 s, p95 16.3 s, p99 90 s |
| calls that pass `timeoutMs` | 44% (4,123); median value 300,000 ms. These are the long ones: 278 ran over 30 s, 163 over 60 s, 78 over 120 s |
| calls that do not | 5,250; only 21 reached 30 s (about 20 were killed there) |
| timeouts in total | 52 |
| improvised background | 69 commands used `nohup`, `setsid` or a trailing `&` — processes kiso can neither see nor stop |

**What the owner's 60-day usage of a surveyed agent says** (159 sessions,
aggregate counts only): peak concurrent background tasks per session were
mostly 1–5, reached 8 in four sessions and 13 once; at most 8 subagents
were launched in one model response; subagents took 6.8% of the
cost-weighted tokens; turns STARTED by a task notification were 21.7% of
turns, 11.9% of requests and 12.6% of cost-weighted tokens, and 18% of
them were one-request acknowledgements. **The cost of background work
shows up in wakes, not in the subagents themselves.**

## Decision

### 1. What a task is

**A task is an independently addressable execution that outlives the
tool call that started it.** It is a lifecycle, not a kind of work:
`npm test` that finishes in 8 s is a tool call; the same command still
running when its wait ends is a task. It has an id, a state, an output,
and a stop.

Two backends:

- **ProcessTask** — an OS process group run by a runner (§6). Covers
  one-shot jobs (install, build, test) and long-lived services (dev
  servers, watchers). The difference is a lifecycle profile — what
  counts as news — not a second backend.
- **AgentTask** — a background `delegate` child: a child kiso process
  with its own durable session. It is run by the same runner; its output
  reference is the child session.

`ExternalTask` (CI, deploys, render APIs) is reserved, not built.

### 2. How a task comes to exist

1. The model asks: `shell({ …, background: true })` or
   `delegate({ …, background: true })`.
2. The wait ends: a foreground command still running at `foregroundMs`
   is promoted.
3. The person moves the running command to the background (a key in the
   TUI; the Graphite spec reserves the panel).
4. A steer arrives while a detachable command runs (ADR-0057 §5).

Nothing becomes a task because of its name. Detachable in v1 means a
shell execution or a delegate child — nothing else.

### 3. The shell contract — three model-facing parameters

```
command       string    the command
foregroundMs  number    how long to wait for the result (default 60000);
                        after that the command keeps running as a task
background    boolean   start as a task and return at once
readyWhen     string    a literal substring of the output that means
                        "ready" (a server's ready line)
timeoutMs     number    deprecated alias of foregroundMs (0.45 only)
```

How the three combine — each parameter answers one question:

| `background` | what ends the wait | the result |
|---|---|---|
| false | the process exits | the ordinary result, as today |
| false | the output contains `readyWhen` | promoted to a task; the result says "ready" |
| false | `foregroundMs` elapses | promoted to a task |
| true | — | a task at once; a later `readyWhen` match is a `ready` transition (§8) |

`readyWhen` is a literal substring in v1, not a regex: a model-supplied
pattern would put arbitrary matching cost inside the runner, and a ready
line is a fixed string in practice.

- **Promotion, never a kill — DECLARED REVERSAL** of "Fails loudly on
  timeout" and the 30 s kill (`index.ts:85`, `:1265`). The result at
  promotion states the task id, that the process continues, where its
  output is, and that a notice will follow.
- **Why 60 s and why the model's value wins.** The logs show the model
  already separates the two kinds of command: it passes a long wait
  exactly when it expects a long run. A fixed budget that ignored it
  would promote 163–278 commands the model meant to wait for; honoring
  it promotes about the 52 that time out today (0.55% of calls).
- **`readyWhen`**: readiness is a signal, not a state. The task stays
  `running`; the match is recorded and delivered per §8.
- **The alias — visible for one release.** `timeoutMs` keeps working, as
  an alias of `foregroundMs`, for three readers: persisted calls in old
  logs on a cold resume, a model that imitates its own earlier calls in a
  resumed session, and host code. Rev 1 made it hidden (absent from the
  schema, zero tokens); **that cannot work:** tool arguments are
  validated against the schema, with `additionalProperties: false`,
  before any handler runs — on the fresh path (`loop.ts:1159`) and on
  recovery (`run.ts:543`) — so an unlisted field is rejected before the
  shell sees it. Inventing a pre-validation migration seam for one
  temporary field is not worth it. So the schema lists it, marked
  deprecated (an estimated 10–15 tokens per request, for one release):
  introduced in 0.45.0, removed in 0.46.0. The trace counts alias hits.
  After removal an old call gets the ordinary validation error and the
  model retries with the new name.
- **Not model-facing in v1:** `killAfterMs` (a hard lifetime; the logs
  show the long waits were used as waits, not deadlines) and `delivery`
  (§8 defaults cover the model's cases). Both exist on the runtime/host
  API.

Proposed description (to be measured, not guessed, by the request-byte
gate): "Run a shell command through /bin/sh in the workspace root …
A command still running after foregroundMs keeps running as a background
task (never killed); the result gives its id and output path, and you are
notified when it ends."

### 4. Stopping and reading

- **`task_stop({ id })`** stops the task's whole process group. The only
  new tool.
- **No output tool.** Output goes to a file; the model reads it with
  `read_file`, whose allowed roots gain this session's task directory
  (read-only, exact root). A polling output tool is exactly what the
  surveyed agents have retired.

### 5. Background subagents

- `delegate({ …, background: true })` returns at once with the task id
  and the child session id.
- **Cap: 20 concurrent background children per session**, configurable.
  At the cap the spawn is refused with a message that says so and asks
  the model not to retry. Depth stays 1. The per-call `CONCURRENCY = 4`
  for a foreground delegate is unchanged.
- **Lifetime: no default deadline.** The foreground 10 min exists so the
  parent is never hung; a background child hangs nothing, and a
  wall-clock kill would itself manufacture an interrupted child session
  with uncertain effects. Cost is bounded by the concurrency cap, the
  child's own turn and token limits, `task_stop`, and an optional
  host-side `killAfterMs`. (Rev 1 proposed 60 min; dropped in review.)
- **Guidance in the description, from the evidence:** background children
  are for independent, read-heavy breadth work; edits stay in the main
  thread. Fan-out pays on breadth (research-style tasks) and does not on
  coding benchmarks: at matched compute, multi-agent configurations
  scored 2–15% lower on SWE-bench Verified with 3–5× fewer successes per
  thousand tokens (arXiv 2512.08296).

### 6. Truth: the task journal and the runner

**Layout:** `~/.kiso/projects/<slug>/<session>.tasks/<task-id>/`
holding `journal.jsonl` and `output.log`.

**Two truth domains, not two authorities.** The session log is
conversation truth: what the model saw and did. The task journal is
execution truth for work that no longer sits in any run. Neither decides
the other's facts; the session log never records a process lifecycle,
and the journal never records what the model knows.

**The runner** is a small detached process that owns the command, its
output file and its terminal record, and survives kiso's death.

**The invariant — write-ahead, as everywhere else in kiso: a journal
record that gates an external effect is durable (written and fsynced)
before the effect may begin.** `planned` is durable before the runner is
spawned; `command_started` is durable before the command is executed;
`terminal` is durable before the task counts as ended. Without this, a
power loss could erase a record whose effect happened, and every verdict
in the table below would be unsound.

Journal records, in order:

| record | written by | proves |
|---|---|---|
| `planned` | the tool, before spawning the runner (carries the invocation's `executionId`, command, cwd, backend, profile) | the task identity exists — **not** that anything ran |
| `runner_started` | the runner (pid, the OS process start time, optionally a challenge endpoint) | a runner exists that can be re-identified without trusting a reused pid |
| `command_started` | the runner, **before** exec | the command may have begun |
| `ready` | the runner, on the first `readyWhen` match | the signal |
| `stop_requested` | kiso | a stop was asked for |
| `terminal` | the runner (exit code or signal, end time) | the outcome |

**What the journal settles after a crash, and what it does not:**

| journal | runner | verdict |
|---|---|---|
| no `planned` | — | never spawned |
| `planned`, no `command_started` | gone | the command never ran |
| `command_started`, no `terminal` | alive, identity verified | running — re-observed, not restarted |
| `command_started`, no `terminal` | gone | **unknown** — the person decides; never re-run |
| `terminal` | — | the outcome, as recorded |

The runner narrows the unknown window to the command's own run with its
runner lost (a machine crash, a killed runner). It does not remove it.

**Verified identity, not a live pid.** A task may be classified running
after a restart only when the live runner's identity is verified — at
least the pid AND the OS process start time recorded in
`runner_started` both match; a challenge the runner answers is
stronger, and optional. A random nonce stored on disk proves nothing on
its own (rev 1 relied on one): the process holding a reused pid cannot
be asked to know it. When identity cannot be verified, the verdict is
the "gone" row.

**The starting invocation keeps its own receipt:** the tool result
"task t17 established". If kiso dies between the spawn and that receipt,
the execution is uncertain as today, and the journal (keyed by
`executionId`) is the evidence offered to the person. Whether recovery
may settle that case automatically is an open question (§12), not a
ruling of this ADR.

**Lifecycle.** Tasks survive Esc and the end of a run. A clean exit stops
every task's process group (the CLI asks first — Graphite §9). A crash
leaves runners alive; on restart they are re-observed, and terminals
that happened meanwhile are delivered `notify` — never a wake at
startup. Output files are capped at 64 MiB, past which the runner
truncates and writes a marker (proposed).

**No count cap on ProcessTasks** (owner ruling): resources are guarded
by the output cap and the clean-exit stop.

**No generic duplicate suppression** (rev 1 proposed it; rejected in
review). The same command in the same cwd is not the same intent — the
files changed in between, or two parallel runs are deliberate. The
duplicate-after-compaction failure is answered by durable task knowledge
instead: the tool result, the snapshot (§7) and the notices. A host that
needs a singleton (one dev server) can later ask for it explicitly with
a key; nothing is guessed from the command text.

**The TaskManager — who can reach a running task.** The runtime owns the
task registry and its manager; the backends register with it:

```
runtime      TaskManager (registry, delivery, wake, detach)
   ▲ registers a backend
tools-node   ProcessTask backend (the runner)
subagent     AgentTask backend (a runner around a child kiso)
```

`tools-node` gains a type-only import of the runtime's backend interface
(runtime depends on core only, so no cycle); the subagent extension
implements the same interface structurally and keeps zero runtime
dependencies. Every detach — a promotion at `foregroundMs`, a person's
move to the background, a steer's detach (ADR-0057 §5) — goes through
`TaskManager.detach…`, keyed by the invocation's `executionId` (on
`ToolContext` since 0.42.0). The backend resolves the pending tool call
with "continued as task t17". No host ever searches for a child process
itself.

### 7. What reaches the model

Only model-relevant transitions enter the trajectory:

| transition | how |
|---|---|
| started | already in the tool result — nothing more |
| ready | per the delivery profile (§8) |
| terminal | a notice, admitted by ADR-0057 |

**The notice is a batch.** Every delivery — one task or eight — is ONE
`"runtime"` admission (ADR-0057 §4), so ONE durable `user_input` with
`source: "system"` and
`via: { kind: "tasks", items: [{ taskId, transition }, …] }`
(Appendix A). One event, one model-facing message, no hook call, and N
receipts in one fact — never eight consecutive user-role messages.

On the wire `via` never appears, so the content carries its own marking:
one line per task, such as
`<kiso-task id="t17" status="exited" code="0" duration="2m03s" output="…"/>`,
followed by "Runtime notice — not the user." A failed task adds the last
2 KB of its output; a successful one adds none. Runtime notices are
never merged with a person's words (ADR-0057 §5).

**The delivery receipt is a log fact.** "Has t17's terminal reached the
model?" is answered by an admitted `user_input` whose `via.items` names
t17 and that transition — never by a flag in the journal. The journal
may cache the seq; the log decides.

**After compaction.** The summary gets a task snapshot at the moment it
is written — a runtime-generated footer inside the `summarized` event,
never recomputed afterwards. Later transitions arrive as later notices,
so the model reads an older checkpoint followed by newer facts. There is
**no per-request live task list**: the bytes of a request must depend
only on durable facts (ADR-0026; ADR-0051 Amendment 3).

### 8. Delivery: `silent` | `notify` | `wake`

Runtime/host API; the model does not choose in v1.

- `silent` — journal and UI only.
- `notify` — delivered at the next ADR-0057 admission site; if the
  session is idle, at the next run the person starts.
- `wake` — as `notify` in an active run; in an idle session, one
  continuation run whose first input is the notice.

**Defaults by profile:**

| | default |
|---|---|
| one-shot ProcessTask, terminal | `wake` |
| AgentTask, terminal | `wake` |
| service, `ready` | `notify` |
| service, unexpected exit | `notify` |
| service, while running | `silent` |
| started by the person | `notify` |
| stopped by the person or the model | `notify`, never `wake` |

**Invariant: a task the model has seen never ends `silent`.** Without a
live task list, a silent terminal would leave the model believing a
finished task still runs.

**Wake guards:**

1. Each terminal is delivered at most once — derived from the log (§7).
2. **Grouping (owner ruling), at most one wake per group:** background
   subagents dispatched in the same model turn form a group. The group's
   terminals are delivered together when the whole group is done — that
   delivery is the group's only wake. A failure is delivered at once
   when a run is active (it rides the next admission, so the model can
   react), and never causes a separate wake; in an idle session it waits
   for the group's delivery. No group deadline: a straggler holds the
   group, and the person can stop it. Other terminals arriving within
   1 s of each other merge into one delivery (proposed window).
   *Considered in review:* let a failure wake at once and spend the
   group's single wake, so later completions only `notify`. Not taken:
   it trades the ruled "one report when the group is done" for an
   earlier report on failure. At ratification the owner kept the rule as
   written.
3. **Lineage depth 1:** from a person's input, at most one autonomous
   wake. A task started inside a wake run delivers `notify`.
4. **A switch:** a setting (CLI) and an option (host) turn wake off
   entirely; everything then delivers as `notify`.

### 9. The TUI

Graphite §9 stands (the `● N tasks running` count, the panel, stop with
`x`, the `✦ TASK` line). One row changes — **DECLARED REVERSAL** of the
crash row ("a task that was running shows ◌ outcome unknown"): with the
journal, a surviving task is re-observed and shown running; `◌ outcome
unknown` is kept for the one case the journal cannot decide.

### 10. What this ADR does not do

No ExternalTask, no stdin to tasks, no restart of a task, no port
probing (readiness is `readyWhen`), no scheduled or recurring tasks, no
durable inbox, and no kernel change.

### 11. Evaluation before release (owner ruling), pre-registered

**Tier:** a tool-schema change plus an execution change — the
request-byte gates, the paired bench and the crash matrix all block.

**Static rent**, measured by the request-byte gate against 0.44.0:
estimated +150–200 tokens per request in total (the shell description
and parameters, `task_stop`, the `delegate` flag), plus 10–15 for the
deprecated alias in 0.45.0 only. Paid on every request, mostly at the
cache-read price.

**Paired bench (BM-1), candidate vs 0.44.0, interleaved:**

- **Blocking:** T3 and T5 with the frozen BM-1 margins (verify 100%;
  median cost-weighted delta ≤ +6%; no pair > +50%; median wall ≤ +25%).
  These catch the rent and any behavior the new parameters provoke —
  for instance backgrounding commands that would finish in seconds.
- **New fixtures, same task on both arms:**
  - **L1 slow tests** — a suite that takes about 90 s; the task needs
    two runs of it.
  - **L2 service** — a small HTTP server with a bug; start it, reproduce
    with curl, fix, verify.
  - **F1 breadth** — six independent read-only investigations.

  They have no historical band, so their margins cannot come from one:
  a failed verify on either arm blocks; cost and wall are reported
  against expectations written into the ready-kit before the first run
  (L1 near-neutral cost; L2 an improvement; F1 lower wall).
- **Counted on every leg:** promotions, wake turns, one-request wake
  turns, `background: true` on commands that end under 5 s, alias hits.
- **After the owner's dogfood:** the log scan behind this ADR is re-run.

**Red→green tests the implementation must carry:**

1. Promotion never kills: a command outliving `foregroundMs` keeps
   running; the call returns "continued as task"; the terminal arrives
   later with the real exit code.
2. The `background` × `readyWhen` table (§3), row by row.
3. Write-ahead order: with the process killed between each journal record
   and the step it gates, the §6 verdict table holds for every cut — no
   effect without its gating record on disk.
4. Identity: a live process that reuses a recorded pid but not its start
   time is classified "gone", never "running".
5. One batched delivery: several terminals at one site → one
   `user_input`, one `via.items` list, no `onUserMessage` call; each
   terminal delivered exactly once across a kill -9 before and after the
   admission.
6. The group: six children, one fails first — the failure rides the
   next admission in an active run; in an idle session exactly one wake
   happens, when the last child ends.
7. Lineage: a task started inside a wake run never wakes.
8. The alias: `timeoutMs` in a fresh call and in a persisted call on
   cold resume behaves as `foregroundMs`; the trace counts both.
9. A steer during a foreground shell: the shell is detached through the
   TaskManager, never through the host (ADR-0057 §5).
10. Clean exit stops every task's process group; after a kill -9 of
    kiso, a surviving runner is re-observed on restart and its later
    terminal is delivered `notify`, not `wake`.

Paid runs start only on the owner's word about the spend.

### 12. Open for review

1. May recovery settle an uncertain task start automatically from the
   journal (no durable `planned` ⇒ not started; a durable
   `command_started` ⇒ a task exists and is re-observed)? The ledger
   boundary (ADR-0051 §6) has to say yes before the code may.
2. The 64 MiB output cap.

Settled in review and removed from this list: the duplicate guard (no
generic suppression), the straggler (no deadline, one wake per group),
the background-child lifetime (none by default), consecutive notices
(one batched admission), and the old task extension (retired in #167).

---

## Appendix A — ADR-0051 Amendment 8 (ratified text; appended to ADR-0051 when it lands): `user_input.via` gains a tasks kind

1. **Optional-field admission (rule 1), widening an existing optional
   field.** `via` becomes

   ```
   { kind: "skill"; name: string; line: string }
   | { kind: "tasks"; items: readonly { taskId: string;
       transition: "ready" | "exited" | "failed" | "stopped" | "unknown" }[] }
   ```

   `items` is non-empty. (i) Old logs carry no tasks kind and project
   byte-identically; (ii) the validator checks the new kind only when
   present; (iii) no existing byte changes meaning. The R6 fixture case
   is added to the prompt-cache byte-discipline gate.
2. **The meaning of `via` widens — DECLARED.** Amendment 7 defined `via`
   as "how a PERSON's turn was composed". It now means **how an input
   entered the trajectory**: a person's skill invocation, or a runtime
   delivery of task transitions. `source` still says who produced the
   input (`"system"` for a delivery).
3. **Display and receipt provenance, never context.** As Amendment 7:
   the projection copies only `content` and `source`; no byte of `via`
   reaches a request. The notice's wire marking lives in `content`.
4. **Rule 5.** An optional field on an existing event; generation
   detection does not read it.

---

## Amendment 1 — what the build settled (2026-09-30, owner-approved)

1. **The alias schedule.** Ruling 4 and §3 say `timeoutMs` is introduced
   in 0.45.0 and removed at 0.46.0. The release cadence moved tasks to
   0.46.0 (owner, 2026-09-29), and the owner ruled that the alias arrives
   with tasks and leaves the release after: **introduced in 0.46.0,
   removed in 0.47.0.**
2. **Who owns a promoted command — a DECLARED NARROWING of §6** ("the
   runner … survives kiso's death"), approved as the plan's D1 on
   2026-09-30. A foreground command runs as it always has, a child of the
   kiso process; only at promotion does it become a task, and that kiso
   process keeps owning it: the journal's `planned` carries
   `backend: "foreground"`, `runner_started` names kiso's own pid and
   start time, and kiso writes `ready` and the `terminal` with the real
   exit code. The 99.45% of shell calls that never promote pay nothing. A
   stop never signals kiso's pid; the owner stops the command in-process.
   What it gives up: if kiso crashes, a promoted task reads `unknown` —
   honest, never re-run — and the child, whose output pipe is gone,
   usually dies on its next write. A clean exit stops tasks anyway, so
   only a crash differs. `background: true` keeps the full runner
   guarantee, and the shell's description steers servers and long jobs
   to it.
3. **Wake depth for v1 (owner, 2026-09-30):** §8's lineage depth 1 stands.
   The shell's `foregroundMs` description tells the model to allow enough
   time when it needs the result; §11's L1 fixture (a 90 s suite run
   twice) decides before release whether the depth widens to 2–3.
4. **An unconfirmed stop (3a).** A stop that cannot confirm every process
   of the tree dead writes no `terminal`: a `stop_unconfirmed` record
   names the survivors, and §6's table reads `unknown`. The table is
   unchanged; the record is informational.
5. **A host that wires no tasks keeps today's shell.** The task-aware
   schema, `task_stop`, and `read_file`'s task root exist only when the
   host passes the session's tasks to the coding tools; without them the
   shell's schema is byte-for-byte the pre-tasks one, and its wait still
   ends in the 30 s kill. The CLI wires them.

## Amendment 2 — an external review before delivery (2026-09-30, owner-approved)

A review of the task foundation and the 3c plan, before 3c was built. What
it changed:

1. **Identity is three-valued, and only "verified" is the runner (3a.1).**
   #183 read an unverifiable identity (a live pid whose start time cannot
   be read, or was recorded as "") as alive — the process-module plan's
   rule, which contradicted §6's own "when identity cannot be verified,
   the verdict is the gone row". It is reversed: a reused pid is never
   reported running, and a stop never signals it — `stop_requested` in the
   journal (which the runner watches) is what reaches a runner that may be
   ours. An adopted task its own kiso still holds needs no check.
2. **The journal is strict and its entry durable (3a.1).** Only a torn LAST
   line is dropped; an unreadable line with a record after it is
   corruption and fails loudly. The task directory is fsynced after
   `planned` is written, before anything is spawned, so "no planned ⇒
   never spawned" holds across a power loss.
3. **One ordered ingress (3c).** A run holds a person's steers and the
   runtime's notices in ONE queue, admitted in arrival order; only
   neighbours of one kind merge. No rule puts facts before a person's
   words or after them.
4. **A wake run's first input never passes `onUserMessage` (3c).** An
   idle wake starts a NEW run, whose input does not come through an
   admission site; the kernel now asks the protocol (`isRuntimeInput`)
   for a run's first input too. ADR-0051 Amendment 8, item 4.
5. **A summary tells only what the model was told (3c).** The snapshot a
   compaction writes is derived from the log — the tool executions that
   started tasks and the delivered receipts — never from the live
   journal; a transition not yet delivered is not revealed by a summary,
   so a compaction is never a second, unreceipted delivery.
6. **The seams delivery needs (3a.1).** `TaskManager.subscribe` for any
   number of listeners; `TaskInfo` carries the backend, the executionId
   and who stopped it; receipts are a cache rebuilt incrementally from the
   log, never a second truth.
7. **Consecutive user-role messages (3c).** A notice and a steer admitted
   together are two user messages in a row on the wire. The three
   adapters send them as they are (contract rigs); each dialect accepts
   it (the Messages API combines consecutive same-role turns). No
   wire-level merge is needed.

## Amendment 3 — a start the model was told of (2026-10-01)

An external review of 3c, after it merged. Amendment 2 item 5 derived the
summary snapshot from "the tool executions that started tasks", and 3c
read that as the execution's durable START. A start is not what the model
was told: in the crash window the execution started and no result was
ever written, and an execution resolved after a crash is answered with
"not applied". Either way the summary named a task the model never heard
of — the second, unreceipted channel item 5 forbids.

The rule, exactly: a task is in the snapshot only when the log holds a
successful `tool_result` for the execution that started it (the
model-facing result, by `executionId`; its text is never parsed). A task
the model was never told of reaches it only as a delivered notice.

## Amendment 4 — background subagents, as built (3d, 2026-10-02, owner-approved)

The 3d plan after two external reviews; the owner approved which roles
and the turn budget's default. Beyond §5:

1. **Which roles.** A role runs in the background only once its
   unattended contract is defined; in 0.46 only explorer and reviewer
   have one. An implementer's worktree, patch collection and acceptance,
   and a tester's worktree, are held by the parent run; with no parent
   run, who keeps, collects and removes them is not yet defined. A
   background child reads the live workspace, not a snapshot: its
   findings describe the workspace as it observed it.
2. **The launch.** An agent task's `planned` record carries
   `launch: { kind: "exec", file, args }` and the runner starts it with no
   shell — the arguments a foreground child gets, plus its budget and its
   result file; `command` is the label. The child's inputs (task file,
   role policy, manifest) are fsynced before its task is planned.
3. **The cap.** Live agent tasks + slots reserved by calls still starting
   + the batch ≤ the host's `backgroundMax` (default 20), checked and
   reserved in one synchronous step; a batch that does not fit starts
   nothing.
4. **No deadline: a turn budget.** §5's "the child's own turn and token
   limits" did not exist — a child is `kiso chat --task-file`, and the
   interactive door has no turn limit (R3e). A background child is bounded
   by `--max-turns`, the host's `backgroundMaxTurns` (default 32, about
   twice the longest real explorer measured — 17 requests; 3f tunes it).
   The kernel stops the run at a model boundary; then ONE wrap-up request
   (a system input, in a run limited to one request) asks for the answer
   from what was found. The outcome is `incomplete`, never a plain
   failure. `background` with `timeoutMs` is refused; `--max-turns` and
   `--result-file` exist for a delegated child only.
5. **The result.** The child writes its answer — the last assistant text
   of its own session — to `result.md` beside its task, and
   `{ outcome, requests, budget }` to `result.json`, atomically, before it
   exits, so both exist when the runner records the end; a failed child
   exits non-zero. `output.log` stays the child's printed run, for
   diagnosis. (The plan had the delivery write `result.md` from the
   child's session; the child writing its own projection is the same
   source, needs no parse in the parent, and exists before any notice can
   name it.)
6. **The group.** The agent tasks started by the calls of one model turn.
   It closes when that turn has ended and every call in it has its
   result; only a closed group whose members have all ended (ended,
   stopped or unknown) is delivered — ONE notice with every member's line
   and excerpts of the answers within 4 KiB each and 16 KiB together;
   members delivered before are named `reported="earlier"`, and only the
   rest are receipted. Nothing new, no wake. A failure goes into a live
   run at once and never wakes on its own; a restart notifies, never
   wakes.

## Amendment 5 — identity is checked less often (Windows P6, 2026-10-03, owner-approved)

Checking a runner's identity starts a process — `ps` on POSIX, a
PowerShell on win32 — and the TaskManager checked it on every read of every
task, ended ones included, although an ended task's verdict is its
terminal. A session that had run thirty tasks started thirty processes per
listing, and the delivery lists several times per transition.

The rule: a task whose journal has a terminal is never identified; "gone"
is final for a pid and start time; any other verdict is reused for
`identifyEveryMs` (default 5 s). The journal is still read on every poll,
so an end is seen at once. **The worst case, stated:** a runner that dies
WITHOUT a terminal keeps reading as `running` for up to `identifyEveryMs`
after it died (its cached verdict is still "verified"), and only then
reads `unknown` — not within one poll. A stop always checks afresh: it never signals a pid
that is someone else's now.
