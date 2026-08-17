/**
 * TUI2-R1.5 slice ⑤ — VD-15: /context uses ONE number formatter.
 *
 * The ledger's k() had a hard floor at 100, so a single right-aligned
 * column stacked `11`, `0.3k` and `25.7k` — three magnitudes in two unit
 * systems, one under the other. The repo already had a k-formatter with
 * a 1000 floor (render.ts's kUnit, used by the status row and the
 * settled cards); the ledger now agrees with it, so every surface reads
 * plain integers below 1000 and k above.
 *
 * Red on base: a 300-token row renders "0.3k" while an 11-token row
 * renders "11".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextRows } from "../src/context-ledger.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const LEDGER = {
	window: 200_000,
	systemPrompt: 2_400,
	systemBase: 2_000,
	appends: 2,
	toolTable: 300,
	tools: 11,
	skillsIndex: 900,
	skills: 1,
	envelope: 11,
	messages: 25_700,
	turns: 4,
};

describe("TUI2-R1.5 ⑤ — /context speaks one number language (VD-15)", () => {
	it("every row below 1000 is a plain integer; above it, k — never both in one column", () => {
		const rows = contextRows(LEDGER);
		const joined = rows.join("\n");
		// the small rows keep their real value
		expect(joined).toMatch(/\b300\b/);
		expect(joined).toMatch(/\b11\b/);
		// the big ones are k
		expect(joined).toContain("25.7k");
		// and no row mixes the systems: nothing renders a sub-1000 k
		expect(joined).not.toMatch(/\b0\.\dk/);
	});

	it("the header's used/window pair uses the same formatter", () => {
		const rows = contextRows(LEDGER);
		expect(rows[0]).toContain("200k tokens");
	});
});
