Translated from the original Chinese round record (2026-08-06)

# E3 — project-level extensions + the trust gate

> Date: 2026-08-04
> Status: complete — spec sections 1-7 delivered, acceptance gate green
> Authority: direction ruling 2026-08-04 (user): the E3 spec. The four
> rulings — content-digest trust, three artifact kinds through ONE gate,
> untrusted never loads, kernel zero-diff — are binding; the trust flow is
> proven end to end through the CLI's topmost entry, and ADR-0037 lands in
> the same round (the index's process rule).

## 1. Goal

A repo's `.kiso` is a code-execution surface (extensions load into the
agent, mcp.json spawns servers, skills inject prompt text). The gate binds
every trust decision to the CONTENT that will execute: a sha256 bundle
digest over the sorted artifact paths and contents. Same project, same
files, same verdict — no re-ask. Any change to any file invalidates every
prior record. Untrusted capability never loads; only a human may decide,
TTY only.

## 2. Non-goals (violations counted as scope creep)

- No `KISO_TRUST`-style skip-ask environment variable (the gate is not a
  toggle).
- No `trust` subcommand (v1 interactive trust is the honest minimal
  gate).
- No signature/public-key system.
- No core diff of any kind — the mechanism lives in the runtime
  (packages/runtime) and the gate in the CLI.

## 3. Baseline (recorded before starting)

- core: unchanged — this stage touches only runtime + cli + tests.
- cli: 803 lines (the 1,200 gate) — ended at 996.
- 417 tests green — ended at 445 (+28: 18 runtime trust unit + 10 CLI
  project-trust e2e/unit).

## 4. Delivery areas (with the evidence discipline: commit + file:line + test + red→green)

### a. runtime — the trust mechanism (library-level)

- `packages/runtime/src/trust.ts` — `projectArtifacts(cwd)` discovers
  `<cwd>/.kiso/{extensions/*.mjs, mcp.json, skills/<name>/SKILL.md}` (the
  skills scan is one level — the same scan the skills extension performs,
  so the digest covers exactly what loads) and returns a manifest with one
  sha256 per file plus the bundle digest (sha256 over sorted paths +
  contents). No `.kiso` or no artifacts → null.
- `packages/runtime/src/trust.ts` — the trust store:
  `~/.kiso/trust.jsonl` (KISO_HOME respected), append-only
  `{root, digest, decision, ts}`, the LAST record matching (root, digest)
  wins (`trustFor`), `recordTrust` appends. Corrupt lines are SKIPPED —
  the tolerance differs from the session store on purpose (module comment):
  trust is a memo, not an event stream; a lost grant or refusal only
  re-asks a human.
- `packages/runtime/src/extensions.ts` — `loadProjectExtensions(dir,
  existing)` loads `<dir>/.kiso/extensions/*.mjs` AFTER the trust gate and
  refuses loudly when a name exists in both levels. `loadExtensions`'s
  signature is unchanged.

### b. CLI — the startup gate, the banner, the merges

- `apps/cli/src/index.ts` — `resolveProjectTrust()` runs BEFORE any
  extension load: granted → load; refused → sticky, never re-asked; no
  record + TTY → per-item listing (file name + 6-hex digest prefix) then
  ONE question, verdict recorded; no record + non-TTY → one stderr hint,
  nothing loads, nothing recorded.
- `apps/cli/src/index.ts` — `applyProjectMerges` on grant: project
  `mcp.json` merges with the user config into one temp file
  (`KISO_MCP_CONFIG` repointed — the mcp factory reads it at load time);
  a server name in both is a LOUD error. Project skills symlink into a
  temp merged scan dir (`KISO_SKILLS_DIR` repointed — the skills
  extension's existing scan); a skill name in both: project wins + one
  stderr note. Temp artifacts are best-effort removed in main's finally.
- `apps/cli/src/index.ts` — the banner distinguishes project extensions:
  `[3 extensions: safe-defaults · project: lint-rules, mcp]` (TTY and
  off-TTY alike); byte-identical to the historical text when no project
  extensions are loaded (existing e2e assertions naturally hold unbroken).

### c. Tests (red→green; the seven acceptance flows + extras)

- `packages/runtime/tests/trust.test.ts` (18) — discovery of all three
  kinds, null for absent/empty `.kiso`, digest changes on content/path
  change, order-independence, inert files excluded, realpath root,
  last-wins, digest-bound records, corrupt lines skipped, refused
  sticky, loadProjectExtensions empty/load/conflict/broken.
- `apps/cli/tests/project-trust.test.ts` (10) — ① first discovery asks
  once, y grants+loads+records; ② n refuses+records, nothing loads;
  ③ granted restart never re-asks; ④ a changed file re-asks (the old
  grant died with the files); ⑤ non-TTY: one stderr hint, no record;
  ⑥ cross-level name conflict = loud startup error; ⑦ refused sticky;
  plus mcp-server-name conflict e2e and the mcp/skills merge unit
  coverage.
- Red evidence: the suite failed as written before the fix — the banner
  initially double-counted the project extension (`[2 extensions:
  lint-rules · project: lint-rules]`) because the user-level list was
  merged into the total; `userExtensions` now stays separate, and the
  banner part comes from it (`[1 extension: project: lint-rules]`).

### d. ADR-0037 — same round (the index's process rule)

- `adrs/0037-project-level-capability-is-trusted-by-content-digest.md`
  — the four rulings, the two failed mental models (trust-the-directory,
  trust-once-remember-the-path), the Consequences (headless needs a
  prior interactive grant; refused stickiness; skills merge visibly),
  and the explicit KEEP-rejected `KISO_TRUST` toggle.
- `adrs/README.md` — index entry 0037.

## 5. Acceptance

- `npm run check` EXIT 0 — 445/445 tests, smoke (5 consumer tiers) PASS,
  demo clean, whitespace gate clean, cli size 996/1,200.
- ADR 0037 committed in the same round as the implementation.
- README: the Project-level section (three artifact kinds, the trust
  flow, the CI pre-grant note, revoke = delete the trust.jsonl line) and
  the capability matrix row.

## 6. Out of scope (as specced)

`KISO_TRUST` env var, `trust` subcommand, signatures/public keys, core
diff. Release 0.1.10 is the user's call, per the standing pipeline.
