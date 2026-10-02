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

None for a user. Every delegation is asked of the human (no auto-allow);
depth is guarded so children can never nest.

## Background children (ADR-0058)

A host that passes its per-session task manager gets
`delegate({ …, background: true })`:

```ts
createSubagentExtension({
	tasks: (sessionId) => managerFor(sessionId), // the runtime's TaskManager
	backgroundMax: 20, // live background children per session (default)
	backgroundMaxTurns: 32, // a child's model requests before its wrap-up (default)
});
```

Explorer and reviewer only. Each child is an agent task under the task
runner — it outlives the parent — and the call returns at once; the
runtime's task delivery tells the model when the turn's children have all
ended, with each child's answer (`result.md` beside its task). Without
`tasks`, the schema and behaviour are the foreground's, byte for byte. The
CLI wires it.

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
