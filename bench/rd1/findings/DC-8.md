# DC-8 — a badge on the opening screen can stop kiso from starting

- **id:** DC-8
- **class:** startup / error propagation
- **severity:** P1 — kiso does not start at all, with no way in from the
  message it prints
- **agent:** kiso 0.16.3, reported from a real session
- **found by:** the owner, twice in a row, immediately after the 0.16.3
  install
- **status:** FIXED (0.16.4)

## What the owner saw

```
session 2026-08-27T07-41-54-3547
(blank screen)
session 2026-08-27T07-42-05-37a9
(blank screen)
the recorded execution profile no longer matches this process:
- the recorded binding is unscoped but the current process serves deepseek/deepseek-v4-flash
re-open with acceptDrift (the CLI's --accept-drift flag) to proceed …
```

Twice, on a plain start — not a resume.

## The path

`recentResumeMetas` builds the opening screen's resume list. To put a
durability badge on each row it OPENS the session:

```ts
// apps/cli/src/index.ts
const session = await agent.session({ id: m.id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
const card = projectSessionCard({ … });
badge = BADGE_GLYPH[card.badge];
```

`agent.session()` throws on material profile drift (`agent.ts`, the
`drift.kind === "material"` branch). So the **three most recent
sessions are opened on every start**, and if any one of them drifts, the
throw propagates out of startup.

The message names the fix for the session the user asked for. It cannot
name this one, because the user did not ask for that session — the
product opened it on their behalf to draw a glyph.

## Why every pre-0.16.0 session drifts

"the recorded binding is unscoped but the current process serves
deepseek/…". Sessions recorded before the provider scope existed have no
scope in their profile, so the comparison is material for all of them.
Anyone upgrading with history in `~/.kiso/sessions` meets this on the
first launch.

## The root cause, which is better than the symptom

The rule was already written, and already obeyed — in the other copy.
`apps/cli/src/session-cards.ts`, which badges the `/resume` picker, does
exactly the right thing:

```ts
try {
    const session = await agent.session({ id: meta.id });
    asks = session.pendingApprovals().length;
} catch {
    // blocked by the profile contract — the card carries no ask badge
}
```

with the reasoning above it: *"the LISTING never enforces the profile
contract … the honest refusal happens at the open, where the message can
be acted on."*

`recentSessions` did the same job for the opening screen and did not
have the guard. So this was never a missing rule — it was **one
projection implemented twice, with only one copy obeying it**. The
second copy existed because the opening list and the picker were built
in different rounds.

## The fix, as landed

The opening's resume list is retired by the owner's ruling of the same
day (`/resume` is where you go looking for a session; the opening says
what THIS one is), so `recentSessions` is deleted rather than guarded.
One projection, one implementation, in `session-cards.ts` — where the
rule is stated next to the code that keeps it.

Separately, and for the XP-1 lane to rule on: an *unscoped* recorded
binding meeting a scoped process is a grandfather case, not a conflict.
MG-1 has a grandfather rule; the profile check appears not to. Every
session recorded before 0.16.0 drifts on open, which is what put the
owner in front of this at all.

## The escape today

`--accept-drift` is threaded into this exact call, so it starts:

```
kiso --accept-drift
```

That records an acknowledgement revision on each drifted session, which
is a real durable write done to see a glyph. It unblocks; it is not the
fix.

## Red before green

A session store with one drifted profile, `kiso` started plainly: the
process reaches the composer, the drifted session appears in the list
without a badge, and nothing throws.
