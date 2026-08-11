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

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
