# kiso-skills-ext

The kiso official skills extension: two-tier progressive skills, the kernel
untouched.

## How it is loaded

Since 0.1.45 this extension ships **built-in** with the kiso CLI — a fresh
install starts with it registered (the startup banner lists it), with zero
disk setup. The same artifact can also be installed as a user-level
extension: copy `dist/kiso-skills.mjs` into `~/.kiso/extensions/` — the
user-layer loader accepts exactly this shape.

## Configuration

Skill directories: `~/.kiso/skills/<name>/SKILL.md` (or the project-level
`.kiso/skills/` after the trust gate). No configuration file — the
extension scans the skills dir at startup.

A name found twice resolves to its first occurrence (root order, then
directory-name order within each root); the later one is reported with
the broken skills, never listed.

A host passes options instead: `createSkillsExtension({ roots, include })`.
`roots` replaces the default scan with the host's directories, in order.
`include(entry)` decides which skills are active, and the model's index,
`read_skill`, the catalog and the count are all built from that one
filtered list, so a skill the host turned off cannot be loaded on
request either.

## Invoking a skill yourself

`/skill <name> [args]` sends a skill as your turn: its SKILL.md body, then
your args after a blank line. `/<name> [args]` does the same when no
built-in command has that name — a built-in always wins. `/skills` lists
what is installed, where each skill lives, and any that cannot load with
the reason.

The frontmatter keys read are `name`, `description` and `user-invocable`.
Values may be plain, quoted (`"…"` or `'…'`), or YAML block scalars (`>` or
`|`, with the text on the following indented lines); the index shows the
description on one line. A `>` or `|` with nothing under it is reported as
a skill that cannot load.

A skill whose frontmatter says `user-invocable: false` stays in the
model's index and out of your reach. Only the literal `false` counts; a
skill without the key is invocable.

The body is sent as written — there is no placeholder substitution; your
args follow it. A body over 32,768 characters is refused, not cut.

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
