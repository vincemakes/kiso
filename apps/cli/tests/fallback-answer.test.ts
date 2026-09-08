import { describe, expect, it } from "vitest";
import { parseFallbackAnswer } from "../src/trust-ui.js";

/** The dock-less fallback line's grammar (LH-1 ruling 2026-09-08): `n <reason>`
 *  denies WITH the reason; a bare `n` (or any other line) is the bare denial
 *  that aborts — unchanged. String level only; the real input path is
 *  fallback-deny-reason-pty.test.ts. */
describe("parseFallbackAnswer", () => {
	it("y… allows; the words are not carried on this surface", () => {
		expect(parseFallbackAnswer("y")).toEqual({ action: "allow", reason: "" });
		expect(parseFallbackAnswer("  Yes please ")).toEqual({ action: "allow", reason: "" });
	});
	it("n <reason> / no <reason> deny with the reason", () => {
		expect(parseFallbackAnswer("n the file is outside the workspace")).toEqual({ action: "deny", reason: "the file is outside the workspace" });
		expect(parseFallbackAnswer("no: use the tests dir instead")).toEqual({ action: "deny", reason: "use the tests dir instead" });
		expect(parseFallbackAnswer("N - not that one")).toEqual({ action: "deny", reason: "not that one" });
	});
	it("a bare n / no, and anything else, is the bare denial (aborts)", () => {
		expect(parseFallbackAnswer("n")).toEqual({ action: "deny", reason: "" });
		expect(parseFallbackAnswer("no")).toEqual({ action: "deny", reason: "" });
		expect(parseFallbackAnswer("")).toEqual({ action: "deny", reason: "" });
		expect(parseFallbackAnswer("nope")).toEqual({ action: "deny", reason: "" });
		expect(parseFallbackAnswer("maybe later")).toEqual({ action: "deny", reason: "" });
	});
});
