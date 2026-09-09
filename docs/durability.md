# Durable execution — the runtime, the contract, and its proof

The one-screen version of this page is in the [README](../README.md#durable-execution-in-one-screen).
This is the whole of it: why the runtime is built the way it is, the frozen
contract that pins it, and the `kill -9` test that proves it end to end.

## Why durable — the durable runtime

> **Agents crash. Side effects don't rewind. Kiso makes execution durable.**

A coding agent is a process driving side effects — file edits, shell
commands, remote calls — through a model that makes mistakes. Treating
the agent as if it survives is what turns a demo into a tool; treating a
crash as if it rewinds everything is what turns a resume into a guess.
Kiso's whole design is the third option: the trajectory itself is the
durable artifact, so a killed process costs you nothing but the process.

- **Event-sourced sessions.** Every run is an append-only JSONL stream of
  `seq`-numbered events under `$KISO_HOME/sessions`. The messages a model
  sees are a pure function of the log (ADR-0002) — a session is a file you
  can read, replay, and audit, not runtime state that dies with the
  process. `kiso resume <id>` continues the interrupted trajectory in a
  fresh process, contiguously.
- **Durable human approvals.** A verdict — allow, deny, rerun, abandon —
  is a persisted fact, recorded with what decided it (ADR-0024). Kill the
  process and the already-decided calls are never re-asked: the resume
  applies the durable verdicts, and a policy's `decide` is never re-run
  for a call it already decided.
- **Crash-consistent execution.** Tool calls carry durable receipts keyed
  by `executionId` (ADR-0025). A confirmed success is never re-run; an
  execution that started and never reported is `uncertain` and blocks
  until a human decides — the only honest answer to "did the side effect
  apply?" The original run then completes; it does not replay.

The consequence: the session, the verdicts, and the side effects' truth
are already on disk before the crash — the next `kiso resume` asks only
what the crash window made unknowable. The `kill -9` section below shows the
scripted proof.

## The durable execution contract

**The session format is a frozen contract, enforced by gates** — not a
versioned API that can drift. The freeze (ADR-0051, adjudicated by the
review, 2026-08-12) classifies every recorded event shape and pins the
invariants below to executable gates that run in `npm run check`. The
canon names live in ADR-0047 §7 / ADR-0051 §7; the public names below
are what this README uses.

| public name | what it guarantees |
| --- | --- |
| **Prefix-Complete Recovery** | the session can always be resumed from its durable prefix — every prefix a real published bin wrote loads, validates, projects, and derives a recovery plan (the generation gate, ≥4 real generations) |
| **Ambiguity Never Auto-Repeats** | an execution that started and never reported stays the human's decision — never auto-rerun, never silently re-asked |
| **Turn Commit** | a model turn counts only once its stream has cleanly exhausted with exactly one compatible stop — receiving a stop is not commit, a handler that can change your world never starts before that boundary, and a harmless call that ran ahead of it never makes an invalid turn valid (ADR-0052) |
| **Committed Intent Before Effect** | a tool call is decided and persisted before any effect; an approval is a durable fact, never a memory |
| **Durable Start Before Side Effect** | a handler never runs before its STARTED receipt is persisted — a crash cannot leave an unreported effect |
| **Stable Intent Identity** | the three identities (callId / invocationSeq / executionId) are never conflated; derived state is never persisted |
| **Single Durable Truth** | the event stream is the single truth; everything else is derived from it, and every event is kernel-owned |
| same-facts-same-projection | the same prefix projects to the same bytes on any given version (the prompt-cache byte discipline); the model-request surface evolves only by declared supersession (ADR-0051 Amendment 3) |
| exactly-one-terminal | every run converges on exactly one terminal — its last event |

The contract's ask semantics: **a pending ask lives iff its invocation
is not voided and the derivation can still execute it** — approval
verdicts are durable, whether decided directly by the human or by a
policy the human installed (ADR-0051 §8).

Turn Commit's own proof is a byte comparison of two crash prefixes that
differ by exactly one durable stop: the one without it never executes on
resume, the one with it executes exactly once.

## The `kill -9` test

This is the product's scripted proof, automated end to end in
`apps/cli/tests/kill9.test.ts` (real PTY, real processes, real SIGKILL —
no mocks, no signal simulation). It is exactly what a `kill -9` user
experiences:

```
$ kiso chat k9                        # faux trajectory: edit f1.txt → slow
                                      # shell (sleep 30 && touch marker.txt)
                                      # → edit f3.txt; approve both tools
...                                   # the shell is mid-execution...
$ kill -9 -PGID                       # the agent's whole process group —
                                      # and the shell's own detached group
$ kiso resume k9
interrupted execution: shell (ex-12) — rerun it? (y)es / (n)o y
  rerun
→ edit_file({"path":"f3.txt",...})    # the ORIGINAL trajectory continues
```

What the test asserts on disk and on the filesystem after phase 1 (the kill):

- the event stream loads without corruption;
- **exactly one** execution is `uncertain` — the shell started, never reported;
- `marker.txt` does not exist; `f1.txt` was edited before the kill; no
  terminal was written.

And after phase 2 (the resume, in a fresh process, zero human typing):

- the uncertain verdict question is presented, `rerun` is injected;
- the third edit happens — the trajectory continues, it does not replay;
- the terminal lands and is durable; `marker.txt` still does not exist;
- exactly one `tool_execution_resolved` is on disk.

The same story as a scripted demo: `scripts/demo-kill9.sh` runs it against
the published binary — two consecutive runs, a fresh `KISO_HOME` each, all
green.
