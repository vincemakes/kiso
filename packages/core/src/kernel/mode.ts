/**
 * L2 — ModeProfile: a mode is a cross-layer behavior switch (mauri ADR-0011),
 * not a kernel feature. The kernel knows ONE mode at a time and applies it
 * structurally:
 *
 * - `visibleToolNames` — physical removal: the registry is subset() to these
 *   tools BEFORE the adapter is called. The model cannot call what it cannot
 *   see; no system-prompt overlay can make that guarantee.
 *
 * That is the whole profile. SC-1b: `systemOverlay`, `permissionDefault`,
 * `compactionKeepExtra`, and `stopPredicate` were REMOVED at 0.12.0 by the
 * SC-1 memo's adjudication — all four were declared here and read by
 * nothing, in the kernel or above it. Two of them ("reserved, read by the
 * harness when the semantics land") had been waiting since mauri ADR-0011
 * for semantics that never landed. A field that describes an intention
 * rather than a behavior is a promise the type system makes on the
 * kernel's behalf and the kernel does not keep; the honest profile is the
 * one member that is actually applied.
 */

export interface ModeProfile {
	readonly name: string;
	readonly visibleToolNames?: readonly string[];
}

export function resolveModeProfile(
	modes: readonly ModeProfile[] | undefined,
	name: string | undefined,
): ModeProfile | undefined {
	if (!name || !modes) return undefined;
	return modes.find((m) => m.name === name);
}
