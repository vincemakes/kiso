# kiso-subagent-ext

The kiso official subagent extension: child kiso processes with role
policies, the kernel untouched.

## How it is loaded

Since 0.1.45 this extension ships **built-in** with the kiso CLI — a fresh
install starts with it registered (the startup banner lists it), with zero
disk setup. The same artifact can also be installed as a user-level
extension: copy `dist/kiso-subagent.mjs` into `~/.kiso/extensions/` — the
user-layer loader accepts exactly this shape.

## Configuration

None. Every delegation is asked of the human (no auto-allow); depth is
guarded so children can never nest.

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
