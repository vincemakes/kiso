/**
 * KC3 slice 1 — the strings shim: the human-facing strings moved to the
 * 9th package (the ADR-0043 Amendment 4 hatch); the tui re-exports them
 * so its consumers (the cli) import a stable path.
 */

export * from "@vincemakes/kiso-tui-cells/strings";
