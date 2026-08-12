# Session fixture provenance (ADR-0051 §3, ruling R4a)

Every generation sample is a REAL log written by a REAL published bin.
Hand-synthesized session fixtures are forever forbidden as generation
samples (R4a). The rows below record, per sample: the bin, the date, the
command that wrote it. The producer is
`packages/runtime/tests/fixtures/produce-generation-samples.sh` — the
samples are reproducible from it.

| file | bin (published) | generation | written when / by | how (command) |
| --- | --- | --- | --- | --- |
| `dogfood-0143.jsonl` | @vincemakes/kiso-code@0.1.43 | E | 2026-08-10, the R-E dogfood (execution side), real model | `kiso dogfood-0143` under the R-E driver (committed `5ac2f12`) |
| `dogfood-0143b.jsonl` | @vincemakes/kiso-code@0.1.43 | E | 2026-08-10, the R-E dogfood (reviewer side b), real model | same driver family |
| `review-0143.jsonl` | @vincemakes/kiso-code@0.1.43 | E | 2026-08-10, the R-E review session, real model | same driver family |
| `gen-d-0142-faux.jsonl` | @vincemakes/kiso-code@0.1.42 | D | 2026-08-12, faux-mode one-shot | `printf 'Survey the repository structure.\n' \| npx -y "@vincemakes/kiso-code@0.1.42" fxgen0.1.42` (KISO_FAUX_SCRIPT = the producer's `faux.json`), session `fxgen0.1.42` |
| `gen-d-0142-real.jsonl` | @vincemakes/kiso-code@0.1.42 | D | 2026-08-05 (the R-C dogfood, real model) | captured verbatim from `~/Desktop/devv/kiso-0.1.42-dogfood/transcript.jsonl` |
| `gen-e-0146-faux.jsonl` | @vincemakes/kiso-code@0.1.46 | E | 2026-08-12, faux-mode one-shot | same command pattern with 0.1.46, session `fxgen0.1.46` |
| `gen-f-0148-faux.jsonl` | @vincemakes/kiso-code@0.1.48 | E/F | 2026-08-12, faux-mode one-shot | same command pattern with 0.1.48, session `fxgen0.1.48` |
| `gen-e-0146-marker.jsonl` | @vincemakes/kiso-code@0.1.46 | E + markers | 2026-08-12, faux-mode one-shot, heavy script | `KISO_CONTEXT_WINDOW=16000` + `faux-heavy.json`, session `m46` — 8 real `microcompacted` boundaries |
| `gen-f-0148-marker.jsonl` | @vincemakes/kiso-code@0.1.48 | E/F + markers | 2026-08-12, faux-mode one-shot, heavy script | same override, session `m48` — 8 real `microcompacted` boundaries |

Generations (ADR-0051 §3): D = summarized era, pre-`invocationSeq`
(0.1.38–0.1.42); E = `invocationSeq` + `model_output_abandoned` (0.1.43+);
F = the ADR-0050 native lock convention (0.1.47+; the JSONL is unchanged
from E — the lock is a separate file).

Historical notes, documented honestly:

- **No published bin ever writes `compacted`**: the earliest published
  bin (0.1.25) already contains the compaction retirement (a8cfbb9).
  The compacted-era READING rules (v1 `{callId, content}` and v2
  `{eventSeq, callId, content}` entry shapes) are pinned by the
  pre-existing inline fixture in `legacy-session-upgrade.test.ts`
  (which predates R4a and is not counted as a generation sample).
- **No real dogfood log from any round (0.1.42→0.1.48) contains a
  `microcompacted` or `summarized` record** — the context policies never
  triggered in real usage. The marker-bearing sample
  (`gen-e-*`-marker) is produced deliberately via the product's own
  `KISO_CONTEXT_WINDOW` override (see the producer); the load/project
  paths for the markers are additionally pinned by `microcompact-e2e`
  and `summarize` runtime tests.
