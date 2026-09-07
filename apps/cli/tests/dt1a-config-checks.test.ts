/** DT-1a — `checks` in the config: validated, merged per name (project wins). */
import { describe, expect, it } from "vitest";
import { mergeConfigs, parseConfig } from "../src/config.js";

describe("DT-1a — config checks", () => {
	it("parses a name → command map and rejects bad shapes loudly", () => {
		const cfg = parseConfig(JSON.stringify({ checks: { test: "npm test", lint: "npm run lint" } }), "~/.kiso/config.json");
		expect(cfg.checks).toEqual({ test: "npm test", lint: "npm run lint" });
		expect(() => parseConfig(JSON.stringify({ checks: ["npm test"] }), "x")).toThrow(/checks/);
		expect(() => parseConfig(JSON.stringify({ checks: { "bad name": "x" } }), "x")).toThrow(/check name/);
		expect(() => parseConfig(JSON.stringify({ checks: { test: "" } }), "x")).toThrow(/non-empty/);
	});
	it("merges per name; the project's entry wins", () => {
		const m = mergeConfigs({ checks: { test: "npm test", lint: "a" } }, { checks: { lint: "b" } });
		expect(m.checks).toEqual({ test: "npm test", lint: "b" });
		expect(mergeConfigs(null, null).checks).toBeUndefined();
	});
});
