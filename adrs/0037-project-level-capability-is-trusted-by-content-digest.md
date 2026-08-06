# ADR-0037: Project-level capability is trusted by content digest, not by directory

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** Runtime (trust) + CLI (gate)

## Context

A project's `.kiso` directory is a code-execution surface: extensions
load into the agent, `mcp.json` spawns server processes, and skills inject
prompt text. The common vector is a CLONED REPO — an attacker-controlled
`.kiso` that executes on the first `kiso chat` the victim runs in that
directory. pi and dscode both gate project-level capability before it
runs; the question was WHICH gating promise kiso could keep.

Two candidate mental models failed under scrutiny:

- **Trust the directory.** "I trusted this repo before" breaks the moment
  the repo is re-cloned, moved, or updated — and a directory path says
  nothing about what the files currently do.
- **Trust once, then remember the path.** Same failure: the next
  `git pull` can swap the `.kiso` contents under the remembered path.

The only promise that survives updates is binding the decision to the
CONTENT that will execute, and letting content change invalidate it.

## Decision (E3, 四条裁定)

1. **Content digest is the trust key.** A trust record is
   `{root, digest, decision, ts}` where `digest` is a sha256 over the
   sorted relative paths of `<cwd>/.kiso`'s artifacts and their contents.
   Any file change changes the digest, which invalidates every prior
   record — the decision dies with the files it decided about.
2. **The three artifact kinds share ONE gate.** `extensions/*.mjs`,
   `mcp.json`, and `skills/<name>/SKILL.md` are discovered together
   (`projectArtifacts`), listed together at the gate, and trusted or
   refused as one bundle. A mixed gate would let a project smuggle an
   untrusted skill past a trusted extension.
3. **Untrusted capability is never loaded.** `granted` loads; `refused`
   never loads and is never re-asked (sticky — re-evaluate by deleting
   the trust line or changing a file); no record means only a HUMAN may
   decide, TTY only — first discovery lists every artifact (file name +
   digest short prefix) and asks once, and non-TTY refuses with one
   stderr line. There is no automated auto-allow path.
4. **The kernel stays untouched.** The mechanism lives in the runtime
   (`projectArtifacts`, the trust store, `loadProjectExtensions`) and the
   gate in the CLI; core has zero diff. The mcp/skills merges go through
   the EXTENSIONS' existing mechanisms (the mcp factory's
   `KISO_MCP_CONFIG`, the skills scan's `KISO_SKILLS_DIR`), never a new
   extension surface.

## Consequences

- A grant is durable across restarts and kill -9 (append-only
  `~/.kiso/trust.jsonl`, last record per (root, digest) wins) but never
  durable across content change — the re-ask on repo update is the
  design, not a nuisance. The trust store's tolerance is deliberately
  different from the session store: a corrupt line means "no record"
  (skip, never throw) because a lost grant or refusal only re-asks a
  human — there is no trajectory to preserve.
- Known cost: headless/CI runs of a project with untrusted `.kiso`
  artifacts never load them until someone runs interactively once —
  the README documents pre-granting (writing the record) for CI.
- Known cost: `refused` is sticky, which can surprise a user who changed
  their mind without changing the files — the README states the revoke
  path (delete the trust.jsonl line).
- Known cost: skills merging symlinks project skill dirs into a temp
  scan dir; a skill name in both levels resolves project-wins with a
  stderr note (only extension NAMES and mcp server NAMES are loud
  errors — skills merge visibly, not silently).

## When to revisit

A signature/public-key system would upgrade the trust from "decided by
the human who ran it" to "signed by the author" — out of scope by
design (v1 interactive trust is the honest minimal gate); revisit when
project-level capability distribution is a real product surface.
A `KISO_TRUST`-style skip-ask environment variable is explicitly
rejected (it would turn the gate into a toggle) and should stay rejected.

## Evidence

- Commits: `3d26112` (feat(runtime): E3 trust — projectArtifacts digest
  discovery, trust.jsonl store, loadProjectExtensions), `065c65f`
  (feat(cli): E3 — the project trust gate).
- Tests: `packages/runtime/tests/trust.test.ts` (digest changes on any
  file change; last-wins; corrupt lines skipped) and
  `apps/cli/tests/project-trust.test.ts` — the seven acceptance flows
  ①-⑦ through the CLI's topmost entry: first-discovery ask (y/n),
  granted restart without re-ask, digest change re-asks, non-TTY
  refusal, cross-level name conflict, refused stickiness, plus the
  mcp-server conflict and the mcp/skills merge unit coverage.
