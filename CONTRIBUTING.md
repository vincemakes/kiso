# Contributing to kiso

Thank you for looking. kiso is small on purpose, and the rules below are what keep it
that way. They apply to every change, including the maintainer's.

## Before you write code

- **Open an issue first** for anything beyond a typo or a one-line fix. Say what is
  wrong or missing, how you noticed, and what you observed. A screenshot of the terminal
  or the durable session log (`~/.kiso/sessions/<id>.jsonl`) is worth more than a
  description.
- **Read the ADR** that governs the area (`docs/adrs/`). Every design decision ships with
  one that says why it was made and when to overturn it. A change that contradicts an ADR
  needs an amendment to that ADR in the same pull request, not a silent exception.
- **The kernel has a size rule.** `packages/core` cannot exceed 2,200 lines
  (`docs/kernel-rule.md`, ADR-0043). A change that pushes it over has to remove something
  first.

## While you write it

- **Red first.** A behaviour lands with a test that failed on the tree before the change.
  Terminal behaviour is proven on a real pseudo-terminal (`apps/cli/tests/helpers/pty.ts`;
  register the file in `tests/pty-suite.json`), not by string-matching a renderer.
- **English only** in code, comments, commit messages and docs (`README.zh.md` is the one
  exception). No competitor is named in source comments or commit messages.
- **Commit format:** `<type>(<scope>): <subject>` — types `feat` `fix` `refactor` `test`
  `docs` `bench` `chore`; scopes `core` `runtime` `tui` `cli` `tools-node` `providers`
  `mcp` `skills` `subagent` `evals` `bench`. The body says what changed and why, and
  names the finding or ADR it answers.
- **No plans or design notes in the repository.** Runnable scripts may live here; the
  thinking lives in the ADRs.

## Before you push

Run the whole chain — it is what CI runs:

```bash
npm run check
```

That is build, typecheck, the unit pool, the PTY pool, the size rule, the pack check, the
API-surface check, the README hero check, whitespace, the CJK gate, the version lockstep,
the PTY manifest, the dist inventory, the bench reproducibility check, the byte gate, the
packed-tarball smoke and the demo. A red gate is a finding, not an inconvenience: fix the
cause, never the gate.

## Pull requests

- One concern per pull request. A refactor states its zero-behaviour proof.
- Describe the red-to-green evidence in the description (`red: … / green: …`).
- The maintainer reviews every change structurally (dead machinery, misleading comments,
  duplication, layering, method size) and behaviourally (the gates). Expect questions.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence that
covers the project.
