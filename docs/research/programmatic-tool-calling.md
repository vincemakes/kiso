# Programmatic tool calling: a research line, measured and archived

This note records kiso's research into programmatic tool calling: instead
of calling one tool per step, the model writes a program that calls tools
through `ctx.invoke`, with independent calls run in parallel under
`Promise.all`. The question was whether this could be measurably cheaper,
or measurably more reliable, than the reference implementation on real
tasks.

The answer comes in two halves:

1. **No cost advantage.** Round trips were already few (models batch
   independent calls in one reply); automatic parallelism found nothing to
   do on real tools; the ceiling on incremental reuse is close to zero; and
   the cost is in output, not in round trips. Only one case saves clearly:
   hiding a catalog of a hundred-odd tool declarations behind a program.
2. **A reproducible reliability gap.** When a program is SIGKILLed mid-run,
   kiso records every nested call and stops for a human on resume; in the
   same test the reference implementation recorded none of the nested
   calls' effects.

Real use shows no demand (sessions carry 6 to 12 tools), and shipping it
needs two kernel changes, so the line is sealed: the work stays on four
branches, and the conditions for reopening it are written down.

No line of it is on main.

## 1. The idea

### 1.1 Why consider it

The reference implementation offers a script tool in which the model
writes code that calls tools. The question was not whether the same thing
could be built, but whether something better could:

- **Fewer round trips:** many calls in one program, without a model
  request between them.
- **Safe parallelism:** the model states which work is independent, and
  the runtime decides how to run it, without the model knowing the physical
  schedule.
- **No fixed rent for a tool catalog:** with many MCP or extension tools,
  not every declaration has to ride on every request.
- **Large results out of the context:** filter and summarise inside the
  program and hand the model only the result.
- **Nested calls keep kiso's guarantees:** approval, persistence, receipts
  and crash recovery hold for every call a program makes.

### 1.2 The terms set in advance

Before any code, the research fixed five questions it had to answer:

1. Does the model plan less, without paying more tokens to write programs?
2. Can calls be concurrent and batched safely, without the model knowing
   the physical strategy?
3. Can MCP, extension and host tools be unified without tool-declaration
   rent growing linearly with their number?
4. Do nested calls keep kiso's approval, persistence, receipts and crash
   recovery?
5. Is there a measurable advantage over the reference implementation on
   real tasks?

If the fifth failed, the research would keep basic programmatic calling at
most, would not build a "tool program compiler", and would not claim a new
primitive.

It also fixed red lines:

- no bypass of the tool pipeline (no taking a tool object and executing it
  directly);
- side-effect declarations from MCP tools are untrusted by default;
- no automatic rewriting of JavaScript into a parallel graph;
- a program is not a background task;
- no model calls inside a program;
- kernel changes only by a separate ruling, within a line budget.

## 2. The design

### 2.1 Two seams

There are two ways to let a program call tools:

- **A, a scripted child session.** No kernel change; approval is granted
  by scope, and a child session cannot ask a person.
- **B, `ToolContext.invoke`.** A tool, while executing, can call another
  tool through the kernel, and every child call takes exactly the road a
  model-issued call takes. Estimated at 35 to 55 kernel lines, with six
  lines of headroom at the time.

The research took B: only B gives every nested call kiso's full
guarantees.

### 2.2 The interface

The kernel type is two lines:

```ts
readonly invoke?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
readonly catalog?: () => readonly (ToolSpec & { readonly digest?: string })[];
```

- `invoke` runs another tool through the kernel: input validation, the
  approval chain, a write-ahead `started` record, a receipt. It runs as a
  child of the current execution, with the call id `<parent callId>/<n>`.
  A child writes no `tool_result`: the model still sees only the program's
  result. Only a model-issued call is offered `invoke`.
- `catalog` returns the request's whole tool table, hidden tools included,
  from the same snapshot the kernel dispatches from.

### 2.3 The kernel contract, C1 to C9

So that nesting breaks none of kiso's existing guarantees, the research
froze nine clauses:

| Clause | Content |
|---|---|
| C1 | One level only: a child gets neither `invoke` nor `catalog` |
| C2 | A child takes the model-call road (schema, approval chain, write-ahead `started`, receipt); a child that would need a human decision is refused (`precondition`), never put to a person |
| C3 | Approval decisions one at a time, in one agent-wide order; execution concurrency untouched |
| C4 | The commit gate applies to a child, unless the child's own tool is declared safe before commit |
| C5 | Nesting never escalates isolation: a shared parent starts only shared children |
| C6 | A parent's receipt comes after all its children; no grace period |
| C7 | Any exception between a child's `started` and its receipt is carried to the parent: the child uncertain, the parent unreceipted |
| C8 | Recovery: a child started without a receipt is `uncertain` and blocks resume; children are ruled before their parent, identified by an explicit parent link |
| C9 | Records: `tool_execution_started` gains optional `binding` (a digest of the tool's contract) and `parent`; old logs stay valid |

A model of the nested lanes was checked over 2,954 configurations:

- a naive first-in-first-out queue deadlocks in 2,890;
- full nested exclusion deadlocks in 448;
- the final design: zero deadlocks, zero isolation violations.

The known limits were recorded with it:

- a hung child tool hangs its parent;
- quota spent at decision time is not refunded;
- a child cannot ask a person;
- the candidate never ran a nested program under a real provider;
- `invoke` and `catalog` were offered to every tool, not only the program
  tool.

### 2.4 Kernel lines

kiso's kernel has a hard rule: at most 2,200 lines, and room is made by
extracting code out of the kernel, never by raising the cap
(`docs/kernel-rule.md`).

- The first build of seam B took the kernel from 2,194 to 2,225 lines, 25
  over the cap.
- The fix was a boundary extraction first: `messagesToEvents` (63 lines)
  moved verbatim from the kernel to the runtime, taking the kernel to
  2,128; child invocation then brought it to 2,192, two lines under main,
  with eight lines of headroom.
- The price: kiso-core's public surface loses `LoopConfig.messages`, and
  callers move from `loop({ messages: X })` to `loop({ log: seedLog(X) })`.

### 2.5 The program runtime

The program itself is an extension with one tool, `program`, whose input
is `{ code }`, the body of an async function:

- **Globals:** `tools.<name>(args)`, `searchTools(query)`,
  `describeTool(name)`, `ALL_TOOLS`, `text(v)`, `console.log`, `return v`.
- **Rules stated in the description:** use `Promise.all` for independent
  calls; no network, files, environment or timers inside the script; tool
  calls are real, and a later failure of the script does not undo them.
- **Sandbox:** QuickJS compiled to WebAssembly; defaults of 60 s, 64 MiB of
  memory, 200 calls and 20,000 characters of output.
- **Concurrency:** one agent-wide limiter, eight children at once by
  default, optionally bounded per MCP server.

A real program (a hand-written reference script from the research branch,
used in the length comparison):

```js
const j = (r) => JSON.parse(r.content[0].text);
const names = ["Brass Heron", "Quiet Engine", "Glass Orchard", "Salt Lantern", "Hollow Drum", "Night Ferry"];
const p = j(await tools.mcp__studio__create_project({ name: "Atlas", budget_credits: 200 }));
const subs = await Promise.all(names.map((n) => tools.mcp__studio__add_subject({ project_id: p.project_id, name: n }).then(j)));
const assets = await Promise.all(subs.map((s) => tools.mcp__studio__generate_asset({ subject_id: s.subject_id, style: "noir" }).then(j)));
const revised = new Set();
for (let round = 0; round < 5; round++) {
  const rs = await Promise.all(assets.map((a) => tools.mcp__studio__analyze_asset({ asset_id: a.asset_id }).then(j)));
  const bad = rs.filter((r) => !r.passes);
  if (!bad.length) break;
  bad.forEach((b) => revised.add(b.asset_id));
  await Promise.all(bad.map((b) => tools.mcp__studio__revise_asset({ asset_id: b.asset_id, instruction: "fix " + b.issues.join(" ") })));
}
const list = j(await tools.mcp__studio__list_assets({ project_id: p.project_id, compact: true }));
return { assets: list.assets, revised: [...revised] };
```

On the host side, the program tool takes `ctx.invoke` and wraps it in a
contract check and the limiter:

```ts
execute: async (input: { code: string }, ctx: ToolContext): Promise<ToolResult> => {
	if (ctx.invoke === undefined || ctx.catalog === undefined) {
		return { content: "program: child tool calls are not available in this execution (the runtime offers no invoke)", isError: true, errorKind: "precondition" };
	}
	const guarded = guardedInvoke(ctx, opts.binding, limiter);
	const r = await runProgram(input.code, { invoke: guarded, catalog: ctx.catalog, signal: ctx.signal }, limits);
```

### 2.6 Layers tried above it, and dropped

Above `ctx.invoke`, the research tried several more compiler-like layers
and dropped them all:

- **A logical program and an IR:** the model states logical work and its
  dependencies; the runtime links, plans and optimises.
  - Hand-written logical programs were no shorter than JavaScript: 1.01 to
    1.06 times as JSON, 0.88 times through a builder.
  - Real models write stepwise: 8 to 11 small scripts per leg.
  - IR output was 25% to 79% larger than JS in three of four cells, and 21
    of 150 plan calls (14%) failed to build.
- **ResultRef and result inspection:** a child's large result is passed as
  a reference, and the model inspects it with `inspect_result` when needed.
- **An effect ABI:** opaque references plus a ledger describing side
  effects.

The disposition: IR, plan, footprint, scope, effect ABI, ResultRef, a
semantic cache and a compiler are not pursued. The shape that remains is:
a QuickJS sandbox, `tools.<name>()`, `Promise.all`, `searchTools()`,
`describeTool()`, deferred or hidden MCP tools, bounded execution, and
`ctx.invoke()` carrying kiso's own approval, receipts and recovery of
uncertain executions.

## 3. Reliability: the one gap that holds

Test E-P3-1: a program makes three side-effecting nested calls in order;
while the third reply is pending the process is SIGKILLed, then the
session is resumed.

| | The reference implementation | kiso (seam B) |
|---|---|---|
| The three effects | all three happened | the first two succeeded; the third started, with no receipt |
| The session record | no record of any nested call | a `started` record for each child; receipts for the first two |
| Resume | proceeds; the model is told only "No result provided" | blocked, on exactly the two undecided executions; after a person rules, the model is told which children took effect |

The gap is reproducible and sits on kiso's central claims: a side effect is
never repeated, and an uncertain outcome goes to a person. A durable nested
ledger has been published elsewhere before, so the claim made here is only
this: a measured, reproducible gap in the reference implementation's
shipped nested execution, not a first.

## 4. Cost: the measurements rejected the premises one by one

### 4.1 Round trips

An MCP pilot (three catalog sizes × four arms × two repetitions, 24 legs):
requests per leg were 8 to 12.5 in every arm, even on a task with 61 tool
calls. Models already issue independent calls together in one reply. The
work programmatic calling meant to take over, the model was doing itself.

### 4.2 Automatic parallelism

In all 36 IR legs the kernel's actual overlap was 1. No real MCP tool
declared itself safe to run shared (`concurrency: shared`), so the
scheduler's gain was never realised. With the host marking read tools as
shared, a program had 12 calls in flight and took 0.57 s against 2.39 s in
sequence, but that gain comes from the shared declaration, not from a
compiler.

### 4.3 The rent of a tool catalog

This is the one clear effect, and it appears only with many tools:

| Tools | Result |
|---|---|
| 13 | programmatic calling dearer than direct declaration: +38% in weighted input (cache weighted at 10%) |
| 27 | about even: −6% on the same measure; deferral does not pay (direct 26.0K < deferred 31.9K) |
| 120 | programmatic calling clearly cheaper: about −40% in dollars (direct $0.0082, kiso's program $0.0049, the reference implementation's script tool $0.0047, deferral $0.0101) |

The unit matters here. A "−66%" that circulated earlier, and the 13- and
27-tool figures, are weighted input with cache reads at 10% of the input
price. DeepSeek's actual cache price is about 2%. Only the 120-tool row was
computed in dollars at real prices, and it is about −40%, not −66%. Each
cell had two legs, and the same arm moved 43% in dollars between rounds:
these numbers show a direction, not a size.

### 4.4 One-shot programs

When the model writes a whole task as one program and runs it once:

- expert-written one-shot scripts passed 9 of 9, cut requests from 10–12
  to 2, and cost the same dollars as the reference implementation calling
  step by step;
- written by the inexpensive model itself: 8 of 9 passed, but each took
  28.6K to 54.7K completion tokens (75% to 85% of them reasoning), about
  $0.008 to $0.015 per task against $0.0015 to $0.003 step by step, five to
  seven times dearer.

Requests fell; dollars did not. The round trips saved were paid back
several times over in the reasoning needed to write the whole program at
once.

### 4.5 Large results out of the context

The validation round for result inspection (252 legs, $0.90): every arm
passed 56 of 56, but `inspect_result` was **called zero times** in 56
follow-up legs. Every arm simply re-read the repository (`search_text` 171
to 192 calls, `read_file` 212 to 232). When the world is cheap to re-read,
the model does not consult a cached conclusion. The round did not test work
that cannot be repeated cheaply (long test or build logs); that shape may
differ.

The principle drawn from it: do not cache the agent's understanding; when
the world is cheap to read, read it again.

### 4.6 Check after edit

Folding "change the file" and "run a check" into one call (`then`) is the
most direct use of `ctx.invoke`:

- median requests −27.8%, wall time −15%;
- median cost only −1.6% (about −2% in the legs that adopted it);
- the same binary against itself moved −18% to +37% in cost in a null, so
  2% cannot be resolved.

Its second stage needs the kernel's `ctx.invoke` and has no case.

### 4.7 The ceiling on incremental reuse

How much could a retained program, or incremental reuse of tool results,
save? The ceiling was computed offline, with the kit frozen first:

- 52 sessions (12 T6 legs and 40 real sessions), 18,214 requests, 15,630
  calls;
- the median ceiling **0.0%**, the best session 1.3%, 0.5% cost-weighted,
  against a bar of 20% that no session reached;
- exact repeats of a read-only call: 0.5% in T6, 0.4% in real sessions.
  **99.5% of read-only calls are new.**

Closed. Reuse of the model's own judgments was not covered (the logs carry
no marker to measure it) and is parked.

### 4.8 Where the money goes

Across 221 real sessions (1,838 requests since the start of October):
fresh input 21%, cache reads 22%, **output 57%**, cache hit rate 98.1%.
Avoidable excess fresh input is 4.0% of total cost.

An earlier figure of "66% fresh input" came from an incident window in late
September and was withdrawn.

The cost is in output. Work on the cache or on round trips moves cost by
single-digit percentages, and those are exactly what programmatic calling
changes.

### 4.9 The reference implementation's own script tool

- On coding tasks with only a shell and no MCP, its script tool was never
  used (0 of 349 calls). That test was outside the tool's intended scenario
  (a front door for MCP), so the conclusion holds only for the scenario
  tested.
- On 10 TB tasks, forcing it to use only the script tool gave a median
  per-task cost ratio of 1.66, cheaper on 1 of 10, requests 206 against
  167, reasoning 131k against 64k. Forcing everything into scripts did not
  reduce model calls.

## 5. The archive

### 5.1 Why it is sealed

- **Cost:** no cost or quality win against the reference implementation. A
  one-shot program saves requests, not dollars; written by the inexpensive
  model it is five to seven times dearer.
- **Demand:** by a count made when the line was sealed, all 221 of the
  maintainer's real sessions ran with 6 to 12 tools (the largest tool table
  about 2,200 tokens), product agents included. Deferring a tool catalog
  pays only at a hundred-odd tools, and no such use exists yet.
- **Price:** shipping it needs two kernel changes (the boundary extraction
  and child invocation), and no feature is waiting on either.

Both kernel ports had been cancelled before the seal, on the question
first to be answered: what, for a user, does a program measured this way
beat?

### 5.2 The four branches

| Branch | Content | State |
|---|---|---|
| `archive/program-research` | IR, plan, scope, footprint, contract binding, effect ABI and other experiments; 52 commits, 146 files | archived |
| `archive/feat/result-inspect` | ResultRef and `inspect_result`; 3 commits | closed (0 calls in 56 follow-ups) |
| `cand/a-boundary-extraction` | `messagesToEvents` moved out of the kernel; kernel 2,194 → 2,128 | held; a kernel change needs the maintainer's ruling |
| `cand/child-invocation` | `ToolContext.invoke` and C1–C9; kernel 2,192 of 2,200; depends on the branch above | held |

Nothing was merged and nothing was deleted.

### 5.3 What would reopen it

Any one of:

1. a user or product runs 30 or more MCP tools in real sessions;
2. another feature needs `ctx.invoke` and the numbers justify it (for
   example the second stage of `then`);
3. a measured win for programmatic calling in cost per verified task, at
   the real cache price.

A reopened branch takes only the shape above, re-aligned to the main of the
day, and re-runs the crash and correctness gates. Each kernel change goes
to the maintainer as its own decision.

## 6. What the line taught

- **Compute the ceiling before building.** Incremental reuse was closed
  once its offline ceiling came out at 0.5%, before a line of product code.
- **Measure inside the intended scenario.** A feature judged useless
  outside its design scenario is judged only for that scenario.
- **Get the unit of cost right.** Pricing cache reads at 10% instead of 2%
  turns "−40%" into "−66%", and can turn a small catalog from cheaper into
  dearer.
- **Fewer requests is not less money.** Where output dominates cost, round
  trips are not the lever.
- **Reliability is a measurable claim.** The firmest conclusion of this
  line came from one SIGKILL test, not from any cost figure.

## Sources

- Branches: `archive/program-research` 4ced5aca,
  `archive/feat/result-inspect` 3175cf45, `cand/a-boundary-extraction`
  8335fdf7, `cand/child-invocation` 554309fb.
- The kernel rule: `docs/kernel-rule.md`. MCP tool deferral: ADR-0056
  (accepted, not built).
- Code: `bench/program/ir/mid.js` and `extensions/program/src/index.ts` on
  `archive/program-research`; `packages/core/src/tools/tool.ts` on
  `cand/child-invocation`.
- Measurements: the round kits and reports kept in the maintainers' notes;
  numbers and methods are reproduced here.
