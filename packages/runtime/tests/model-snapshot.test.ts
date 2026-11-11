/** The release snapshot of every text model (owner, 2026-11-11): the last answer for pictures and a context window. */

import { describe, expect, it } from "vitest";
import { lookupContextWindow, lookupInputModalities, lookupModelMetadata } from "../src/provider/metadata.js";
import { MODEL_SNAPSHOT } from "../src/provider/model-snapshot.js";
// @ts-expect-error: a plain ESM script
import { rowsOf } from "../../../scripts/model-snapshot.mjs";

describe("the model snapshot", () => {
	it("answers whether a model reads pictures where the table's row does not say", () => {
		expect(lookupModelMetadata("deepseek-flash", "https://api.deepseek.com")?.capabilities.inputModalities ?? null).toBeNull();
		// the vendor's alias names the weights the snapshot lists by version
		expect(lookupInputModalities("deepseek-flash", "https://api.deepseek.com")).toContain("image");
		// the vendor spells it with dashes, the list with a dot
		expect(lookupInputModalities("claude-fable-5-2")).toContain("image");
		expect(lookupInputModalities("anthropic/claude-fable-5.2", "https://openrouter.ai/api/v1")).toContain("image");
	});

	it("a model it does not list stays unknown, and a text-only model says so", () => {
		expect(lookupInputModalities("a-model-nobody-lists")).toBeNull();
		const textOnly = Object.entries(MODEL_SNAPSHOT).find(([, r]) => r.input !== null && !r.input.includes("image"));
		expect(textOnly, "the list has text-only models").toBeDefined();
		expect(lookupInputModalities(textOnly![0])).not.toContain("image");
	});

	it("gives a context window only after every row of the table", () => {
		const onlyHere = Object.entries(MODEL_SNAPSHOT).find(([k, r]) => r.window !== null && lookupModelMetadata(k) === null && !k.includes("deepseek") && !k.includes("claude"));
		expect(onlyHere).toBeDefined();
		const w = lookupContextWindow(onlyHere![0]);
		expect(w?.tokens).toBe(onlyHere![1].window);
		expect(w?.from).toContain("kiso.work");
		// a model the table knows keeps the table's figure
		expect(lookupContextWindow("deepseek-flash", "https://api.deepseek.com")?.from).not.toContain("kiso.work");
	});

	it("the generator refuses a short list: a release never ships a partial snapshot", () => {
		expect(() => rowsOf({ models: [{ id: "a/b", inputModalities: ["text"], contextWindow: 1 }] })).toThrow(/full list/);
	});
});
