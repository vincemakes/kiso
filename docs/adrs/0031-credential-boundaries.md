# ADR-0031: Credential boundaries — strip by default, pass explicitly under human approval

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** Cross-cutting (tools / official extensions)

## Context

Three surfaces spawn or inherit processes with a live provider key in the
environment: the shell tool (arbitrary commands), the subagent delegate
(child kiso processes), and the MCP bridge (stdio server children). Each
answers a different trust question, and treating them alike would be wrong
in both directions — leaking a key into an arbitrary shell command is
theft; hiding it from a delegate the human just approved would cripple a
legitimate child that must call the provider.

## Decision

A three-way boundary, decided per surface:

1. **Shell (tools-node #7): STRIP BY DEFAULT.** The shell tool spawns
   commands with provider credentials removed — the exact list
   (`ANTHROPIC_/OPENAI_` KEY/BASE_URL/MODEL) plus every `*_API_KEY` /
   `*_AUTH_TOKEN` pattern. `shellEnv: "inherit"` is an explicit opt-in.
   Rationale: shell runs ARBITRARY commands — the command's author is not
   the extension author, and a credential in the environment is a
   standing invitation.
2. **MCP stdio servers: STRIP BY DEFAULT, CONFIG OVERRIDES.** The bridge
   passes the stripped environment PLUS the config's explicit `env` —
   the explicit env wins and may deliberately re-add a variable. The
   server is a declared, configured peer, so the operator can authorize
   precisely.
3. **Subagent delegate: PASS EXPLICITLY UNDER HUMAN APPROVAL.** The child
   receives the parent's full environment deliberately — because the
   delegate is a CONTROLLED spawn (the same binary, a role policy, a
   worktree for implementers) that the human JUST approved in the ask tier
   (ADR-0029). The difference from the shell tool is documented in the
   extension's source: shell = arbitrary commands, stripped by default;
   delegate = a controlled spawn the human authorized.

## Consequences

- The default posture is strip; every pass-through is an explicit,
   documented, human-gated decision.
- Known cost: an approved delegate that needs to reach the provider works
  because the parent's environment rides along — which means a delegate
  policy is a trust decision, not a sandbox. The role policies
  (ADR-0032) are the compensating control for what the child may DO with
  the credentials.
- The strip lists are duplicated in the shell tool and the MCP bridge
  with an explicit "keep in sync" note — a small drift risk, accepted for
  zero-dependency simplicity (ADR-0028).

## When to revisit

A credential-vault mechanism (e.g. a secrets store the tools read
directly) would replace the strip-list approach wholesale — until then the
lists are the boundary.

## Evidence

- Commit `8b4c376` (fix(tools-node): shell children never inherit kiso
  provider credentials — bootstrapping #3 finding #7); the MCP strip + config overlay
  in `67ceefe`; the delegate pass-down in `d64c6a6`.
- Tests: `packages/tools-node/tests/safety.test.ts` (strip + inherit
  opt-in); `extensions/mcp/tests/mcp.test.ts` (④ credential strip +
  CUSTOM_VAR overlay).

## Amendment 1 (2026-09-05): the shell surface gains the explicit-env shape

Decision 1 offered the shell two shapes — strip by default, or
`shellEnv: "inherit"`. An embedding host that needs a few variables in
its tool subprocesses had to choose between opening the whole
environment and writing the values to a temporary file for the command
to source. Neither is the boundary this ADR meant.

`shellEnv` now accepts a third shape, a record of explicit entries,
with exactly decision 2's semantics: the child receives the STRIPPED
environment plus the record, and the record wins per key — so an entry
may deliberately re-add a stripped name, as an MCP server's configured
`env` already may. Absent and `"inherit"` are unchanged. The record is
the host's declaration, not the command author's, which is the same
line decision 2 drew: the operator authorizes precisely.

Gated in `packages/tools-node/tests/safety.test.ts` (the record reaches
the child; the base stays stripped; an explicit entry wins).
