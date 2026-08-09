/**
 * W21 — the approval panel shim: the components cell moved to the 9th
 * package (ADR-0043 Amendment 4); the tui re-exports it so its own
 * consumers (the compositor, the cli) import a stable path.
 */

export * from "@vincemakes/kiso-tui-cells/approval-panel";
