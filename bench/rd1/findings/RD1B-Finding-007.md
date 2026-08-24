# RD1B-Finding-007 — the arms did not run in comparable environments

- **id:** RD1B-F7
- **class:** benchmark contamination / unequal isolation
- **severity:** P1 for the benchmark — it invalidates the batch's
  headline attribution and confounds the rest of the comparison
- **scope:** the harness (both drivers), RD-1B and every earlier
  kiso-vs-pi run using the same driver pattern
- **status:** OPEN. **No code changed and nothing was re-run.** The
  measurements stand; the claim built on them does not.

## What is unequal

    kiso driver   KISO_HOME = a fresh empty directory per cell
                  → no user skills, no user extensions, no user config
                  and readProjectInstructions() reads the CWD ONLY

    pi driver     HOME = the operator's real home; only the SESSION dir
                  is isolated
                  → ~/.pi/agent loads with 13 real installed skills,
                  and loadProjectContextFiles() walks ANCESTORS

The pi fixtures live at `bench/rd1/out/rd1b-pi/<cell>/work`, inside the
kiso repository, so pi's ancestor walk reaches the repo's own
`CLAUDE.md` — kiso's contributor rules, in the competitor's context
window, on every request. The 13 skills are Cloudflare, Wrangler,
Durable Objects, Sandbox and similar: nothing to do with running
`./deploy.sh`.

## The measurement

First request of each of the 16 paired cells, before any history exists:

| | kiso | pi |
|---|---:|---:|
| mean first-request context | **2,371** | **4,991** |
| range across 16 cells | 2,362–2,385 | 4,982–5,005 |

**A fixed 2,620-token difference, present at request #1.** It cannot be
history management: there is no history yet.

Per-turn growth afterwards is comparable — kiso +178 / +252 / +121
against pi +235 / +234 / +169 — and **compaction events are zero on both
sides**. Nothing was summarized, truncated or dropped by either agent.
kiso's largest context in the batch was ~4,147 tokens against a
microcompact threshold two orders of magnitude higher.

## What this retracts

The batch's headline was that pi feeds ~3× the context and that kiso
"spends less by carrying less" — an architectural claim. **It is
withdrawn.** The dominant term is a static request surface that one arm
loaded and the other was not given, because of how the drivers were
written.

Removing 2,620 tokens per pi request moves the paired cost-weighted
ratio from 3.11× to roughly **2.32×** — an ESTIMATE, assuming the whole
gap is contamination and that nothing else moves, which only a clean
re-run can establish. About a quarter of pi's measured total is the
contaminated surface.

The request-count difference (105 vs 79, 1.33×) is **not** explained by
this and remains a real observation.

## What it does NOT excuse

The contamination is a confound in **both directions** and must not be
used one way. It could have made pi worse (irrelevant instructions,
including another product's contributor rules) or better (extra
capability). Nobody knows which.

- The reliability results still stand as recorded. **kiso's C3 failure
  is attributed by a reproduced code chain plus physical double-deploy
  evidence, and none of that involves pi's context.** Same for C9-r2 and
  RD1B-F6.
- pi's c3-r2 PASS stands. Discovering that a competitor's environment
  was richer is not grounds for re-reading a cell it won.
- What weakens is the **comparison**: the arms were not running the same
  experiment, so any cross-arm reading — the counts as much as the
  tokens — carries this confound. The batch's conclusion was already
  "no kiso reliability advantage is demonstrated", and that conclusion
  does not depend on the direction of the bias.

## Why it survived several reviews

Every earlier round asked whether the SCORING was fair — the scorer, the
axes, the populations, the surrogate. Nobody asked whether the two
processes were given the same world to start in. The token result was
also the finding everyone liked, including three review passes, which is
its own lesson: the number that survives scrutiny longest may be the one
nobody wanted to break.

## The re-test that would settle it (not run — owner's call)

1. **Surface probe, one request per arm, no task.** pi with an isolated
   `PI_CODING_AGENT_DIR` and skills/context-files/extensions disabled;
   kiso as now; fixtures OUTSIDE the kiso repository so no ancestor
   instruction file is reachable. Compare the static surfaces directly.
   Cleaned up, pi's base surface may be no larger than kiso's — that is
   an open question, not a prediction.
2. **Then the real product comparison**, if wanted: the SAME `AGENTS.md`
   in the fixture and the same relevant skill installed on both, each
   loaded by its own native mechanism. That measures the products as
   shipped instead of measuring one operator's laptop.
