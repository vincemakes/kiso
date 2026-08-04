# ADR-0034: npm identity — a personal scope, the pi pattern

- **Status:** Accepted
- **Date:** 2026-08-03
- **Layer:** Cross-cutting (publishing)

## Context

The framework needed a publishable npm identity. The natural scope —
`@kiso/*` — was taken (by another project, not kiso). The alternative
paths were: a generic umbrella scope (an organization the project does not
own, or a neutral name that signals nothing), a typo-squatting-adjacent
variation, or the pattern pi uses: a PERSONAL scope that names the
maintainer, not the product. The decision also had to cover the binary
name: the CLI must be invocable as `kiso` regardless of the package scope.

## Decision

1. **Publish under a personal scope**: `@vincemakes/kiso-*` (core, evals,
   tools-node, provider-anthropic, provider-openai, runtime, cli). The
   scope is the maintainer's; the package names carry the product. The
   pi pattern is the precedent: a personal scope that is honest about who
   maintains the code and stable across the product's lifetime.
2. **The `@kiso` scope situation is recorded, not fought**: it is taken,
   and the response is an appeal line only if the holder ever abandons
   it — the identity decision does not depend on acquiring it.
3. **The binary is always `kiso`**: `@vincemakes/kiso-cli` installs a
   `kiso` bin — the command name is the product name, independent of the
   package scope. `kiso chat`, `kiso resume`, `kiso sessions` read the
   same regardless of how it was installed (`npm i -g`, `npx`, a nested
   consumer install).
4. **Official extensions stay in-repo, not on npm** (ADR-0030): the
   published surface is the seven kernel packages; extensions build from
   the repo into `~/.kiso/extensions/`.

## Consequences

- Every published artifact is traceable to the maintainer; the product
  name is not hostage to an unavailable scope.
- Known cost: a personal scope is a single point of identity — if the
  maintainer's npm account were ever compromised, the scope is the blast
  radius (the standard npm account-security trade, accepted).
- Known cost: consumers see `@vincemakes/kiso-*` and must learn the
  mapping to the product — the README states it in one line.

## When to revisit

If the `@kiso` scope is ever released, migration would be a re-publish
with deprecation notices — a mechanical operation, not a design change.

## Evidence

- Commits: `e590208` (build: publish under the @vincemakes scope),
  `b65eb3f` (build: publish metadata for the kiso repo).
- The publish pipeline and its per-release template are documented in the
  release records of `docs/plans/2026-08-04-*-md`; the live artifacts:
  `npm view @vincemakes/kiso-cli`.
