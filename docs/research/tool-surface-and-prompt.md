# The tool surface and the prompt: what the comparison measured

This note records kiso's cost comparison against the reference
implementation on the same model, the same route and the same tasks, and
the two kinds of intervention tried to close the gap: changes to the system
prompt and tool descriptions, and removing tools from what the model sees.
Three conclusions:

1. **Correctness is at parity; cost is higher.** In every series both
   harnesses pass the same share of tasks, and kiso costs 28% to 40% more.
   The direction of the gap held across four series; its size was never
   pinned down.
2. **The gap is not in the tool surface.** No deletion of prompt text and
   no removal of tools was confirmed under a frozen criterion. The changes
   that did pay shortened the model's path to evidence, not the prompt.
3. **The gap is in reasoning and output.** It sits in reasoning-heavy
   requests, in request count and in a handful of extreme tasks, not in
   the fixed prefix or in the cost of an ordinary step.

Most of the value here is in the negative results: which intuitions the
measurements rejected, how each criterion was drawn, and whether the data
crossed it.

## 1. The question and the yardstick

### 1.1 What is compared

The comparison has one variable: the harness, meaning everything around the
model (system prompt, tool table, tool implementations, loop). Everything
else is held fixed:

- **Model:** DeepSeek V4.1 Flash.
- **Route:** one gateway and one account. Once a round's kit is frozen its
  route never changes; if the route fails mid-round, the round is void and
  a new kit is frozen.
- **Reasoning effort:** the same on both sides. A label is not evidence:
  before a comparison, the first request of each side is captured and its
  `thinking`, `effort` and max-token fields are compared. One such check
  found that kiso sends no effort field and the reference implementation
  with `--thinking off` sends none either, so both ran at the route's
  default; without the flag the reference implementation sends
  `reasoning_effort: "medium"`. Comparisons are made at the same level,
  never one side's off against the other's high.
- **Tasks:** a Terminal-Bench subset (TB), plus kiso's two long tasks: T5
  (one multi-step change) and T6 (a 24-turn session in four segments).

### 1.2 The unit of cost

Cost is **cost-v2**:

    cost-v2 = fresh input + 0.02 × cache read + 4 × output

with reasoning counted as output. The weights are DeepSeek's price ratios,
so the number has the shape of money without moving with any one day's
prices. Across time, request count is the primary efficiency measure: cost
is comparable only inside pairs run at the same moment, because the same
binary on the same route has moved 15% within an hour.

### 1.3 Success first: VTS

The yardstick is **VTS (Verified Tasks per Token)**: how many verified
tasks one unit of cost-v2 buys.

    VTS = Σ pass rate per task ÷ Σ mean cost-v2 per task

with intervals from a bootstrap over tasks (10,000 resamples). The
definition puts cost after correctness: a change that saves 20% and loses
two tasks can lower VTS. A cost optimisation may not lower the success
rate.

### 1.4 Paired verdicts and null calibration

Versions are compared by a **paired verdict** (BM-1): candidate and
control run interleaved, and each pair gives a relative delta

    dᵢ = (rcᵢ − ctlᵢ) / ctlᵢ

The criterion is: every leg verifies, and median(d) stays under a frozen
bound. Pairing cancels drift common to both arms: when the gateway is slow
today, both arms are slow.

How small a difference a criterion can resolve is measured by a **null
calibration**: both arms run the same binary, and the spread of median(d)
under pure noise is measured.

- On one machine, T5 at 12 pairs gave a p95 of |median| of 21.7%: it could
  not resolve ±20%.
- On a quieter machine, T5 at 8 pairs projected to a p95 of 11.4% at 16
  pairs.
- On T6, the reference implementation's own cost moved by a factor of 1.31
  between hours, so six pairs resolve only differences larger than about
  25%.

These numbers set the weight of every conclusion below.

### 1.5 Frozen criteria

Each round's criteria are written before its first leg and never relaxed,
topped up or re-read afterwards. One combined configuration had a median
of +6.04% against a bound of ≤ +6%; it is recorded as not passing. A
product decision may be recorded beside a result; it does not rewrite the
result.

## 2. Where the gap is, and where it is not

### 2.1 Four series

| Series | Size | Passes (kiso : reference) | Cost (kiso / reference) |
|---|---|---|---|
| TB, 39 tasks × 2 attempts | 39 tasks | 28 : 26 | +36% (output +51%) |
| TB 2.1 | 53 valid pairs | 42 : 43 (p = 1.0) | +40%; VTS ratio 0.70 [0.55, 0.91] |
| 20 random tasks, confirmation | 16 valid | 14 : 16 | 1.39 [0.99, 1.91] |
| two tasks, retest × 3 | 12 runs | 12 : 12 | 1.28 (one task 2.05, the other 0.52) |

Correctness ties in every series. The direction of the cost gap is stable;
its size runs from 1.28 to 1.40 with wide intervals. The line's goal was
therefore set as cost parity, not a cost win, and kiso's public claims rest
on correctness, durability and safety.

### 2.2 What the gap is made of

On the 40 pairs of TB 2.1 that both harnesses passed, kiso cost 1.71 times
the reference implementation:

- **By cost component:** reasoning 53%, cache reads 17%, fresh input 15%,
  plain output 15%.
- **By task:** five extreme tasks hold 60% of the gap (2.21×); the other 35
  pairs are at 1.44×.
- **Outside the extremes:** the gap is more requests (about 1.5×; kiso made
  more requests in 33 of 40 pairs) at **the same cost per request** (0.97;
  0.93 in the 25 quietest pairs).
- **By request type:** reasoning-heavy requests (output ≥ 4k tokens) hold
  43% of the gap. Even if all their excess vanished, VTS would rise 22% and
  kiso would still be at 1.40×.

One extreme task (regex-chess), read trajectory by trajectory: kiso reasons
3–4 times as much and makes 3–5 times as many requests. Later requests
replay earlier reasoning, and that replay is 17–22% of kiso's cost against
5–6% for the reference implementation.

A first-divergence audit of the same data found that the episode where the
two trajectories first part explains only 32% of the gap in the dearer
pairs. Of ten candidate rules, nine fit a single task; the one generic rule
covered 0.05% of cost. No intervention direction was found.

### 2.3 Not in the fixed prefix

A common intuition is that more tools and a longer prompt make the model
think more. The measurements do not support it:

- **First-request size:** kiso's published release 9,564 B; the same
  without two tools 7,955 B; a four-tool lean build 5,633 B; the reference
  implementation 5,950 B.
- **Its price:** the prefix is cached on almost every request and billed at
  the cache weight of 0.02.
- **Per-step cost:** over 40 pairs, an ordinary request (output under 4k)
  averaged 594 output and 355 reasoning tokens in kiso against 579 and 368
  in the reference implementation. No per-decision inflation is visible.

### 2.4 A counter-example: reasoning depends on the task

On a drawing task (a static SVG of a pelican riding a bicycle) the pattern
reverses:

- kiso reasoned 466 tokens per run, the reference implementation 8,768;
- one blind AI judge (n = 6) scored the reference implementation 7.83 and
  kiso 6.67;
- across 12 harness runs, score and reasoning correlate at r = 0.74.

On the animated version at high effort on both sides, quality ties (7.5 to
7.7) and kiso is cheaper (227k to 295k).

"kiso thinks too much" is therefore not a property of the harness but of a
task and prompt combination. That is also why reasoning length is not
capped: on tasks that need reasoning, a cap lowers quality directly.

## 3. How the surface grew to eight tools

### 3.1 What the product shipped

| Stage | Tools the model sees | Why |
|---|---|---|
| First release | read_file, list_dir, search_text (reads, idempotent); write_file, edit_file, shell (side effects, approval-gated) | The smallest slice of a persistent coding agent; shell carries an explicit timeout and output cap |
| + delegate | A subagent, shipped as a built-in extension | Hand a subtask to a separate child process without touching the kernel; subagents are part of the product |
| + task_stop | The current eight | Long shell commands move to the background instead of being killed, with readiness checks (`readyWhen`) and `task_stop` for tasks the session started. A host that wires no task manager keeps the old shell and no `task_stop` |

Some tools appear only under conditions: `ask_user` only with an
interactive panel (no headless benchmark run sees it), `read_skill` only
with skills installed, MCP tools per configured server.

The reference implementation offers four tools by default: read, bash,
edit, write. The "four-tool" and "six-tool" configurations below are
experimental arms, not earlier kiso releases.

### 3.2 A tool's presence is how the model discovers a capability

The tool table tells the model which solution paths exist, not only how
to call them. One round hid `task_stop` until a session's first background
task, to save about 331 tokens of fixed rent:

- Behaviour probes (n = 5): passes 23/25 → 20/25; sleep-and-poll 2 → 7;
  successful service stops 5 → 2; duplicate starts 0 → 2.
- T6, 12 pairs: three pairs over +50% (+63%, +70%, +82%).

The mechanism: without `task_stop`, the model never learns that tasks
exist. It starts services by hand (`setsid … &`), writes polling loops,
cleans up with `pgrep` and `pkill`, and never creates a kiso task.

The constraint drawn from it: before deferring or hiding a tool, separate
its **discovery surface** (resident, short) from its **execution contract**
(which may be disclosed progressively). `delegate` is never tested
"completely hidden until needed".

### 3.3 Rarely called is not unused

In benchmark runs, `list_dir` and `search_text` were 2.7% of calls (shell
78%), and `delegate` was not called once in 220 trials. In 96 real
sessions, `list_dir` was 30.0% of calls and `search_text` 12.5%. Tool use
depends on the population; a benchmark's task shapes do not stand for real
use. That is why the removal tests below judge cost and correctness, not
call frequency.

## 4. Prompt changes: deleting text never paid, shorter paths did

### 4.1 Deletions

| Change | Design | Result | Verdict |
|---|---|---|---|
| Compressed tool descriptions (2 × 2) | reach probes | reach unchanged; request body −2.2% | not where the cost is |
| Routing rows merged and the read/list/search/shell guidelines deleted (tool part of the system prompt 1,065 → 598 chars) | T6, 12 pairs | median **+24.9%**; file inspection through shell 9 → 41; re-reads 13 → 55 | rejected; the "never shell cat/grep/ls" rows became a measured clause |
| Workspace-navigation guidelines removed one by one, then combined (tool table −184 chars) | multi-arm screen, 12-pair confirmation | removing the list/search guideline: shell inspection 0 → 5, rejected; the combination **+6.04%** against ≤ +6% | not passed (by 0.04 points); the family unchanged |
| The capability list removed from the shell description | T6, 12 pairs + probes | median +29.1%; passes 14 → 12 | rejected |
| The verification paragraph removed | TB, 17 tasks × 2 attempts | passes unchanged (28/32 both); cost **+20.5%** | paragraph kept |
| kiso run with the reference implementation's prompt | one task | 82 calls, $0.080, against kiso's 83, $0.083; reference 50, $0.045 | the prompt is not the cause |

The pattern: deleted text was often what kept the model off a dearer path.
Remove "read files with the dedicated tool" and the model reads through
`shell cat` and `grep`, reads more, and re-reads more.

### 4.2 Shorter paths

| Change | Result |
|---|---|
| `read_skill` gains a `file` parameter (its description grows) | reading a skill's file: 8–12 requests and about 80 s (`find /` plus `shell cat`) → 3 requests and about 8 s |
| `edit_file` speaks `oldText` / `newText` (ADR-0061) | T6 steps −12.1% [−14.7, −6.1]; failed edits 4.2% → 0.3%; cost −6.1%; T6 steps at parity with the reference implementation (83 to 83.5) |
| A prefix diet (a lean `delegate` schema, shorter tool descriptions) | headless first request 10,449 → 9,368 B; T6 cost −15.3% [−26.2, −4.2] |
| Tool-contract fixes (a 300 s foreground ceiling, absolute paths inside the workspace, refusal texts) | TB, 17 tasks: passes 15 → 16; in-workspace absolute paths refused 19 → 0; on tasks both arms passed, requests −21.6% and cost −16.4% |

The prefix-diet report says so directly: the saving was "larger than the
prefix explains"; the prefix lost only about 1.1K characters. What was
saved was not rent but the steps the model no longer took.

### 4.3 Measured clauses

Some sentences are a measured combination and stay together. The clearest
case is the "what you can reach" lines together with the shell
description: the tool description alone passes a weather probe 1 time in
5; the combination passes 5 in 5.

Those lines are pinned by a test, and any change that cuts prompt text runs
the pins first. One revision of the prefix diet would have deleted them;
the pins caught it and the text was restored byte for byte. In the same
round, a shortened `background` description in `delegate` led the model to
put `background` inside `tasks[]` in 4 of 5 legs (0 of 9 in the control);
the original text was restored and pinned as well.

### 4.4 The principle

kiso optimises **the minimum total cost of the path to evidence**, not the
minimum prompt bytes. A change to the tool surface is judged by the
requests, calls and wall time the model needs to reach evidence, not by its
static rent alone. Correctness and ownership fixes (a capability out of
reach, a fact owned by the wrong layer) are not decided by an efficiency
A/B: they are proved by unit tests and a small behaviour check, then
shipped.

## 5. Taking tools away: nothing was confirmed

### 5.1 Without delegate

Nine pairs, the full table against the same table without `delegate`. The
median change in reasoning per request was **+10.0%** against a bound of
≤ −30%; four of nine pairs were negative where six were required. The
pre-run noise estimate was ±44%; the observed spread was 68%. Verdict: not
supported. The number of tools is not a reasoning lever.

### 5.2 kiso-lite: screen and confirmation

kiso-lite is kiso with a prompt in the reference implementation's style
(1,211 characters against 2,266) and five tools: `read_file`,
`write_file`, `edit_file`, `shell`, `task_stop`.

- **Screen** (10 tasks, four arms at the same moment): kiso-lite against
  kiso's default had a median cost ratio of 0.68, cheaper on 8 of 10 tasks,
  reasoning −36%. Promising, and still 44% dearer than the reference
  implementation.
- **Confirmation** (20 other random tasks, five arms; a gateway outage
  voided part of it and 10 tasks were re-run): median ratio 0.98, cheaper
  on 9 of 16, aggregate 0.86 [0.72, 1.03]. The frozen rule (median ≤ 0.80,
  cheaper on ≥ 14, upper bound < 1.0) was not met.

The confirmation also split the two factors:

- the prompt alone: 21% dearer (1.21 [0.93, 1.50]);
- the tools alone: 16% cheaper (0.84 [0.72, 1.04]), an interval that
  includes 1.

The screen's 27% did not replicate. What kiso-lite saved came almost
entirely from removing tools, and that effect was not significant.

### 5.3 Without list_dir and search_text

55 tasks × 2 attempts × 2 arms, three frozen criteria:

- R1, no loss of correctness: 87 against 89, p = 0.82, holds;
- R2, aggregate cost ratio: 0.843 [0.716, 0.997], holds with 0.003 to
  spare;
- R3, median per-task ratio: 0.99, cheaper on 29 of 55 (53%), fails.

Verdict: not confirmed. Requests fell 8.8% and reasoning 16.7%, but 82% of
the net saving came from three tasks, and 26 tasks were dearer.

### 5.4 Three configurations in one window

On T6, eight tools, six tools, and a four-tool lean build (synchronous
shell, no `delegate`) were each run against the reference implementation:

- Runs from different hours first suggested that eight tools were at
  parity with the reference implementation (−5.0%) and that the lean build
  was clearly dearer (+40.8%).
- Re-run in a single window (36 legs): eight tools +40.4%, six tools
  +38.5%, lean +31.6%, indistinguishable.

The first reading was withdrawn as an artefact of the time window: the
reference implementation alone moved by 1.31× between hours. The lesson: a
comparison whose arms did not run interleaved at the same moment supports
no conclusion.

### 5.5 The VTS round and a six-tool main agent

- **VTS round** (31 tasks × 2 × 3 arms, 29 tasks in the verdict): four
  tools 6.59, six tools 4.66, the reference implementation 7.12. Four tools
  against the reference: 0.925 [0.729, 1.195]; six tools against the
  reference: 0.655 [0.517, 0.862]. The four- and six-tool arms differ in
  three things at once (two tools, the `delegate` lines, a synchronous
  shell), so the round cannot say which one mattered.
- **Six-tool main agent** (the main agent without `list_dir` and
  `search_text`, children keeping the full set; 8 tasks × 2 × 2, all 32
  sessions valid): passes 16/16 against 15/16, cost −8%, requests −23%, VTS
  ratio 1.022 [0.729, 1.312]. All three gates (no fewer passes, VTS up at
  least 15%, at most a third of always-pass tasks more than 1.25× dearer)
  failed.

The outcome: **the eight tools stay.**

### 5.6 The common shape

The removal tests share a shape:

- the screen looks effective;
- the confirmation shrinks the effect into the noise;
- a few tasks carry most of the saving, while a fair number get dearer;
- the same configuration's two attempts already differ by a median ratio
  of 1.43, and 41% of tasks differ by 1.5× or more between attempts.

Under that noise, effects under about 25% need far more than six pairs, or
far more than a few dozen tasks, to resolve. A sample of that size was not
bought for an effect expected to be small.

## 6. What stays, and what would be tested next

**Stays:**

- The eight tools and the conditional ones; discovery surfaces resident,
  execution contracts disclosed progressively.
- The measured clauses, and the rule that any cut to prompt text runs the
  pins first.
- Paired verdicts, null calibration, frozen criteria, interleaved arms.
- Screen, combine, confirm once; the reference column only at milestones.

**Not done again:**

- Prompt deletions whose goal is fewer bytes.
- Tool removals whose goal is fewer tools.
- Cross-harness comparisons at different reasoning levels.

**Open:**

- Most of the gap is in reasoning-heavy requests and the replay of
  reasoning into later requests, and the audits found no generic rule to
  intervene on.
- A next test would target reasoning length, interleaved with the
  reference implementation at the same level, with the sample needed to
  resolve the expected effect estimated in advance.
- Adjusting effort per task can break the cache, and a fixed lower effort
  lowers both sides, so neither is tested now.

## Sources

- Product timeline: commits e80d9061 (the first six tools), d64c6a64 and
  f9b599ff (`delegate`), dc545619 (`task_stop`, ADR-0058 step 3b);
  ADR-0054 (the default tool table), ADR-0056 (MCP tool deferral, accepted,
  not built), ADR-0033 Amendments 1 and 2 (`read_skill`), ADR-0061
  (`oldText` / `newText`).
- Method: BM-1 and its amendments; the null-calibration kits.
- Measurements: the round kits and reports kept in the maintainers' notes
  (numbers and methods are reproduced here); the public release reports in
  `bench/rd1/`.
