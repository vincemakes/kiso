# dogfood #5 finding #9 — symlinked skill dirs are followed (P2)

> Date: 2026-08-04
> Status: complete — fix + ①-④ acceptance green, `npm run check` EXIT 0
> Authority: dogfood #5 finding #9 (P2) — the README's CC-compatible
> migration path (`ln -s ~/.claude/skills/x ~/.kiso/skills/x`) did not
> work: the skills scan's `isDirectory()` returned false for symlink
> dirents, graphify was silently skipped, the tier-1 index never listed
> it, and the model degraded to `shell cat` workarounds.

## 1. Root cause

`extensions/skills/src/kiso-skills.mjs` — `readdirSync(dir, {withFileTypes:
true}).filter((d) => d.isDirectory())` treats a symlink-to-directory as a
non-directory (dirent `isDir:false isLink:true`, measured). The skill was
silently dropped from the index; with zero skills the extension yields no
tools at all, so `read_skill` did not even exist.

Side consequence (also repaired by this fix): E3's project-level skills
merge (`applyProjectMerges` symlinks project skill dirs into the merged
scan dir) produced a scan dir whose entries are ALL symlinks — the old
scan skipped every one of them. Project skills were inert end to end;
the fix makes the merge actually load.

## 2. Fix

Directory determination follows symlinks: `d.isDirectory()` OR
(`d.isSymbolicLink()` && `statSync(join(dir, d.name)).isDirectory()`).
A broken link (target missing → statSync throws; target is a file →
not a directory) joins the EXISTING soft-failure path — a warning line
at the index tail, never an error.

## 3. Acceptance (red → green)

- ① unit: `⑧ a symlinked skill dir is discovered and indexed` —
  RED on the old dist (index absent, no read_skill tool), GREEN after.
- ② unit: `⑨ a broken symlink is a SOFT failure` (dangling link +
  link-to-file → both warned, good skill still loads) — RED (old code
  ignored symlinks entirely, no warning), GREEN after.
- ③ e2e: `⑨ a SYMLINKED skill works end to end` — KISO_SKILLS_DIR
  holds one symlinked skill; faux `read_skill` roundtrips through the
  CLI's topmost entry; the body returns. RED on old dist (`Unknown
  tool: read_skill` — the empty-index case), GREEN after.
- ④ existing skills tests: zero regression (11/11 in the suite).
- `npm run check` EXIT 0 — 448/448 (445 + 3).

## 4. Observed, deliberately NOT fixed (recorded, not fixed)

- ~~`mcp__status` is a zero-arg read-only tool but lands in the ask tier~~ —
  **fixed (0.1.11 round)**: joined the safe-defaults allow list (trust level
  same as read_file), one line + the safe-defaults test assertion.
- Each `mcp__fs__*` call asks individually — by design (external tools
  must pass human review). If dogfood friction recurs, a custom policy
  can allow specific servers; the default stays.

## 5. finding #10 (P1) — the trust gate read the user-level .kiso as a project

Real-machine record: running kiso with cwd = the home directory made
projectArtifacts discover `<cwd>/.kiso` — which IS the user-level config
directory itself. The CLI asked to trust your own configuration, and a
grant then self-mirrored mcp.json onto itself ("fs in both user-level and
project-level") and exited loudly — the home directory could not start
kiso at all.

Fix (`packages/runtime/src/trust.ts`): projectArtifacts compares
realpath(<cwd>/.kiso) with realpath(KISO_HOME, default ~/.kiso) and
returns null when equal — the home is never a project, KISO_HOME
overrides respected the same way. A stale trust.jsonl grant for the home
becomes inert (discovery never queries it) — no cleanup needed, README
troubleshooting states it in one line.

Acceptance (red → green): unit `(round 10) the KISO_HOME dir itself is never a
project` (red: artifacts returned); CLI e2e `(round 10) (finding #10) cwd = the
KISO_HOME parent` (red: the trust prompt appeared on the home dir —
the user's exact transcript shape); project-trust.test.ts full suite
zero regression.
