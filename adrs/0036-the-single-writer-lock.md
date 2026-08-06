# ADR-0036: The single-writer lock is a kernel flock held by a helper process

- **Status:** Accepted
- **Date:** 2026-08-03
- **Layer:** Runtime (storage)

## Context

ADR-0025 made the session store crash-safe — but not multi-writer-safe.
Two processes appending to one session would interleave JSONL lines and
corrupt the trajectory; a pidfile scheme could be removed or overwritten
by a contender (nothing stops a process from deleting another's pidfile).
The lock had to arbitrate EVERY race without leaving a removable artifact,
and it had to survive the writer's death (no stale-lock cleanup race).

## Decision (the fourth round)

**The single-writer lock is an EXCLUSIVE KERNEL flock on `<id>.lock`, held
by a dedicated helper process**:

- the kernel arbitrates every race — a contender can never remove or
  overwrite a live holder's lock, because there is nothing to remove; the
  lock simply exists while the helper lives and vanishes with it;
- the lock file ALSO carries `{"pid", "token"}` written by the holder, as
  a best-effort guard for OLD-format writers (whose `O_EXCL` pidfile
  scheme does not honor flock) — the guard's limits are the subject of
  ADR-0035's quarantine contract;
- `close()` releases only THIS instance's helper; `closeAll()` every held
  helper — a foreign close can never release another writer's kernel
  lock (flock is tied to the helper's open file description).

## Consequences

- The kernel lock is the mechanism; the pidfile is a compat hint. There
  is no lock-cleanup race, no TOCTOU on a lock artifact, and no way for
  one writer to silently release another's lock.
- Known cost: one helper process per open session — a small process
  overhead, accepted for the arbitration guarantee. The helper is
  internal (spawned by the store), invisible to the session API.
- Known cost: the lock does not interoperate with the legacy pidfile
  scheme — hence ADR-0035's quarantine upgrade contract.

## When to revisit

A live multi-writer store (append-only JSONL with writer coordination)
would replace the exclusive lock; nothing in the current product needs it.

## Evidence

- Commit `1263689` (fix(runtime): kernel-flock single-writer lock;
  session identity safety — the fourth round).
- Tests: `packages/runtime/tests/storage.test.ts` and
  `packages/runtime/tests/storage-identity.test.ts` — the lock-ownership
  races (`two contenders racing a stale lock: exactly one wins, the loser
  errors`), the fast-path dead-helper detection, the poison-on-rejected-
  write permanence.
