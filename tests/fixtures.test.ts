import { describe, expect, it } from "vitest";
import { FIXTURES, runStaticFixture } from "./fixtures/index";

describe("fixture library", () => {
	it("every fixture's static check passes against its own script", () => {
		for (const fixture of FIXTURES) {
			const result = runStaticFixture(fixture);
			expect(result.violations, `${fixture.name}: ${fixture.incident}`).toEqual([]);
		}
	});

	it("each fixture reproduces a distinct incident", () => {
		const names = new Set(FIXTURES.map((f) => f.name));
		expect(names.size).toBe(FIXTURES.length);
	});
});
