/**
 * L2 — permission as a negotiation, not a gate (mauri ADR-0002).
 *
 * A permission decision is a dialog step with state and an upgrade path:
 * allow one call, deny with a reason fed back to the model, or defer to a
 * human. The kernel's contract is only the decision shape; where decisions
 * are stored (accept-for-session) is harness territory (PermissionStore,
 * M2).
 *
 * `defer` IS A REAL PAUSE. The M1 note that once lived here — "defer is a
 * deny with reason 'awaiting user'; the human-in-the-loop wiring arrives
 * with the harness" — described the behavior ADR-0024 decision #3 replaced,
 * and that ADR's own Context names this note as the thing it fixed (a
 * denial "fakes the pause": the model sees a refusal and adjusts while no
 * human ever decided). Shipped now: the loop persists `permission_requested`
 * and AWAITS the approval channel in the same run frame, the human's
 * verdict is persisted as `permission_decided`, and the pause survives a
 * crash (kernel/loop.ts). With no approval channel configured the deferral
 * degrades to an HONEST denial that says so.
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
