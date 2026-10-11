# ADR-0033: Skills load progressively through existing surfaces

- **Status:** Accepted
- **Date:** 2026-08-04
- **Layer:** Official extension (skills)

## Context

The skills stage (⑤) needed a way to hand the model reusable procedures
(SKILL.md files) WITHOUT a new kernel mechanism: no tool registry changes,
no new loading semantics, nothing outside the extension contract
(ADR-0028). The prior art — Claude Code's skills — established the
SKILL.md + frontmatter shape, and a skill ecosystem that kiso should be
able to ingest cold (an ecosystem cold start). The design constraint: everything the
model needs must arrive through surfaces that already exist.

## Decision

Skills load PROGRESSIVELY, through existing surfaces only:

1. **Tier 1 — resident index via systemPrompt.append.** Every skill's
   frontmatter (a `---` wrapped YAML subset; only `name`/`description`
   are read, by a hand-written parser — zero dependencies) becomes one
   line of the system prompt, sorted by directory name:
   `Available skills (load with read_skill):` + `- <name>: <description>`.
   A broken SKILL.md (no frontmatter) is skipped with a warning line at
   the index tail — soft failure, the mcp philosophy (ADR-0030). No/empty
   skills dir → an empty extension, never an error.
2. **Tier 2 — on demand via a tool.** `read_skill {name}` returns the
   full SKILL.md (capped at 32KB with a truncation note); an unknown name
   is an honest, actionable error listing the installed skills.
3. **Tier 3 — progressive, zero new mechanisms.** Files other than
   SKILL.md are NOT auto-loaded: the skill body tells the model to read
   them with `read_file` by relative path when it needs them. The third
   tier is a CONVENTION, not a loader feature.
4. **CC compatibility.** The frontmatter name/description subset parses
   Claude Code skill files as-is — a CC skill directory dropped into
   `~/.kiso/skills/` works without conversion. The ecosystem cold-start
   is the point: skills are content, and content should migrate.

**Why not in the kernel**: skills are content + a loader convention — the
kernel owns contracts that genuinely repeat (ADR-0001/0021); a skill
surface in the core would add a third content format the kernel must
version. The extension contract already carries it.

## Consequences

- The model sees the index before it needs the body, and the body before
  it needs the files — the load is proportional to use.
- Known cost: the tier-3 convention depends on the model choosing to
  `read_file` relative paths; there is no enforcement. The convention is
  written into the README and the skill bodies, not the kernel.
- Known cost: a hand-written frontmatter subset means CC skills with
  richer fields (allowed-tools, model) load with those fields ignored —
  the subset is the compat boundary, recorded here.

## When to revisit

A skill surface in the kernel would require a SECOND product proving a
kernel-owned skill mechanism pays — currently refused; skills stay an
extension.

## Evidence

- Commit `fc483ce` (feat(skills): ⑤).
- Tests: `extensions/skills/tests/skills.test.ts` (index sorted,
  roundtrip, unknown-name error with the list, soft-failed broken skill,
  truncation, empty/missing dir); `extensions/skills/tests/skills-
  e2e.test.ts` (read_skill auto-allowed by safe-defaults, body back to
  the model).

## Amendment 1 (2026-10-11): tier 3 goes through read_skill, and the warning line leaves the prompt

**Reverses decision 3.** The tier-3 convention never worked: read_file
is bounded to the workspace and refuses absolute paths, and the skill's
directory (`~/.kiso/skills/<name>/`) is outside the workspace. read_skill
never said where that directory was. A skill whose body names
`references/forms.md` sent the model to a file it could not reach. The
"known cost" above recorded an unenforced convention; in fact the
convention was an unreachable one.

Tier 3 is now `read_skill {name, file}`. `file` is a path relative to the
skill's own directory, and the call is refused when:

- the path is absolute;
- it has a `..` segment;
- its real path (symlinks resolved) leaves the skill's real directory;
- it names something other than a regular file.

The file is only read: a script comes back as text, and running it stays
shell's business under shell's permission. Both reads keep the 32 KB cap,
and the truncation note now says the cap. It used to send the model to
read_file, which cannot reach the directory.

read_file is **not** widened. The workspace reader keeps the workspace
namespace, and the skill reader owns the skill namespace, so installing
skills does not hand the workspace reader `~/.kiso/skills`.

**Reverses decision 1's warning line.** Broken skills no longer append a
`[skills] skipped …` line to the resident index:

- the model cannot repair a skill directory, and the line was paid on
  every request;
- the person still sees every broken entry, with the loader's reason, in
  `/skills` and the CLI's reload line (the catalog's `broken`);
- the model meets a broken skill only when it is relevant, in read_skill's
  unknown-name error, which names the skipped entry and its reason;
- with no valid skill at all, the extension appends nothing and offers no
  tool.

Evidence: `extensions/skills/tests/skills.test.ts`, the SK0 and K1 blocks
(red against the previous source).
