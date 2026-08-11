# ADR-0030: Official extensions — in-repo workspaces, kernel zero-diff

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** Cross-cutting (official extensions)

## Context

The extension contract (ADR-0028) made user-installed `.mjs` files the
surface. The next stage shipped OFFICIAL extensions — the MCP bridge (③),
subagents (④), skills (⑤) — as in-repo workspaces. Two hard clauses shaped
the design: **kernel zero-diff** (the four kernel packages and the E1
loader must not change — a diff is a scope violation) and **soft failure
of external resources** (a broken MCP server must not brick the host).

finding #8 surfaced during the dispose lifecycle round: an MCP stdio server's
transport reader held the HOST's event loop alive after the CLI exited —
the process never terminated, and the SIGKILL of a mid-connect CLI left it
stuck in exit. The fix required a lifecycle hook the contract did not have.

## Decision

1. **Official extensions are in-repo workspaces** (`extensions/*`,
   private, not published to npm): the MCP bridge bundles the SDK into a
   self-contained single file via esbuild; subagents and skills are plain
   ESM — source IS the artifact, "build" copies to `dist/`. The user
   installs by copying the file into `~/.kiso/extensions/` (or pointing
   `KISO_EXTENSIONS_DIR` at it). Consumers build from the repo; the
   README guides both.
2. **Kernel zero-diff is the clause** — the official extensions prove the
   contract by exercising ONLY its seven surfaces (ADR-0028). The one
   kernel change the stage produced (ruling A, ADR-0029) was a correction of
   the contract itself, decided separately.
3. **External resources fail soft**: an MCP server that cannot connect is
   an error in `mcp__status`, not a startup failure — the other servers
   keep working. Loading a broken skill skips it with a warning line.
   Loud failure is reserved for the EXTENSION'S OWN file being broken
   (the loader's convention), never for the world it talks to.
4. **dispose lifecycle (finding #8)**: `KisoExtension.dispose?` — the loader
   calls it on exit, guarded per extension (one failure never blocks the
   rest), capped at 5s, with the abandoned-cap timer unref'd so a prompt
   dispose never leaves the cap timer holding the event loop. The MCP
   extension closes every client (transports terminate, children end);
   subagents and skills state explicitly that no dispose is needed —
   an explicit "not needed" beats silence.

## Consequences

- The official extensions are the contract's test bed: the e2e gates run
  the REAL artifacts through the CLI's topmost entry.
- Known cost: the extensions are NOT on npm — the user builds from the
  repo (two-step install: build + copy). The scope/publish decision is
  ADR-0034's (personal scope, kiso bin); the extensions ride the repo.
- Known cost: soft failure means a broken external server is only visible
  through `mcp__status` — the CLI has no new UI for it (ADR-0028: UI is
  not in the contract); the status tool itself presents the state.

## When to revisit

An official extension that needs a kernel surface beyond the seven would
trigger a contract extension decision — with this ADR's precedent: the
kernel diff, if any, is decided on its own merits, never smuggled in.

## Evidence

- Commits: `67ceefe` (MCP bridge), `d64c6a6` (subagents), `dd0e92d`
  (finding #8 dispose lifecycle + the unref'd-timer fix), `fc483ce` (skills).
- Tests: `extensions/mcp/tests/dispose-e2e.test.ts` (prompt exit + zero
  orphans, id-keyed), `extensions/mcp/tests/mcp.test.ts` (soft failure,
  connect timeout), `extensions/subagent/tests`, `extensions/skills/tests`.
