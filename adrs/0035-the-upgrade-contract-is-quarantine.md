# ADR-0035: The upgrade contract is quarantine, not seamless rolling

- **Status:** Accepted
- **Date:** 2026-08-03
- **Layer:** Runtime (storage)

## Context

The single-writer lock (ADR-0036) is an exclusive kernel flock held by a
helper process — a mechanism OLD-format writers do not honor: the previous
scheme used an `O_EXCL` pidfile, and a legacy writer that created an empty
lock file before writing its pid creates a split-brain window that a
pidfile read cannot close. The flock ignores content; the lock FILE also
carries `{"pid", "token"}` as a best-effort guard for legacy writers, but
the guard is best-effort — it cannot make the two protocols interoperate.
The question was what upgrade story to DOCUMENT and promise.

## Decision (第五轮 P1-4)

**The upgrade contract is QUARANTINE, not seamless rolling**: stop every
old-format process, THEN start the new version. This is written into the
storage's own contract comments, the README's storage section, and this
ADR — a promise the framework CAN keep, instead of a rolling-upgrade
claim it cannot. A dead/empty/unreadable legacy lock file is harmless
(flock ignores content; the kernel lock is what matters); the hazard is
only a LIVE legacy writer racing a new one.

## Consequences

- The runtime never claims cross-version process coexistence. Operators
  have one rule: drain old processes before starting new ones.
- Known cost: no zero-downtime upgrade path for the session store. This
  is accepted — the store's guarantees (ADR-0025) are about crash
  recovery, not live migration, and a wrong rolling promise would corrupt
  sessions in the one window it matters.
- The quarantine rule also protects the test gates: the check pipeline
  never mixes store formats within a run.

## When to revisit

A versioned on-disk format with a real migration path (torn-tail aware
readers, format negotiation) would justify upgrading the contract — the
format is currently append-only JSONL with no version header, so there is
nothing to negotiate.

## Evidence

- Commit `f795ad4` (docs(runtime): the upgrade contract is quarantine,
  not seamless rolling) — the contract lives in `README.md` and
  `packages/runtime/src/store.ts`'s contract comment; the 第五轮 P1-4
  record is in `docs/plans/2026-08-03-reliable-session-alpha.md`.
