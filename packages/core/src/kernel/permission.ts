/**
 * L2 — permission as a negotiation, not a gate (mauri ADR-0002).
 *
 * A permission decision is a dialog step with state and an upgrade path:
 * allow one call, deny with a reason fed back to the model, or defer to a
 * human. The kernel's contract is only the decision shape; where decisions
 * are stored (accept-for-session) is harness territory (PermissionStore,
 * M2). M1 treats `defer` as a deny with reason "awaiting user" — the model
 * sees the refusal and can adjust; the human-in-the-loop wiring arrives
 * with the harness.
 */

export type PermissionDecision =
	| { readonly action: "allow" }
	| { readonly action: "deny"; readonly reason: string }
	| { readonly action: "defer"; readonly reason?: string };

/** The denial a tool result carries when a call was refused pre-flight. */
export function denialResult(reason: string) {
	return {
		content: `[Permission denied] ${reason}`,
		isError: true,
		errorKind: "precondition" as const,
		tags: ["denied"] as const,
	};
}
