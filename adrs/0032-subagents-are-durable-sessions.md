# ADR-0032: Subagents are durable sessions

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** Official extension (subagents)

## Context

The subagent extension (④) delegates tasks to CHILD kiso processes. The
obvious implementation is a spawned process whose output is scraped — but
the framework's whole thesis (ADR-0002, ADR-0025) is that the EVENT LOG is
the truth. A subagent whose result lives in stdout is a subagent without a
past: it cannot be audited, resumed, or recovered. The stage decided the
child IS a session.

## Decision

1. **A subagent task is a durable session.** Each task spawns the SAME
   binary with a child session id `sub-<parent>-<n>-<role>` landing in
   the ordinary sessions directory — durable, auditable, and resumable
   with `kiso resume` even if the parent is killed (the selling point).
   The child's session id comes from `ToolContext.sessionId` (P3
   threading), with a discovery heuristic as fallback.
2. **Results are extracted from the child's OWN JSONL** — the terminal
   outcome, the final assistant text (a projection-equivalent parse), the
   tool-call count. stdout is NEVER a result source; it rides along only
   as a diagnostic when the child exits non-zero or the JSONL is missing.
3. **Role policies are generated per child** (a temporary extensions
   dir): explorer/reviewer may read only; implementer/tester get all six
   tools. Only allow/deny — NEVER ask (a headless child cannot answer an
   approval prompt; ask would deadlock).
4. **Depth guard**: `KISO_SUBAGENT_DEPTH ≥ 1` (set on every child) makes
   the factory return no tools — subagents can never nest.
5. **implementer isolation**: the child works in a detached `git worktree`
   (a non-git parent fails the task honestly); the child's `git diff`
   (with its `--stat` header, new files via intent-to-add) returns in the
   result; a worktree with changes is kept and its path returned, a clean
   one is deleted.
6. **Concurrency**: at most 4 children at once; a 10-minute per-child
   timeout (or the parent's abort) SIGKILLs the child's process group.
7. **Credentials ride along deliberately** — see ADR-0031's third
   boundary (a controlled spawn the human just approved in the ask tier).

## Consequences

- A parent crash leaves the child's trajectory on disk: the child session
  can be resumed and audited like any other. The framework's durability
  story extends to its own children for free — no new persistence
  mechanism.
- Known cost: extracting from JSONL means waiting for the child's terminal
  (with a short retry — the exit event can beat the final write by a
  beat); a child killed mid-flight reports "no terminal", which is an
  honest failure, not a fabricated one.
- Known cost: children inherit the parent's provider environment (by
  design, ADR-0031) — the role policies are the compensating control for
  what the child may do with it.

## When to revisit

A parent→child approval relay would need a new kernel channel (ADR-0028:
extensions cannot speak to the user) — currently refused; children run
under role policies that never ask.

## Evidence

- Commit `d64c6a6` (feat(subagent): ④).
- Tests: `extensions/subagent/tests/subagent.test.ts` (role policies,
  JSONL extraction, timeout + dead group, concurrency probe, worktree
  kept/deleted, non-git honest failure, P3 child ids);
  `extensions/subagent/tests/subagent-e2e.test.ts` (durable child
  session pinned: exists with a terminal).
