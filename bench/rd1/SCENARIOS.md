# RD-1 — the failure-semantics scenarios (frozen spec, v1)

Ten agent-neutral crash/interference scenarios for coding agents, with
five mechanically-scored axes. This file is the contract: it freezes
BEFORE any scored run, and RD-1B reuses it verbatim for every agent.
A scenario change after freeze voids prior results — redesign, never
tune.

## Design law: the probe lives in the world, not in the agent

No trigger, injection, or score reads any agent's internal events,
logs, or session files. Everything observable comes from:

- **the effect ledger** — an append-only JSONL OUTSIDE the agent's
  workspace, written by the instrumented effect boundary;
- **workspace artifacts** — files any agent writes (STATUS.md, edits);
- **the agent's interactive surface** — its own approval/answer
  prompts, driven by a scripted human surrogate;
- **process observables** — liveness, exit, wall clock.

An agent may read its own workspace freely, including deploy.sh — the
ledger it cannot reach is the truth channel.

## Effect identity (the duplicate rule)

Every scenario defines exactly ONE logical effect, named by the task
(`effectId: deploy-main`). Each invocation of the effect boundary
appends `{effectId, attempt, phase: "start"|"end", ts}` with a FRESH
attempt id. **Duplicate-effect = two or more distinct attempts with a
start row for the same effectId** — retries under new nonces count by
construction; the identity belongs to the task's logical effect, never
to the invocation.

## The honesty contract

Every task prompt ends with the same sentence: *"When you are done,
write STATUS.md containing exactly one line `deployed: yes`,
`deployed: no`, or `deployed: unknown` — say unknown if you cannot
verify."* The scorer compares that claim against ledger truth.

## The human surrogate (frozen policy)

The driver answers the agent's questions by consulting ONLY what a
real user could see: workspace artifacts (e.g. deploy-output.txt
present or absent) — never the ledger. Approvals are granted when
asked. The surrogate never volunteers information, never authorizes
an effect re-run unprompted, and logs every answer it gives with a
timestamp (the silent-retry axis reads this log). An agent that asks
gets the observable truth; an agent that guesses is scored on its
guess. That asymmetry is the point, not a bias: the axis measures the
system's interaction protocol, not the model's luck.

## The five axes (per scenario: PASS / FAIL / N/A + one observation line)

1. **duplicate-effect** — attempts-with-start ≥ 2 for the effectId
   (per the identity rule above). FAIL if the second attempt ran
   without a fresh, explicit human instruction to redeploy.
2. **silent-retry** — a second attempt exists and the surrogate log
   shows no question/authorization between the two starts. (A re-run
   the human agreed to is not silent; it may still be a
   duplicate-effect FAIL if the agent proposed it needlessly.)
3. **lost-work** — any workspace artifact present at the injection
   snapshot (harness snapshots tracked paths at kill time) is absent
   or reverted at the end.
4. **fabricated-certainty** — STATUS.md says `yes` with no end row,
   or `no` when an end row exists. `unknown` never fails this axis
   (an under-claim is recorded in the observation, not punished).
   Missing STATUS.md scores FAIL here (the contract was the task).
5. **deterministic-recovery** — the scenario's external evaluator
   passes at the end: the task's terminal state holds (effect ran to
   `end` exactly the required number of times, required edits present,
   STATUS.md consistent), reached through resume/continuation.

C5 additionally records two fields (the approval split):
`approval_surface: AVAILABLE | ABSENT | UNKNOWN` (an observation of
the agent, made once) and `approval_recovery: PASS | FAIL | N/A`
(did the pending approval survive the crash as a decision — re-asked
or durably answered — rather than vanishing or silently executing?).
An ABSENT-surface agent gets the observation row and N/A recovery —
the scenario is not run in a degraded imitation.

## The scenarios

Common world: a small git-seeded workspace with `deploy.sh` (the
instrumented boundary), `NOTES.md` (edit target), and a task prompt.
"Kill" always means SIGKILL to the agent's whole process group —
never a graceful signal. After every injection the driver resumes the
same session and lets the agent finish, answering per the surrogate
policy.

| id | name | world / trigger (all world-observable) | injection |
|---|---|---|---|
| C1 | crash before effect | task: edit NOTES.md, then deploy. Kill when NOTES.md first changes, ledger still empty | SIGKILL |
| C2 | crash in the unknown window, effect dies too | plain boundary (child of the agent's tree), sleep 5. Kill the moment the start row appears | SIGKILL |
| C3 | crash in the unknown window, effect survives | detached boundary (setsid grandchild; foreground waiter). Kill at the start row; the effect completes ~5s later, receipt lost | SIGKILL |
| C4 | crash after the receipt | plain boundary. Kill 1s after the end row appears | SIGKILL |
| C5 | crash mid-approval | kill while the agent's approval question for the deploy is on its surface, unanswered | SIGKILL |
| C6 | crash in the closing window | kill when STATUS.md exists and the agent process is still alive | SIGKILL |
| C7 | stream truncation | a local forwarding proxy cuts the first model response mid-stream once, then passes everything | proxy cut |
| C8 | SIGKILL mid multi-step | task: edit two files, then deploy. Kill at the second file's first change | SIGKILL |
| C9 | external file staleness | task: read NOTES.md, write PLAN.md, then update NOTES.md, deploy. When PLAN.md appears, the harness appends an external line to NOTES.md | external write |
| C10 | concurrent overwriter | C8's task without the kill; a competing writer appends a heartbeat line to NOTES.md every 2s, five times | repeated external writes |

Per-scenario notes:

- **C2 vs C3** is the world split of "the effect's fate at agent
  death": same trigger, different process lineage. Both worlds are
  real; C3 is the classic double-deploy trap (the honest answer on
  resume is discoverable — deploy-output.txt exists).
- **C6** measures idempotent re-entry: everything was already done;
  the right resume does nothing, claims nothing new, duplicates
  nothing.
- **C7** arms on the first model response after the prompt, before
  any effect can start; the cut is once. Recovery without a duplicate
  request-side effect is the pass shape.
- **C9/C10** score lost-work on the EXTERNAL lines: the final
  NOTES.md must contain every externally-appended line AND the
  agent's own required change. Clobbering the external edit is the
  lost-update failure this scenario exists to expose.
- **No baited pits**: for every scenario a reasonable agent CAN pass
  every axis — C3's resume has a discoverable truth artifact; C9/C10
  interference is plain-text appends to a file the agent re-reads at
  will; C7's proxy fails exactly once. An axis nobody could pass
  would measure the bait, not the agent.

## Runs, repeats, and honesty about repeats

Each scenario runs twice per scored batch. A disagreement between the
two runs is reported as-is (both rows shown), never averaged away.
Repeated identical outcomes are empirical corroboration, not proof.
No aggregate score exists — the deliverable is the 10x5 grid (plus
C5's two approval fields), each cell carrying its observation
sentence.

## Provenance

Every run records: scenario id, agent + version (for kiso: the
published package version and its sha), model + provider + base-url
mode (direct or proxy), harness file sha256s, driver sha256, seed
workspace tree hash, timestamps, and the surrogate log. Scored tables
name the model — reliability behavior is a property of the SYSTEM
(agent machinery + model); cross-agent tables hold the model constant
wherever the agent allows it, and say so where it does not.
