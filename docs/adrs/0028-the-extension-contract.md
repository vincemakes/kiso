# ADR-0028: The extension contract — narrow surfaces, monotone by construction

- **Status:** Accepted; the ASK ROUTING (surface 1's "ask = the existing
  policy chain decides") is SUPERSEDED by ADR-0029 (an ask is answered by
  a human — no automated policy speaks for the human), 2026-08-04. The
  surface-7 PRECEDENCE ORDER as written below (deny > ask > allow) is
  ALSO SUPERSEDED: the implemented and ruled order is **deny > allow >
  ask** (the W21/R3 ruling — a later allow silences an earlier ask,
  which is the dont-ask-again power; a deny still beats everything).
  See the supersession note at the end of this file and compose.ts.
  The body below is historical and stays as written. Every other
  surface stands.
- **Date:** 2026-08-04
- **Layer:** Cross-cutting (core / runtime / cli / official extensions)

## Context

ADR-0021 grew the framework in packages. The extensions stage (E1/E2)
needed a loadable, user-installable surface ON TOP of that: plain `.mjs`
files with no SDK, no build step, no framework imports. The design
constraint was monotonicity: **adding an extension must never remove
existing guidance or make the chain more permissive**. And the E1 loader
had to stay a zero-dependency import of files the user dropped into
`~/.kiso/extensions/`.

## Decision

An extension is a plain `.mjs` file whose default export is the extension
(or a factory returning it) — loaded by `loadExtensions` with loud startup
failure on a bad file or duplicate name. The contract has SEVEN surfaces,
each narrow:

1. **approvals** — the policy chain (`deny > ask > allow`) decided BEFORE
   the human flow; a throwing policy counts as ask; allow/deny are
   PERSISTED EVENTS with `decidedBy` = the extension's name (ADR-0029:
   an ask is answered by a human).
2. **tools** — merged into the registry; a built-in name collision is a
   loud startup error.
3. **hooks** — composed AFTER the harness's own (existing-first): observers all
   run in order; onUserMessage is a PIPE with veto short-circuit (a null
   anywhere ends the chain — a later rewrite can never swallow an earlier
   veto); onPreTool first-decisive-wins; onPostTool folds.
4. **systemPrompt.append** — append-only, never replace: the session's own
   prompt first, then each append in load order, `\n\n`-joined,
   deterministic; no appends → byte-identical to the extension-less run.
5. **compaction** — supplies the loop's microcompact parameters when the
   session sets none (ADR-0027's threshold/keepResults).
6. **dispose** — the loader calls it on exit; guarded per extension (one
   failure never blocks the rest), capped at 5s (finding #8, ADR-0030).
7. **The monotonicity family** — deny>ask>allow, the veto short-circuit,
   and append-only systemPrompt are ONE idea: an extension can only
   constrain, ask, or extend — never loosen, bypass, or replace.

The UI is NOT part of the contract: no registerCommand, no shortcuts, no
renderers, no sendMessage. Extensions never append to the log directly —
every effect flows through the kernel's own event paths.

## Consequences

- The loader stays trivial and dependency-free; the contract is pure types
  (`packages/core/src/protocol/extension.ts`).
- Monotonicity is enforceable by construction, not by convention — each
  surface has a test that pins the "adding an extension never loosens"
  property (the veto-short-circuit tests, the ask-routing tests, the
  byte-identical systemPrompt test).
- Known cost: the extension cannot do UI, cannot speak to the user, and
  cannot reach the log — the surfaces that would need kernel surgery are
  simply absent rather than half-supported.

## When to revisit

A product that genuinely needs an extension-drawn UI or an out-of-band
channel would force a new kernel surface — that is a kernel decision, and
this ADR records the current refusal.

## Evidence

- Commits: `3149137` (E1 policy chain), `f4ebb3f` (E1-P2 pipe + veto),
  `f23e415` (E2 systemPrompt append), `dd0e92d` (finding #8 dispose).
- Tests: `packages/core/tests/extensions.test.ts` (composition, durability,
  ask semantics), `packages/runtime/tests/extensions.test.ts` (loader,
  hooks order, P2 pipe), `packages/runtime/tests/extensions.test.ts`
  (E2 systemPrompt appends).

## Supersession note (2026-08-18, the SC-1 semantic contract audit)

Appended, never an edit. **This ADR's ask routing is SUPERSEDED by
ADR-0029** ("an ask is answered by a human", 2026-08-04). The index
(`docs/adrs/README.md`) recorded that supersession; this record did not —
against the discipline the index itself states, that a superseded record
carries the marker in its own Status line. This note is the append-only
form of that marker (a historic body is never rewritten).

Everything else here stands: the narrow extension surfaces, monotone
composition, the loader and the lifecycle contract. For the ask semantics
as SHIPPED, read ADR-0029 and its 2026-08-09 Amendment — the composed
chain is deny > allow > ask, a LATER allow beats an EARLIER ask, a
throwing policy counts as ask, and an all-abstain chain reaches the human
(ADR-0042). The implementation is `packages/runtime/src/compose.ts`.
