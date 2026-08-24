# RD1B-Finding-007 — the arms did not run in comparable environments

- **id:** RD1B-F7
- **class:** benchmark contamination / unequal isolation
- **severity:** P1 for the benchmark — it invalidates the batch's
  headline attribution and confounds the rest of the comparison
- **scope:** the harness (both drivers), RD-1B and every earlier
  kiso-vs-pi run using the same driver pattern
- **status:** CONFIRMED, DECOMPOSED, AND REPLAYED (2026-08-24). The
  contamination is measured, its direction is reversed, and the whole
  batch has been re-run under symmetric environments
  (kiso-doc/kiso-rd1b-clean-replay-report.md). No product code changed;
  RD-1B's artifacts and verdicts are frozen and untouched.

## What is unequal

    kiso driver   KISO_HOME = a fresh empty directory per cell
                  → no user skills, no user extensions, no user config
                  and readProjectInstructions() reads the CWD ONLY

    pi driver     os.environ.update(env) with NO clear() first, so the
                  child inherits the ENTIRE parent environment — not
                  just HOME. Only the SESSION dir is isolated.
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

**That figure is a NET BASELINE GAP under unequal environments, not a
measured quantity of contamination.** It also contains whatever the two
products' native system prompts and tool schemas differ by, and those
have never been measured against each other. The skills index and the
ancestor `CLAUDE.md` are large enough to account for a gap of this order
— roughly 12,900 characters of extra system-prompt surface between them
— but "large enough to account for" is not a decomposition. The surface
probe below is what would produce one.

Per-turn growth afterwards is comparable — kiso +178 / +252 / +121
against pi +235 / +234 / +169 — and **compaction events are zero on both
sides**. Nothing was summarized, truncated or dropped by either agent.
kiso's largest context in the batch was ~4,147 tokens against a
microcompact threshold two orders of magnitude higher.

## The decomposition (measured, replicated)

Both agents, same trivial prompt, **cleared environment plus one
identical whitelist**, each with its own empty profile directory, and a
fixture OUTSIDE this repository. Each agent's own reported first-request
prompt tokens — the same metric that produced the 2,371-vs-4,991 figures
above, so these are directly comparable. Two independent runs:

| condition | run 1 | run 2 |
|---|---:|---:|
| **pi-clean** (`-ns -nc -ne`) | **1,657** | **1,656** |
| **kiso-clean** (empty `KISO_HOME`) | **1,937** | **1,937** |
| pi + the 13 skills | 3,997 | 4,009 |
| pi + ancestor `CLAUDE.md` | 3,110 | 3,108 |
| pi + both | 5,463 | 5,474 |
| kiso + `CLAUDE.md` in the CWD | 3,330 | 3,330 |

Composition, by differencing conditions rather than parsing prompts:

| component | run 1 | run 2 |
|---|---:|---:|
| the 13 installed skills | +2,340 | +2,353 |
| the ancestor `CLAUDE.md` | +1,453 | +1,452 |

**The cleaned baseline: pi − kiso = −280 and −281 tokens. kiso's static
request surface is LARGER than pi's by about 280 tokens.**

RD-1B measured pi as **+2,620 larger**. So the contamination did not
merely inflate the gap — **it produced the gap's direction**. Removing
it does not leave a smaller kiso advantage; it leaves a small kiso
disadvantage.

Two supporting observations:

- kiso is not cheaper at loading instructions either. The same
  `CLAUDE.md` costs pi +1,453 tokens and kiso +1,337 — comparable.
- Replication is near-exact (kiso identical to the token across runs,
  pi within 1–13), so the ±280 margin is real and not path noise from
  the temp directories.

**Scope.** This measures the STATIC BASELINE — first request, trivial
prompt, no user-installed resources on either side (built-in tools and
extensions are part of each product and stay). It says nothing yet about
per-task totals, request counts, or the full-batch ratio; those need the
clean replay. And kiso's own `contextManifest` split (system 642, tools
988) is an ESTIMATE by kiso, not the server's count — only the totals
above are directly comparable.

## What this retracts

The batch's headline was that pi feeds ~3× the context and that kiso
"spends less by carrying less" — an architectural claim. **It is
withdrawn, and the decomposition above shows it was backwards.** The
dominant term is a static request surface that one arm loaded and the
other was not given, because of how the drivers were written; with both
arms clean, the baseline tilts the other way.

Subtracting 2,620 tokens from every pi request, cache-read first, moves
the paired cost-weighted ratio from 3.11× to about 2.32×. **That is a
mechanical sensitivity scenario, not an adjusted benchmark result, and
it must not become the replacement headline.** It assumes the entire gap
is removable, that removing it changes no behaviour, no request count
and no cache boundary — and the whole point of this finding is that
those assumptions are exactly what went unchecked. The only number that
can replace 3.11× is one produced by a clean run.

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

1. **Surface DECOMPOSITION, one request per condition, no task and no
   upstream.** Both agents pointed at a recording proxy that captures
   the request body and answers it locally, so this costs nothing and
   measures composition rather than inferring it. Five conditions:
   pi clean · pi + the 13 skills · pi + the ancestor `CLAUDE.md` ·
   pi + both · kiso clean. What is compared is the SPLIT — system,
   tools, instructions, skills — not a total.

   Isolation for it must be symmetric, which today it is not: the child
   process gets a cleared environment plus one identical whitelist in
   both arms, each agent gets its own isolated profile directory, and
   the fixture lives OUTSIDE this repository so no ancestor instruction
   file is reachable. Setting `PI_CODING_AGENT_DIR` alone would not have
   been enough.

   Cleaned up, pi's base surface may be no larger than kiso's — that is
   an open question, not a prediction.
2. **Then a clean replay of the batch**, on the same versions this batch
   used — kiso 0.15.1 and pi 0.84.2 exactly — with an env-key manifest,
   a resource inventory and prompt/tool hashes recorded per run, so the
   environment is evidence rather than a memory. **The RD1B-F1 fix and
   any 0.15.2 must stay OUT of it**: a run that changes the environment
   and the product at once cannot tell you which one moved the number.
   New versions and a Claude Code third arm belong in RD-1C.

3. **Then the real product comparison**, if wanted: the SAME `AGENTS.md`
   in the fixture and the same relevant skill installed on both, each
   loaded by its own native mechanism. That measures the products as
   shipped instead of measuring one operator's laptop.


## The clean replay (2026-08-24)

The batch was re-run with the environment fixed: cleared child env plus
one identical whitelist, an empty profile directory per arm, pi's user
resources off through its own `-ns -nc -ne`, fixtures outside this
repository, and the environment recorded per cell. Versions pinned to
the ones RD-1B used — kiso 0.15.1 from the **published registry
artifact**, pi 0.84.2 — with the RD1B-F1 fix deliberately excluded, so
the environment is the only thing that changed.

**Reliability barely moved: 2 cells of 40.** pi c2-r1 PASS→FAIL and kiso
c9-r2 FAIL→PASS, both in cells already known to be stochastic. C3 (kiso
FAIL/FAIL, pi FAIL/PASS) and C7 (kiso FAIL/FAIL) reproduced exactly.
Same-scenario counts went from kiso 13/16 vs pi 15/16 to **14/16 each —
tied**.

**Cost collapsed and the mechanism inverted:**

| | RD-1B | clean |
|---|---:|---:|
| cost-weighted ratio pi/kiso | 3.11× | **1.33×** |
| paired median | 2.40× | **1.51×** |
| total input ratio pi/kiso | 3.01× | **0.86×** |
| cache hit kiso / pi | 96.2 / 94.6 | 96.3 / **88.0** |

**kiso feeds MORE total context than pi** once both are clean. Whatever
cost advantage remains is caching and uncached input, not context size —
the opposite of what RD-1B concluded, and RD-1B had explicitly ruled the
caching explanation out on the strength of hit rates that the
contamination itself was inflating.

That is the sharpest form of this finding: the contaminated batch did
not merely overstate a real effect. It reported the wrong effect, with
the wrong mechanism, in the wrong direction, and then reasoned
correctly from it three times.
