# TODO — standing deferred work

Registered across rounds; linked from the README. Rounds add here, and
resolved items move to the round record that delivered them.

## 1.0 prerequisites

- **Lock Adapter + native Node lock** — the runtime's session store spins
  a `python3` helper to hold its cross-process kernel flock (single-writer
  guarantee). The dependency is odd for a Node framework and breaks
  lock-less environments (slim containers, Windows, single-file CLI
  packaging). The store-level Lock Adapter injection (a native lock
  implementation can then replace the helper) is a 1.0 prerequisite.
  Adopted from the external review's risk #4
  (`docs/reviews/2026-08-06-external.md`); the lock refactor BODY is out
  of scope for the round that registered it (TUI v5).

## 1.0 round

- **Event union surface review** — the durable event schema is the
  framework's long-term maintenance surface: every historical event must
  keep replaying correctly forever. A full review of the union's
  forward-compat (field addition/removal, versioning, projection rules,
  extension-writeability) is a 1.0 round item. Adopted from the external
  review's risk #5.

## Standing (per-round)

- todo 扩展 (the interactive todo surface) — deferred each round per the
  spec; still deferred after TUI v5.
- 三终端真机验收 — the v4/v5 checklist tables in the round records; the
  human-terminal drag/screenshot items await the user's real terminals.
