import { describe, expect, it } from "vitest";
import { runsACheck } from "../src/index.js";

describe("runsACheck from the runtime root", () => {
	it("knows the built-in runners and takes a host's own as the second argument", () => {
		expect(runsACheck("npm test")).toBe(true);
		expect(runsACheck("ls")).toBe(false);
		expect(runsACheck("just verify", ["just verify"])).toBe(true);
		expect(runsACheck("just verify")).toBe(false);
	});
});
