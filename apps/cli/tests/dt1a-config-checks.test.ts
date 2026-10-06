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
	it("CS-1: evaluators are a list of absolute paths; both layers' lists join", () => {
		// an absolute path for the platform (a drive path on Windows)
		const EVAL = process.platform === "win32" ? "C:\\opt\\eval\\strict.sh" : "/opt/eval/strict.sh";
		const cfg = parseConfig(JSON.stringify({ evaluators: [EVAL] }), "~/.kiso/config.json");
		expect(cfg.evaluators).toEqual([EVAL]);
		expect(() => parseConfig(JSON.stringify({ evaluators: { strict: "/opt/eval/strict.sh" } }), "x")).toThrow(/evaluators — expected a list/);
		expect(() => parseConfig(JSON.stringify({ evaluators: ["eval/strict.sh"] }), "x")).toThrow(/evaluators — expected an absolute path/);
		expect(mergeConfigs({ evaluators: ["/a.sh"] }, { evaluators: ["/b.sh"] }).evaluators).toEqual(["/a.sh", "/b.sh"]);
		expect(mergeConfigs(null, null).evaluators).toBeUndefined();
	});
});
