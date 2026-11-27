# ADR-0064: kiso-actor — durable work over disposable sessions

> Work is not Session. Work is not Memory. Work survives sessions. A session is
> execution context for a work. The work log is authoritative for work.

- **Status:** Accepted (the owner, 2026-11-27). Drafted 2026-11-27 and merged as
  Proposed by #540; stage A1 built it in #542 (`packages/actor`, private until C0,
  and the runtime's `./evidence` subpath), shipped on main after 0.56.2. No core
  change. Later stages (A2 onward) are recorded as amendments or in their own
  records.
- **Baseline:** `origin/main` ce844ad3 (0.56.1).
- **Lineage:** kiso-doc `rfc-kiso-actor-runtime-2026-11-23.md` (rev 5, sealed by the
  owner 2026-11-23) and the A1 stage spec `spec-actor-a1-2026-11-27.md` (rev 1.2).
  This ADR records the decisions; it does not restate the RFC's argument.
- **Layer:** a new package `@vincemakes/kiso-actor` (`packages/actor`), and one
  neutral provenance module in the runtime (§ 6). **No core change.**
- **Companions:** ADR-0002 (the event log is the single truth), ADR-0038
  (uncertainty belongs to the crash window), ADR-0050 (the identity-confirmed
  lock), ADR-0058 § 6 (durable before the effect), ADR-0062 (sessions), ADR-0063
  (Recoverable Context: the record envelope and the provenance check).

## 1. Context

kiso runs long sessions and recovers them. A persistent agent needs more: a
commitment that outlives any one session, waits on the world, resumes in a new
session and finishes only with evidence. Folding that into the session log would
make a session the unit of work; folding it into memory would make commitments
something a model can rewrite. Neither is acceptable. The RFC puts work above
sessions in a library of its own; the first consumer is the personal-agent
consumer, a separate product.

## 2. Decision

1. **A new package, `@vincemakes/kiso-actor`.** It depends on the runtime; nothing
   in kiso depends on it. It stays `"private": true` (not published) until the C0
   consumer smoke integration needs it from outside. Private is not sloppy: it is
   imported only through its public index (§ 7).
2. **Work state is a reducer over an append-only work log**, never a stored blob.
3. **Storage is a contract**: an append-only log, single writer, sequence CAS,
   strict load. kiso ships a file backend with the session store's discipline and
   a conformance suite that any other backend must pass. The host chooses the root;
   tenancy belongs to the host.
4. **Acceptance carries authority** (`user | system | agent`); a `user` criterion
   needs a quote that passes the ADR-0063 provenance check.
5. **Completion is bound to evidence**: every required criterion evidenced, no
   effect open or uncertain.
6. **Effects are owned by a work** and share the runtime's execution identity.

## 3. Frozen contracts

```ts
type EvidenceOwner = `session/${string}` | `work/${string}`;
type EvidenceRef   = { owner: EvidenceOwner; seq: number };
```

- **EvidenceOwner / EvidenceRef** is the serialization contract for "this event in
  that log". It is the foreign key that quotes, memory records (ADR-0063 § 5's
  `evidence`), recall and the context compiler will use. It is not a core type.
  New owners (`project/…`, `actor/…`) extend the union by amendment to this ADR.
- **WorkRevision** := the authoritative work log's last committed seq. Nothing
  else is a work revision.
- **Effect identity is bound at `effect_prepared`** to `{ effectId, workId,
  workRevision (observed), actionDigest, approvalId? }`, so an effect can always
  prove what it was decided on. States: `prepared → dispatching → succeeded |
  failed`; a dispatch with no outcome reads `uncertain` (ADR-0038); `uncertain` is
  resolved only by a human (`rerun` | `abandoned`) or a receipt; never retried
  silently. An effect run inside a tool call records the call's `{ sessionId,
  executionId }` and is reconciled from the runtime's execution ledger.
- **The work log format is strict and versioned.** An unknown event, a missing field
  or an unknown `format` is corruption, not something to skip. Later stages add
  events and fields by bumping `format`, each named in its stage spec. No open
  maps "for later".

## 4. Authority of acceptance

| source \ target | user | system | agent |
|---|---|---|---|
| user | yes | yes | yes |
| system | no | yes | yes |
| agent | no | no | yes |

An invalid supersession is ignored and reported; the source criterion still
commits at its own authority. A `user` criterion whose quote fails the check is
refused, never downgraded silently; the caller may add it as `agent` explicitly.
Completion is reported per authority.

## 5. What A1 does not decide

- **Stale-basis dispatch.** A1 records the revision an effect was prepared at.
  Refusing a dispatch whose basis went stale since then (prepared at revision 17 to
  "send", cancelled at 18) is the effect gateway's (stage A4).
- Session leases, the bootstrap snapshot and the context compiler (A2); wake
  subscriptions and dependencies (A3a); work-owned memory records (after ADR-0063
  M2); actor identity, policy and grants; capability broker and sandbox (S1).

## 6. The provenance module

`packages/runtime/src/provenance.ts`, reached through the runtime subpath
`@vincemakes/kiso-runtime/evidence` (one export, its own surface snapshot, documented
as "for kiso-actor; not stable"). `locateQuote(events, { owner, seq, span })` is a
pure validator: ADR-0063 § 5.2 steps 2–4, returning the exact located source bytes
or nothing. It is neutral: neither memory nor work owns it, and both import it.

## 7. Gates

- No request, tool-table, prompt or log byte changes: kiso-actor is unreachable
  from any run (a reach gate), and the wire fixture and rent ratchet are unchanged.
- No deep imports: nothing imports `@vincemakes/kiso-actor/…` or reaches into
  `packages/actor/src` from outside; the package exports `"."` only.
- Core stays at its size; any later core line needs the owner's decision on the
  exact diff.

## 8. Prior rulings this touches

| Ruling | Relation |
|---|---|
| Actor RFC rev 5 § 15: A1 depends on "record envelope / ownership stable" | **changed by the owner (2026-11-27)**: A1 depends on R0 only; work-owned records come after ADR-0063 M2 |
| ADR-0063 § 7: a commitment is not a memory kind | kept: work state has its own events |
| ADR-0063 § 5 `evidence: Array<{ owner: string; seq }>` | narrowed: `owner` is an `EvidenceOwner` (§ 3) |
| ADR-0038 | kept for effects |
| ADR-0002 | the work log is the single truth for work |

## 9. When to overturn it

If a second backend cannot meet the contract in § 2.3 without changing the reducer,
or if the C0 consumer needs to reach past the public index, the contract is wrong
and this record is reopened.
