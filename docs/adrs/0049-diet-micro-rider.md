# ADR-0049: The diet-micro rider (0.1.47)

- **Status:** Accepted — adjudicated by the review, 2026-08-11
- **Date:** 2026-08-11
- **Layer:** repo-wide (scripts, extensions, docs)

## Context

The 0.1.47 round (the Lock Adapter, ADR-0050) was adjudicated with a
rider of four independent micro-items (A–D), each hard-capped to its
directive scope. The items share one shape: small surface corrections
that were noticed during the round's work but are NOT the round's
mechanism — they ship as separate, independent commits so each has its
own record and revert path.

## Decision

1. **A — MCP with no configured server exposes `tools: []`.** When the
   config names zero enabled servers, the `mcp` extension registers no
   tools — not even `mcp__status`. An unconfigured extension never
   occupies a model tool slot; the status tool exists only when there
   is something to report status about. (The previous status-tool-only
   behavior is the red side of the gate in the mcp test suite.)

2. **B — `scripts/request-surface.mjs`.** A new repo tool that
   enumerates the packages' public request surface: every name the
   `dist/index.d.ts` chain exports, per package, sorted, with a total.
   The round report's surface-delta line is a plain `diff` between two
   runs. The surface is read from the BUILT dist (the published
   artifact), never from src — the .d.ts chain is the contract.

3. **C — README built-in attribution corrected.** The four official
   extensions' "built-in since" attribution said 0.1.44; the layer
   actually landed in 0.1.45 (commit f9b599f, before the 0.1.45
   release). README text corrected to 0.1.45. Pure documentation.

4. **D — `task_set` refuses duplicate texts.** A duplicated line would
   fork the echo's counts from the CLI's checklist cell — the whole
   table-replace discipline (resend the corrected list) already covers
   the correction path, so duplicates are refused loudly as
   `invalid_input`, the same shape as the at-most-one-active rule.
   Kernel untouched; the extension stays stateless.

## Consequences

- The four items are four independent commits (A/B/C/D), each scoped
  to its directive's exact file set; reverting one never touches the
  others.
- The extension surface shrinks by one tool in the unconfigured case
  (A) and the task contract gains one refusal (D) — both are loud,
  testable gates (red→green in the extension suites).
- The request-surface tool becomes the standing answer to "what is
  the public API delta this round?" — its first use is the 0.1.47
  round report.
- None of the items touches `packages/core` or `packages/runtime` —
  the kernel and the runtime remain at zero diff for the rider.
