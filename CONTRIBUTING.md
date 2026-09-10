# Contributing to kiso

Thank you for looking. kiso is small on purpose, and the rules below are what keep it
that way. They apply to every change, including the maintainer's.

## Before you write code

- **Open an issue first** for anything beyond a typo or a one-line fix. An issue is a
  claim, so it carries what someone else needs to check it: the version
  (`kiso --version`), the OS and the terminal, what you ran and what happened in that
  order, and the smallest reproduction you have. A screenshot of the terminal or the
  durable session log (`~/.kiso/sessions/<id>.jsonl`) is worth more than a description —
  read the log before you paste it, it holds your prompts and the files the model read.
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

## Branches and merges

**main is truth, branches are work, PRs are decisions, issues are claims.**

`main` is protected: the `check` workflow must be green, the branch must be up to
date, and it applies to administrators too. There is no direct push — a hotfix that
must bypass it is the owner lifting the protection themselves, on purpose, and
putting it back.

- work on `<round>/<topic>` or `fix/<finding>`, in your own worktree
- open a pull request whose body carries the finding list and the evidence
- a pull request is merged with a **merge commit**, never squashed: the commit
  bodies are the project's record, and squashing throws them away
- merged branches delete themselves

A release is the same shape. The lockstep version bump is the last commit on the
round's branch; its pull request's green `check` **is** the "green on the bump
commit" rule; the tag is cut from the merge commit on `main`, and the publish runs
from a detached worktree at the tag.

## Changing an expectation

Gates pin behaviour. When a change makes an existing expectation wrong, say so in
the file: what it pinned, why that is no longer right, and what the case still
asserts. A quietly restrung expected string erases the question. The convention
here is a `DECLARED SUPERSESSION` comment at the assertion.

A green pin can hold a wrong behaviour for a long time — it is only when something
else makes it a question that anyone looks.

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

Two traps worth knowing before you spend an afternoon on a red:

- **The test runner does not typecheck.** A call to a method that does not exist
  can sit under a green test file; `npm run typecheck` is what names it.
- **A fixture's labels should be at least as long as the ones in a real config.**
  A short fixture tests a world with more room in it than the one the product ships
  into — a status row that fits in the suite can be cut on a real screen.

## Pull requests

- One concern per pull request. A refactor states its zero-behaviour proof.
- Describe the red-to-green evidence in the description (`red: … / green: …`).
- The maintainer reviews every change structurally (dead machinery, misleading comments,
  duplication, layering, method size) and behaviourally (the gates). Expect questions.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence that
covers the project.
