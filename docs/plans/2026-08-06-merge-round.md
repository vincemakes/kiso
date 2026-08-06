Translated from the original Chinese round record (2026-08-06)

# Merge round — the fresh mystery investigated and fixed + the Config settings surface, release 0.1.23

2026-08-06. Spec: "the merge round: investigate and fix the fresh mystery
+ the Config settings surface, release 0.1.23. Two independent
workstreams, A first then B; reporting discipline as usual."

## A. The fresh mystery — the ruling: a measurement error + one real D-area violation, both fixed

### Evidence gathering (evidence before code)

- the `KISO_DUMP_REQUESTS=<dir>` debug tool (openai provider, dumps the
  full request body to disk by sequence number before sending, kept as a
  permanent debug tool, the docs note it contains sensitive content) +
  `bench/dumpdiff.py` (the byte-for-byte common prefix + the JSON path
  of the first divergence).
- a real DeepSeek 3-turn session: 14 requests, 13 adjacent pairs, **two
  breakpoints, both at turn boundaries**; the request after a breakpoint
  jumps fresh to ≈ the whole history (49% cached vs the usual 90%+).

### The two findings

1. **The "fresh ≈ system-prompt size" anomaly is an extractor
   measurement error** — extract.py output kiso's `inputTokens` (the
   DeepSeek convention: includes the cached prefix) as the "fresh"
   column, and "raw total" = input + cache DOUBLE-COUNTED the cache.
   The true fresh/req = 77-295, the same order as pi (≈326); per-run
   cached 82-99% request by request; req 1's cached=1024 proves the
   system prompt is byte-stable across sessions. The README's dual-
   metric headline ("pi overtakes 2.7×") and the fresh backlog item
   both rest on this error. **Fix**: extract.py/extract-t5.py unify the
   fresh/total/cost_weighted accounting (kiso: fresh = input − cache;
   pi/CC: input IS fresh), the semantics pinned in
   `bench/tests/test_extract.py` (regression test), and the README
   tables + headline fully re-baselined (the 0.1.7 history section
   fixed at the same time: the "total doubled" story is also a double-
   count artifact — 0.1.7's 9.5K equals the corrected current 9.5K).
2. **One real D-area request-level violation (suspect ③ confirmed)**:
   the openai adapter's C7 rule binds `reasoning_content` presence to
   the "current turn"; once a turn boundary passes, the old turn's
   assistant messages get the field stripped — old history rewritten,
   the prefix breaking at the old message (one cache breakpoint per
   turn boundary). **Fix (a monotone rule)**: if ANY reasoning exists
   in the projection, EVERY assistant message carries the field (its
   own reasoning or ""); otherwise none do. Presence flips at most once
   per session (the first thinking, usually in the first turn); zero
   flips at turn boundaries; real OpenAI never produces reasoning → its
   request path is byte-identical to the old behavior. Real-API
   verification: old turns with ""/reasoning return 200 + 2560 cached;
   after the fix the same session's 13 pairs are all HEALTHY, per-
   request cached 82-99% (turn boundaries included). The contract
   wording expands into ADR-0026 Amendment 1 (a request-level
   invariant: request N+1 shares a byte prefix with request N through
   the end of N's last message — the maximum reachable prefix; the
   messages-array insertion point is the only legal divergence).

## B. The Config settings surface (ADR-0045, the three rulings implemented as ruled)

- **Credentials never hit disk**: the config stores only the apiKeyEnv
  NAME; a missing env = the profile is marked unavailable, switching is
  refused loudly, no crash.
- **Project config joins the trust bundle**: `<cwd>/.kiso/config.json`
  becomes the E3 gate's FOURTH artifact kind (covered by the digest;
  any change re-triggers the ruling); an untrusted project's config is
  never read.
- **No "always"**: projectTrust has only "ask" (the default E3 gate)
  and "never" (auto-deny: no question, no load).

schema v1 (model/models{kind,baseUrl?,model,apiKeyEnv}/mode/
contextWindow/autoCompact/projectTrust); precedence flags > env >
project > user > default; broken JSON fails loudly (with the file name);
unknown keys pass (forward-compatible). `/model` (the list marks
availability + runtime switching, noted in a NoticeCell), `--model` (a
profile name or a direct provider/model write), and the menu gains
English descriptions. Zero kernel changes; three light touches in
runtime (buildAdapter exported / session.setAdapter / the trust bundle's
config.json artifact).

## Verification & release

- 586 tests all green (563 at 0.1.21); published-artifact
  re-verification: the globally installed 0.1.23 with a real DeepSeek
  short session — 12 requests, 0 breakpoints, cached 85-98% (the A fix
  re-verified on the published artifact).
- bench fully re-baselined: kiso T1-T5 re-run on 0.1.23 (n=2) with the
  extractor's corrected accounting, README tables/headline updated.
  T4/T5 totals rise slightly vs the 0.1.22 re-extraction (reasoning
  echoes ride the cache at 0.1×, the cached share 24.6K→40.3K /
  102.7K→131.8K; session-length variance at n=2), and on T4
  cost-weighted pi edges one cell at 7.2K vs 8.0K — stated plainly.
- Release 0.1.23, eight packages (core/evals/two providers/tools-node/
  runtime/tui/cli), peerDependencies bumped in sync.

## Gates (the measured basis = comment-stripped, blank-line-stripped code lines, matching the 0.1.21 record file by file)

- core 1914/2000 ✓ · tui 1335/1520 ✓ · **cli 1547/1320 ⚠ over by 227**.
- The cli overage comes from the spec-mandated config surface (the new
  config.ts module + wiring, ≈316 lines). A ruling requested via the
  ADR-0043 escape hatch: the config surface is a one-time increment;
  recalibrate the cli gate (actual +20%) or accept this round's
  overage.

## Acceptance

- clean-tree: `git status --short` empty + `git log origin/main..HEAD
  --oneline` empty (pushed).
- Raw data paths: `bench/runs/<tool>-<task>-<run>/` (the kiso cells are
  0.1.23 re-runs; pi/claude are the 0.1.22-era data, the accounting
  corrected).
