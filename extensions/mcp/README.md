# kiso-mcp-ext

The kiso official MCP bridge extension: MCP servers become `mcp__` tools,
the kernel untouched.

## How it is loaded

Since 0.1.45 this extension ships **built-in** with the kiso CLI — a fresh
install starts with it registered (the startup banner lists it), with zero
disk setup. The same artifact can also be installed as a user-level
extension: copy `dist/kiso-mcp.mjs` into `~/.kiso/extensions/` — the
user-layer loader accepts exactly this shape.

## Configuration

Servers live in `~/.kiso/mcp.json` (or the project-level `.kiso/mcp.json`
after the trust gate) — see the kiso README. There is nothing to import;
the extension reads the config at startup and connects in the background.

## Versioning

The version counter is this package's own. It is pinned exactly by the kiso
CLI it ships with; an extension release reaches CLI users through the next
CLI release.
