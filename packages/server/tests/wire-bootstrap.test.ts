/**
 * ADR-0064 A2 (spec § 4.5): a lease session's bootstrap is the model's
 * context, not a conversation turn. It never reaches a client: the wire
 * projection drops it, so kiso web neither shows it nor trips on it.
 */
import type { Event } from "@vincemakes/kiso-core";
import { describe, expect, it } from "vitest";
import { toWireEvent } from "../src/wire.js";

describe("the wire projection of a context_bootstrap", () => {
	it("is nothing", () => {
		const boot = { seq: 0, type: "context_bootstrap", meta: { leaseId: "L1" }, projection: "Work snapshot at revision 4" } as unknown as Event;
		expect(toWireEvent(boot)).toBeNull();
		expect(toWireEvent(boot, { exposeThinking: true })).toBeNull();
	});
});
