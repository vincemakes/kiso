# RD1B-Finding-005 — the reproduction chain did not reproduce

- **id:** RD1B-F5
- **class:** benchmark integrity / evidence chain
- **severity:** P1 for the benchmark — the report's central honesty
  claim ("re-derive every number yourself") was itself unverified
- **agent:** the harness (bench/rd1/harness)
- **baseline:** the second issue of the RD-1B report (kiso-doc 7375030)
- **status:** FIXED, and gated

## What was claimed, and what happened

The report listed four commands that "re-derive every number from the
archived artifacts". All three tools read `bench/rd1/out/` — the
UNTRACKED working directory. Copying only the tracked files into an
empty directory, as any reader would have:

| command | result |
|---|---|
| `archive.py --verify` | DRIFTED — it hashed the live tree, not the tarball |
| `rescore.py` | **empty grid, `0/0 cells`, exit 0** |
| `metrics.py` | `FileNotFoundError` |

All 39 score-manifests also record absolute paths from the producing
machine, so even unpacking the tarball would not let the scorer resolve
a single artifact.

## The failure that matters

The middle row. `archive` and `metrics` failed loudly; `rescore` printed
a well-formed, empty grid and exited 0. **A tool that reports nothing
and succeeds is indistinguishable from a tool that worked** — and the
number it would have been quoted for is "no cells failed".

That is the same shape as the defect this whole round began with:
RD1B-F1's inverted question also looked right on screen. Both were
caught by someone re-deriving a claim rather than reading it.

## The fix

- `--verify` streams the TARBALL and checks it against the manifest;
  `--verify-live` keeps the working-tree check for use before archiving.
- `batches.py` materializes a batch from the tracked archive by default
  (`--live` opts back into the working directory) and relocates recorded
  absolute paths **in memory** — nothing on disk is edited, because the
  frozen artifacts must stay frozen.
- Missing evidence, zero cells, a non-zero scorer exit and an unscorable
  cell all exit non-zero. Absent evidence is an error, never an empty
  result.
- Observation sentences are de-rooted, so the deliverable is byte-stable
  across machines rather than carrying whichever directory produced it.

## The gate

`scripts/check-bench-repro.mjs`, in `npm run check`: copies only
`git ls-files` output into an empty directory and runs the documented
commands there. It asserts INTACT, a full cell count per batch, the five
axis names, and that no absolute path leaks into the output.

Written BEFORE the fix and red on every defect above — including one
nobody had noticed, that `batches.py` was not yet `git add`ed and so
would not have reached a clone at all.

## The rule this generalises to

A reproducibility promise is a claim like any other, and claims in this
benchmark are mechanically checked. Any future "you can re-derive this"
sentence needs a gate that runs from tracked files only, or it is just
the next unverified assertion.
