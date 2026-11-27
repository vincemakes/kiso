/**
 * ADR-0064 A2 — lease reconciliation (actor RFC § 6.1): after a crash between
 * any two protocol steps, what the durable state says to do next. Pure: the
 * work's commitment, the lease session's events, and two facts the host knows
 * (does a live owner hold the session; does it hold a recoverable run).
 */
import { createHash } from "node:crypto";
import type { Event } from "@vincemakes/kiso-core";
import type { Commitment } from "./reducer.js";

export type LeaseDecision =
	| { readonly decision: "no-lease" }
	| { readonly decision: "none"; readonly reason: string }
	| { readonly decision: "retry-bootstrap" }
	| { readonly decision: "attach"; readonly bootstrapDigest: string }
	| { readonly decision: "resume-session" }
	| { readonly decision: "release-stale" }
	| { readonly decision: "corrupt"; readonly reason: string };

export const bootstrapDigest = (projection: string): string => createHash("sha256").update(projection).digest("hex");

export function reconcileLease(input: {
	readonly commitment: Commitment;
	readonly sessionEvents: readonly Event[];
	readonly liveOwner: boolean;
	readonly recoverableRun: boolean;
}): LeaseDecision {
	const lease = input.commitment.lease;
	if (lease === undefined) return { decision: "no-lease" };
	if (input.liveOwner) return { decision: "none", reason: `session ${lease.sessionId} has a live owner` };
	const first = input.sessionEvents[0];
	// Found by its leaseId, never by position or content alone.
	const boot = first?.type === "context_bootstrap" ? first : undefined;
	if (boot !== undefined && boot.meta["leaseId"] !== lease.leaseId) return { decision: "corrupt", reason: `the session's bootstrap belongs to lease ${String(boot.meta["leaseId"])}` };
	if (lease.state === "opened") {
		if (boot !== undefined) return { decision: "attach", bootstrapDigest: bootstrapDigest(boot.projection) };
		if (input.sessionEvents.length === 0) return { decision: "retry-bootstrap" };
		return { decision: "corrupt", reason: "the session has events but no bootstrap: it can never get one" };
	}
	if (boot === undefined) return { decision: "corrupt", reason: "an attached lease's session has no bootstrap" };
	if (bootstrapDigest(boot.projection) !== lease.bootstrapDigest) return { decision: "corrupt", reason: "the bootstrap does not match the digest the lease attached" };
	const uncertainHere = input.commitment.effects.some((e) => e.status === "uncertain" && e.execution?.sessionId === lease.sessionId);
	if (input.recoverableRun || uncertainHere) return { decision: "resume-session" };
	return { decision: "release-stale" };
}
