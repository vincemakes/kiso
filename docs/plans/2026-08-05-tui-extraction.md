# TUI extraction — packages/tui, per-package gates, zero behavior change

> Date: 2026-08-05
> Status: complete — the ADR-0041 escape hatch executed (ADR-0043)
> Authority: direction ruling 2026-08-05 (user): the extraction spec —
> pure refactor, zero behavior change is the hard acceptance.

## 1. The extraction

The terminal layer — body (cell renderer), dock, editor (raw mode),
render (palette/event rendering/banner/recap), diff — moved to
`packages/tui` (`@vincemakes/kiso-tui`), ZERO runtime dependencies:
input is data, output is bytes. The only cross-package runtime
reference (the approval detail's canonical path, tools-node) became an
INJECTED resolver (`renderEvent(ev, prevThinking, resolvePath)` — the
cli passes `canonicalTargetPath`). The cli keeps mode.ts (the policy
chain), the approval flow, the command dispatch, and the session
wiring. The canonical-path test moved to the cli verbatim (it tests the
CLI's injection); every other test moved with its file, assertions
untouched.

## 2. Gates (ADR-0043)

Measured after the extraction: cli = 1099, tui = 1261. Per-package
gates = actual + 20%: **cli 1320, tui 1520** (core stays 2000). The
single 2400 terminal cap is superseded — the sum may exceed 2400; the
layering's breathing room is the legitimate yield of extraction
(written into the ADR so future readers do not misread it as a
violation).

## 3. Zero-behavior acceptance

- All tests green with ZERO assertion edits (533 — the pre-extraction
  count; test files moved, import paths updated mechanically).
- Pipe output vs 0.1.18: byte-identical (diff shows only the session id
  line of the rerun).
- PTY smoke vs 0.1.18: the byte stream matches with only non-semantic
  differences (session id, version, wall seconds) — normalized diff
  empty.
- The behavior gates — idle probes (long + short), scrollback flood,
  interleave lint, kill -9 — all green in the suite.

## 4. Release 0.1.19

Eight packages published in topology order (core → evals → providers →
tools-node → runtime → **tui** → cli — kiso-tui enters the chain before
the cli), smoke tier D ships the eighth tarball, tag v0.1.19 pushed
before publish. Registry notes: the new package's metadata lagged
behind the blob upload (~2 min — the tarball was fetchable immediately,
`latest`/versions propagated later; not an error, retried clean).
Post-publish: registry eight packages at 0.1.19, fresh-install smoke
EXIT 0 (recap line present), bare runs EXIT 0 (`~`, `/`, empty non-git
dir).

## 5. Evidence

- clean-tree: `git status --short` empty, `git log origin/main..HEAD
  --oneline` empty at delivery.
- Gates: core 1887/2000, cli 1099/1320, tui 1261/1520; full suite 533
  green (77 files).
- Out of scope (recorded): any TUI behavior change, new features, or
  API polish — the extraction only moves furniture. The decoration
  wishes go to the next round's plan.
