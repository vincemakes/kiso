# ADR-0050: The identity-confirmed link lock — a pure Node single-writer lock

- **Status:** Accepted — adjudicated by the review, 2026-08-11
- **Date:** 2026-08-11
- **Layer:** packages/runtime (session store)
- **Supersedes:** ADR-0036 (the single-writer lock is a kernel flock held by
  a helper process)

## Context

ADR-0036 chose the kernel flock held by a python3 helper process as the
single-writer lock: the runtime's one non-Node dependency. Every round since
has paid its costs:

1. **The helper is a process to spawn, babysit, and kill.** A kill could
   orphan it (the round-5 P1 family) or wedge the session; the lifecycle
   barrier grew around it.
2. **A python3 on the host is a deployment requirement.** The absence
   handling (P2-1: an honest "locking unavailable" error) admits the
   possibility of a host without python3 — the lock should not depend on
   what the runtime is not.
3. **The append latency paced the CLI's frame boundaries.** Each flock-era
   append cost ~100–300 ms (the helper's spawn + handshake + flock), which
   separated the compositor's sync-wrapped commits. The latency was a
   timing property of the mechanism, not a design choice of the TUI.

The R-G 0.1.47 directive: retire the helper. The lock must be node-native,
possession decided by atomic filesystem operations, the file itself
carrying the holder's identity. The candidates were argued and adjudicated
(2026-08-11): candidate A — the identity-confirmed link lock — was
approved, with the residual family pinned by a gate, not by argument.

## Decision

1. **Possession of `<id>.lock` is decided by atomic filesystem
   operations; the file IS the lock.** There is no advisory-lock primitive
   in Node's stdlib, so the mechanism is: the final path exists ONLY by
   `linkSync` of a temp identity file that is fully written AND fsynced
   first (atomic create-if-absent). A kill can never leave an empty or
   half-written file at the final path. `linkSync` requires a
   link-capable filesystem; EPERM/ENOTSUP is an honest
   `LockUnavailableError` carrying the errno — never a silent degradation
   to a weaker scheme (that would re-open the empty-file window).

2. **Dead-holder takeover is identity confirmation, never a blind
   delete.** When the read finds an absent or dead identity (a fresh path,
   a dead holder, stale residue): rename the path away (atomic — exactly
   one contender wins), re-read what was moved, and if it differs from
   what was judged (a rival's LIVE file got moved), abort the takeover and
   restore-or-keep. A live foreign identity refuses immediately with
   `LockedError`; a live identity naming OUR OWN process is a same-process
   writer's residue and is retried (20 ms, capped) until its release or
   the cap.

3. **Release leaves the EMPTY released marker; the path is never
   deleted.** Release renames the holder's file away, confirms it is
   theirs, and opens the final path with "wx" — the empty marker a
   contender can read. A moved rival's file is restored-or-kept, never
   clobbered. No recursion, no deletion, no window between writers.

4. **Possession is re-checked at EVERY append: the file must still name
   this handle's pid AND token.** A failure is a STRICT refusal — no
   retry, no wait heuristic. The guard must be reason-able: a displaced
   holder fails honestly and the session resumes from a fresh store —
   never two writers.

5. **The fsync-before-link order is LOAD-BEARING.** The temp file's data
   is durable before the name exists, so a power loss can never produce
   an empty or half-written final path. The final path itself needs no
   directory fsync: if the name is lost in a crash, the holder died with
   it, and the residue is acquirable (see §residual).

6. **The identity file format is the cross-version channel (unchanged
   from round 4).** Modern `{"pid", "token"}`, legacy bare pid, empty
   (the released marker / a legacy writer's create window), half-written
   (crash residue). A legacy-format writer sees a live modern identity
   and refuses to take over; we refuse a live foreign legacy pid. Empty
   and half-written files are taken over as residue — under the
   documented QUARANTINE upgrade contract (round 5 P1-4), no live legacy
   holder exists to be split (see §migration).

7. **The mechanism is an injection point.** `new SessionStore(root, {
   lockAdapter })` — the `LockAdapter` interface is the extension point;
   the default adapter is `nativeLockAdapter`. `close()` releases only
   THIS instance's handle; `closeAll()` every held handle — a foreign
   close can never release another writer's lock.

8. **The residual family is pinned by a gate, not by argument.** The
   race suite (`native-lock-race.test.ts`, red→green in this round)
   choreographs: kill-mid-acquire (a real SIGKILL mid-hold leaves a
   cleanly takeover-able dead lock; a stray tmp is inert), stale residue
   (identity-confirmed takeover, the path always carries a token),
   PID reuse (a stale file naming a LIVE recycled pid is refused —
   refuse-happy, never two writers; the session recovers when the pid
   dies), and the displacement cascade (a false-dead reader, a live
   holder, and a third contender: exactly one writer at every instant,
   the displaced holder's next append self-refuses honestly, a fresh
   store re-acquires so the session continues).

9. **The test affordances are env-gated and default off.**
   KISO_LOCK_TEST_READY_DIR / KISO_LOCK_TEST_PAUSE_READ_MS /
   KISO_LOCK_TEST_PAUSE_TAKEOVER_MS let the race gates freeze a contender
   between the read and the rename-away, and between the rename-away and
   the verify, via fixed pauses plus SIGSTOP/SIGCONT, located by
   ready-marker files.

## Residual

The adjudication's one hard case — a false-dead reader — is decided here
so the mechanism stays reason-able. The lock is identity, not a kernel
lease: a contender that read a stale dead identity CAN move a live
holder's file away (the read and the act are not atomic against a third
party). The takeovers are still safe:

- a dead file (or a moved-away path) is taken over by a fresh
  identity-confirmed link — the session never waits on a dead writer;
- a live foreign identity is NEVER taken over — the session stays locked
  until that writer dies (refuse-happy, never two writers);
- the displaced holder's next append fails the possession check and
  SELF-REFUSES honestly — never a lockless write, never a second writer;
  the session resumes from a fresh store.

The cascade choreography above is the gate that pins this — the residual
is GATED, not argued.

## Migration

The upgrade contract is quarantine (round 5 P1-4, unchanged): stop every
old-format process FIRST, then start the new version. The identity format
is unchanged (cross-version), so a live legacy-format holder refuses a
modern takeover and a live modern holder refuses a legacy one — but
empty/half-written legacy residue is taken over as residue, which is only
safe under quarantine (no live legacy holder exists to be split).

## Crash durability

- killed mid-acquire, before the link: a stray tmp, inert — the next
  acquirer proceeds;
- killed after the link: a full dead identity at the final path —
  takeable over by identity confirmation, never empty;
- power loss between the temp's fsync and the link: the temp survives
  (the data durable), the final path absent — residue, acquirable;
- power loss after the link: the final path is a complete identity (the
  fsync-before-link order) — dead-holder takeover.

## Behavioral consequence — the TUI frame merge

The flock-era append latency paced the CLI's compositor commit boundaries
(the old flow emitted separate sync-wrapped frames between paints). The
~1 ms link-lock append merged the idle screen and the run's settle into
ONE sync frame — the compositor's paints coalesce. The W5/W20 e2e gates
were re-baselined to the merged flow (the 4th re-baseline of this round,
flagged in the report with evidence): the banner now stays fully visible
(the old flow's transient viewport overflow scrolled it up 4 rows), and
the driver's pre/post split now lands at the merged commit's end. The TUI
itself is unchanged — this is the compositor's commit cadence becoming
honest about its own speed.

## Amendment 1 (2026-08-12): the state-aware liveness probe

**The finding (R-I-1, measured).** A killed CLI can linger in the process
table instead of vanishing: the group SIGKILL does reach the CLI (its
pgid equals the npx wrapper's), but the exit can block on a pty syscall
while the dead session's terminal stays open — STAT `?E` ("process is
attempting to exit") for 60-300+ s, clearing only when the terminal
closes. A second, separately-confirmed shape is the un-reaped zombie
(STAT Z). POSIX reports BOTH alive to `kill(pid, 0)` (they exist until
reaped), so the takeover judged the dead holder "live foreign" and
refused the immediate resume with "locked by another writer" — the
flagship flow's first-touch wart.

**The mechanism.** `isAlive` probes the process STATE after
`kill(pid, 0)` reports existence: the exiting state (E) and the zombie
state (Z) are judged DEAD — both can never execute another session
write, so taking over is safe. The probe is `ps -o state= -p <pid>`
(macOS/Linux); the state is the first character of the state string
(multi-char strings like "Ss+" are combined flag sets).

**The boundaries (the adjudicator's phrasing, signed by the review,
2026-08-12).**
- E/Z states → dead → the takeover proceeds.
- Probe failure (the process vanished between the kill and the probe,
  or ps itself fails) → the pre-amendment behavior: judged alive, the
  takeover refuses — FAIL-SAFE, a false refusal is preferred over a
  double-write.
- Live-process semantics zero change: a live foreign writer is still
  refused (a fresh `kill(pid, 0)` EPERM still reads alive).
- The PID-reuse rules zero change: a live non-kiso process naming the
  lock is still refused.
- The identity format, the rename-away → verify → link sequence, the
  fsync-before-link order, and the released-marker convention are
  untouched — the amendment is confined to the liveness predicate.

**The gates.** The controlled zombie repro (a session lock naming a
guaranteed STAT Z holder) and the npx-shape gate (a wrapper-produced
un-reaped dead holder; a fresh boot must take over at the first session
write) — both red pre-patch, green post-patch. The kill9 gate's blind
spot is closed: its direct child is reaped by waitpid and can never
linger or zombie.
