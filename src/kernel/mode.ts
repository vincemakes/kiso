/**
 * L2 — ModeProfile: a mode is a cross-layer behavior switch (mauri ADR-0011),
 * not a kernel feature. The kernel knows ONE mode at a time and applies it
 * structurally:
 *
 * - `visibleToolNames` — physical removal: the registry is subset() to these
 *   tools BEFORE the adapter is called. The model cannot call what it cannot
 *   see; no system-prompt overlay can make that guarantee.
 * - `systemOverlay` — appended to the system prompt by the harness (the
 *   kernel does not compose prompts); kept here because it is part of the
 *   mode's contract.
 * - `permissionDefault` — the decision onPreTool falls back to when no hook
 *   or store decides.
 * - `compactionKeepExtra` / `stopPredicate` — reserved (ADR-0011); read by
 *   the harness when the semantics land.
 */

import type { PermissionDecision } from "./permission";

export interface ModeProfile {
	readonly name: string;
	readonly systemOverlay?: string;
	readonly visibleToolNames?: readonly string[];
	readonly permissionDefault?: PermissionDecision;
	readonly compactionKeepExtra?: readonly string[];
	readonly stopPredicate?: string;
}

export function resolveModeProfile(
	modes: readonly ModeProfile[] | undefined,
	name: string | undefined,
): ModeProfile | undefined {
	if (!name || !modes) return undefined;
	return modes.find((m) => m.name === name);
}
