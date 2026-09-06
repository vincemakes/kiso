/**
 * D-S2-1 — the idle hint's ladder gains the ctrl+o switch on its two
 * widest rungs, and is byte-identical to the R8b ladder when the caller
 * has no switch to name.
 */
import { describe, expect, it } from "vitest";
import { idleHint, statusLine, visibleWidth } from "../src/components.js";

describe("D-S2-1 — idleHint with the switch", () => {
	it("null is the R8b ladder, unchanged, at every room", () => {
		for (let room = 0; room <= 80; room += 1) expect(idleHint(room, null)).toBe(idleHint(room));
	});

	it("the switch rides the two widest rungs, beside ctrl+r", () => {
		expect(idleHint(80, "expand all")).toBe(" / commands · ↑ history · ctrl+o expand all · ctrl+r transcript");
		expect(idleHint(55, "collapse all")).toBe(" / commands · ctrl+o collapse all · ctrl+r transcript");
	});

	it("below the two rungs the ladder is R8b's — the switch gives way before the transcript key", () => {
		expect(idleHint(45, "expand all")).toBe(" / commands · ↑ history · ctrl+r transcript");
		expect(idleHint(31, "expand all")).toBe(" / commands · ctrl+r transcript");
	});

	it("never wider than the room, with or without the switch", () => {
		for (let room = 0; room <= 80; room += 1) {
			expect(visibleWidth(idleHint(room, "expand all")), `room=${room}`).toBeLessThanOrEqual(room);
			expect(visibleWidth(idleHint(room, "collapse all")), `room=${room}`).toBeLessThanOrEqual(room);
		}
	});

	it("statusLine threads it through to the right edge", () => {
		const row = statusLine("", "", 80, undefined, "expand all");
		expect(row).toContain("ctrl+o expand all · ctrl+r transcript");
		expect(visibleWidth(row)).toBeLessThanOrEqual(80);
		expect(statusLine("", "", 80)).not.toContain("ctrl+o");
	});
});
