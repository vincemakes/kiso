/**
 * The decision card's click is the person's own line, marked as a pick of a line the model wrote: `via.kind: "choice"` validates in the
 * log, never counts as a runtime input, and a malformed one is corruption.
 */
import { describe, expect, it } from "vitest";
import { isKisoEvent, isRuntimeInput } from "@vincemakes/kiso-core";

const via = { kind: "choice", callId: "c1", option: 1 };

describe("user_input.via kind choice", () => {
	it("validates, and is the person's input (not a runtime one)", () => {
		expect(isKisoEvent({ seq: 0, type: "user_input", content: "Keep CSV only", via })).toBe(true);
		expect(isRuntimeInput({ via } as never)).toBe(false);
	});
	it("a malformed one is corruption", () => {
		for (const bad of [{ ...via, callId: "" }, { ...via, option: -1 }, { ...via, option: 1.5 }, { ...via, option: "1" }, { kind: "choice" }]) expect(isKisoEvent({ seq: 0, type: "user_input", content: "x", via: bad })).toBe(false);
	});
});
