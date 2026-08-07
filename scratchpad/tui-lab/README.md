# TUI v6 lab — the five recorded symptoms, each pinned as a runnable scenario

Every scenario drives the REAL CLI in a real pty (24×80) and exits 0 on
pass / 1 on fail. Together they pin the ghost-spectrum the v6
one-compositor (ADR-0046) was built to kill:

| # | scenario | the recorded symptom | what the scenario proves |
|---|---|---|---|
| 1 | `01-startup-first-frame` | the startup first frame | sequential emission — no pre-clear (no ED2/3J), the banner rows in order, whole |
| 2 | `02-logo-rows` | the logo row cut by reflow | every banner row emits whole (hard-folded ≤ W — invariant ①) |
| 3 | `03-no-same-row-dupes` | the same row painted twice | each screen row's content appears exactly once |
| 4 | `04-approval-slot` | the approval takeover | the ApprovalPrompt SLOT occupies the input row (the question + the typed answer), the brick returns after |
| 5 | `05-no-concatenated-lines` | two cells merged in one line | every reconstructed line matches a known cell format (the v2d interleave lint) |

## Run

```sh
node scratchpad/tui-lab/run-all.mjs
```

or each individually: `node scratchpad/tui-lab/scenarios/01-startup-first-frame.mjs`.

The scenarios assert on the BYTE stream (what the terminal sees). The
resize/reflow symptoms (the fold/body merge, the tail ghost, the
separator wall) live in the committed gates
(`apps/cli/tests/tui-v4-reflow.test.ts` — the VT-emulator screen-state
probe) and the real-machine drag acceptance.

Out of scope (v6): overlay composition, mouse, images, markdown,
suspend-passthrough. The `$EDITOR` scenario needs opencode's suspend +
the two-sided cache-clear lesson — recorded as a TODO.
