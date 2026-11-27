/**
 * ADR-0064 A2: the door kiso-actor writes a lease session's bootstrap through.
 * `@vincemakes/kiso-runtime/lease`, for kiso-actor; NOT STABLE.
 *
 * Invariant 1, split by layer: core's validator holds a bootstrap to seq 0,
 * so a session has at most one and only as its first event. This door writes
 * it only into an empty log and never rewrites it. "Every lease session has
 * exactly one, before anything else" is kiso-actor's contract: its
 * `openLease` creates the session through this door and nothing else.
 */
import type { SessionStore } from "./store.js";

export class BootstrapRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BootstrapRefusedError";
	}
}

/** Write the bootstrap as event 0 of an empty session; durable when it resolves. */
export async function writeBootstrap(store: SessionStore, sessionId: string, block: { readonly meta: Readonly<Record<string, unknown>>; readonly projection: string }): Promise<void> {
	if (store.load(sessionId).length > 0) throw new BootstrapRefusedError(`session ${sessionId} already has events: a bootstrap is only ever its first`);
	await store.append(sessionId, "bootstrap", { seq: 0, type: "context_bootstrap", meta: block.meta, projection: block.projection });
}

/** The session's bootstrap, if it is a lease session. */
export function bootstrapOf(store: SessionStore, sessionId: string): { readonly meta: Readonly<Record<string, unknown>>; readonly projection: string } | undefined {
	const first = store.load(sessionId)[0]?.event;
	return first?.type === "context_bootstrap" ? { meta: first.meta, projection: first.projection } : undefined;
}
