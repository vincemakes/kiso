Translated from the original Chinese round record (2026-08-06)

# Token round — tool-output discipline + request-count shrink + the T4 disqualification investigation, release 0.1.27

2026-08-06. Spec: "the token round (the main-battlefield special):
tool-output discipline + request-count shrink + the T4 disqualification
investigation, release 0.1.27. Scoreboard = bench T2-T4 cost-weighted."
The red line: saving tokens must not blind the model — every truncation
carries an actionable continuation path. Reporting discipline as usual.

## Evidence gathering (evidence before code)

- The tool status quo (tools-node/src/index.ts): read_file reads the
  WHOLE file + a generic 100K-character cap ("…[truncated]", **not
  actionable**); search_text has a hard 200-match cap (no count, no
  note); list_dir has no cap. The schema has no range parameters.
- The system prompt (cli index.ts): the existing 5 disciplines,
  including "search_text and list_dir are cheap — use them to orient
  before reading whole files".
- The T4 structural difference (the bench/runs 0.1.26 trajectories
  rebuilt event by event):
  - kiso run2: **13 requests / 16 tool calls**. The model physically
    explored `.claude/skills` (list_dir ×3 + read_file ×1 = REQ8-11);
    also read clamp.test.js/README.md/package.json to locate the
    convention; one merge-verify failure (REQ15) → re-run (REQ16).
  - pi run2: **8 requests / 10 calls**. --skill injects the whole
    SKILL.md into the prompt, zero exploration overhead; bash
    exploration + read ×2 + edit ×2 + bash verify ×4.
  - Initial judgment: the request-count gap ≈ model choice + a design
    difference (two-level progressive loading vs full-text injection).
    **The post-release investigation overturned the first half**: the
    KISO_DUMP_REQUESTS reconciliation shows the system prompt has NO
    skills index line — the harness never loaded the skills extension
    (see the release record); the model was exploring bare. The
    framework lever always existed; the bench just never measured it.
- The scoreboard status quo (the README 0.1.26 line): T4 cost-weighted
  kiso **6,586** vs pi **7,249** — kiso already wins on cost-weighted;
  the disqualifying item is the **request count** (13 vs 8.5).

## Changes

1. **Tool-output scoping** (tools-node):
   - read_file gains `offset?`/`limit?` (1-based line numbers); with no
     args, a >200-line file defaults to the first 200 lines + "… N
     more lines (call again with offset=201)" (singular "line");
     ≤200-line behavior is byte-for-byte unchanged; an out-of-range
     offset = an honest invalid_input (reporting the line count); the
     output character cap becomes **line-boundary cutting + an
     actionable next-offset note** (a single over-cap line gets the
     shell path instead, preventing loops); everything deterministic.
   - search_text caps at 50 matches + a full count + "… +N more
     matches (narrow the pattern)" (the walk no longer stops early —
     the N in the note must be the file's true total); list_dir caps
     at 200 + "… +N more entries (narrow to a subdirectory)".
   - schema/descriptions synced (the description is the model's user
     manual).
2. **The request-count shrink** (system prompt, restrained +6 lines):
   ① independent calls go out in one round (the parallel infra);
   ② search first, then ranged reads with offset/limit — no whole-file
   reads of large files; ③ never re-read unchanged content. The
   existing "search_text cheap" bullet merges into ② — no prompt
   piling.
3. **The T4 disqualification investigation**: T4 re-run on the
   published artifact (n=2, per-request reconciliation via
   KISO_DUMP_REQUESTS), closed deliberately or recorded honestly.

## Acceptance

- ① unit tests: scoped-reads.test.ts 17 cases (ranges/truncation
  notes/determinism/boundaries/refactor/over-cap) all green; the
  registry dedup regression enters kernel-contract (10/10).
- ② PTY e2e: scoped-read-e2e.test.ts — a large file truncates by
  default + the model continues the read on the note (offset=201), the
  session log carries both results + call assertions.
- ③ bench T2-T4 kiso cells re-run: T2/T3 request counts 4/5 unchanged;
  the cw mean's r1 cold-start influence recorded honestly (r2 steady
  state within variance); **the T4 flip**: 5 requests (pi 8.5), cw
  mean 2,327 (pi 7,249, 3.1×), wall clock 13s (pi 34s), both pass.
  The flip rests on the harness fix (the product's native mechanism) +
  batch guidance — the reasons and the whole process are in the release
  record.
- ④ pipe regression + gates zero regression: check EXIT 0, 89 files /
  614 tests, smoke 5 tiers PASS.

## Gates

- core / cli / tui — the changes are in tools-node (no gate) and the
  cli prompt (counts toward the cli gate); the check record below.

## Release

0.1.27, the standard template flow (tag before publish; topology order;
post-publish verification).

## Acceptance

- clean-tree: `git status --short` empty + `git log origin/main..HEAD
  --oneline` empty (pushed).
- Out of scope: output compression / dedup caching (touches staleness
  — a separate discussion) / request-level concurrency.

## Release record (post-publish)

- **0.1.27 published, eight packages** (tag before publish, topology
  order, the global CLI at 0.1.27).
- **bench re-run (0.1.27)**: T2 7s/6s pass, T3 11s/12s pass, **T4 r1
  29s pass / r2 19s FAIL** — r2's model never discovered the skill
  (daysBetween passed but the version was not bumped; the root list
  shows .claude/ but the model never drilled in). Request counts: 13 →
  **9/8** — the batch guidance worked (r1's cold start on the prompt
  change recorded honestly).
- **The T4 disqualification investigation (per-request
  KISO_DUMP_REQUESTS reconciliation, reconcile-t4.py)**: ① dumpdiff
  all green (every divergence sits at the end of the messages array —
  the ADR-0026 insertion point); ② the skills-index-line is **absent**
  — a harness bug: run-one.sh's extensions dir only has bench-allow,
  the official skills extension was never loaded (yet the scenario
  spec says "kiso via its native mechanism: the skills extension's
  index + read_skill"). 0.1.26's 13 requests were the price of bare
  exploration, not the product.
- **Fixing the harness → unearthed a latent real bug from 0.1.26**:
  with the skills extension loaded the real API returned "400 Tool
  names must be unique" — the agent both **eagerly registers**
  sync-extension tools AND runs the **registerLive** track, so
  read_skill entered the spec twice (skills/subagent/mcp status all
  hit it; the faux tests were all blind). Fixed: registry.list()
  dedups (a map wins, the same rule as get()/has()/the docs), a
  regression test into kernel-contract.
- **0.1.28 published, eight packages** (the fix rode the release; one
  npm local-cache ETARGET pitfall — the global CLI landed after
  forcing --prefer-online).
- **T4 re-run on 0.1.28 with the fixed harness: 15s/11s, both pass**;
  reconciliation: r1 gets the convention straight from the system
  prompt's index line, r2 goes the native read_skill route (batched
  with the reads) — **5 requests ×2 (pi 8.5), cost-weighted mean
  2,327 (pi 7,249, 3.1×)**. The T4 flip is complete, and it even beats
  pi by 3.5 requests.
- **bench README refreshed**: the kiso T2/T3/T4 rows, the T4
  harness-fix note, the headline (the T4-overtaken sentence retired);
  the product README syncs the condensed table + a tool-scoping
  paragraph + the honest cold-start note. T2/T3 r1's fresh includes
  the one-time cold start from the prompt change (r2 steady state
  within variance).
- Gates: core 1981/2000 · cli 1552/1856 (+3: the prompt guidance
  lines) · tui 1361/1520; 89 files / 614 tests; smoke 5 tiers PASS.
- Out of scope unchanged: output compression / dedup caching (touches
  staleness — a separate discussion) / request-level concurrency.
