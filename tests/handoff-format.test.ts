/**
 * 0.49.0 C3/I7 — the handoff format: one byte-level contract, two
 * boundary-local renderers. The subagent extension renders a child the
 * parent waited for (the delegate tool's section); the runtime's delivery
 * renders a child the parent heard of later (the group notice). The
 * extension has no runtime dependency, so each carries its own copy.
 *
 * The corpus in fixtures/handoff was written by an independent rendering
 * of the contract, not by either copy: each copy must equal every
 * expected body, not merely the other copy (two copies wrong the same
 * way would agree with each other). The bounds count UTF-8 bytes; the
 * multi-byte cases use the euro sign and an emoji, never CJK (the tree is
 * CJK-free). An expected.txt is the body plus one newline, the tree's
 * end-of-file rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHILD_HANDOFF_BYTES as EXT_CHILD, GROUP_HANDOFF_BYTES as EXT_GROUP, handoffBody as extensionBody, handoffRecordOf as extensionRecord } from "../extensions/subagent/src/kiso-subagent.mjs";
import { CHILD_HANDOFF_BYTES, GROUP_HANDOFF_BYTES, handoffBody as runtimeBody, handoffRecordOf as runtimeRecord, type HandoffInput } from "../packages/runtime/src/tasks/handoff.js";

const CORPUS = fileURLToPath(new URL("./fixtures/handoff/", import.meta.url));

/** `{ "$repeat": [s, n] }` and `{ "$concat": [...] }` keep the inputs small on disk. */
function expand(v: unknown): unknown {
	if (v !== null && typeof v === "object" && !Array.isArray(v)) {
		const o = v as Record<string, unknown>;
		if (Array.isArray(o.$repeat)) return String(o.$repeat[0]).repeat(Number(o.$repeat[1]));
		if (Array.isArray(o.$concat)) return o.$concat.map((x) => expand(x)).join("");
		return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expand(x)]));
	}
	return v;
}

const cases = readdirSync(CORPUS).sort();

describe("0.49.0 I7 — the handoff format, held by an independent corpus", () => {
	it("the corpus is there, and covers the contract's cases", () => {
		expect(cases).toEqual(
			expect.arrayContaining([
				"success-short",
				"success-exact-budget",
				"success-one-over",
				"incomplete-wrap-up",
				"failed-error-and-tail",
				"no-record-tail-only",
				"utf8-answer-cut-euro",
				"utf8-answer-cut-emoji",
				"utf8-tail-cut-euro",
				"group-remainder",
				"group-spent",
				"long-error",
				"empty",
			]),
		);
	});

	it("both copies carry the same budgets: 4 KiB a child, 16 KiB a call or group", () => {
		expect([EXT_CHILD, EXT_GROUP]).toEqual([CHILD_HANDOFF_BYTES, GROUP_HANDOFF_BYTES]);
		expect([CHILD_HANDOFF_BYTES, GROUP_HANDOFF_BYTES]).toEqual([4_096, 16_384]);
	});

	for (const name of cases) {
		it(`${name}: the runtime's and the extension's renderers both equal the expected body`, () => {
			const raw = JSON.parse(readFileSync(join(CORPUS, name, "input.json"), "utf8")) as Record<string, unknown>;
			const { budget, ...input } = expand(raw) as HandoffInput & { budget: number };
			const expected = readFileSync(join(CORPUS, name, "expected.txt"), "utf8").replace(/\n$/, "");
			expect(runtimeBody(input, budget).text, "the runtime's delivery").toBe(expected);
			expect(extensionBody(input, budget).text, "the extension's section").toBe(expected);
			expect(extensionBody(input, budget).bytes).toBe(runtimeBody(input, budget).bytes);
		});
	}

	it("the bytes shown never exceed the budget, and count UTF-8 bytes, not characters", () => {
		for (const name of cases) {
			const { budget, ...input } = expand(JSON.parse(readFileSync(join(CORPUS, name, "input.json"), "utf8"))) as HandoffInput & { budget: number };
			expect(runtimeBody(input, budget).bytes, name).toBeLessThanOrEqual(budget);
		}
		const euro = expand(JSON.parse(readFileSync(join(CORPUS, "utf8-answer-cut-euro", "input.json"), "utf8"))) as HandoffInput & { budget: number };
		const shown = runtimeBody(euro, euro.budget).text.split("\n")[1]!;
		expect(Buffer.byteLength(shown)).toBe(4_095); // 1,365 euro signs; a 1,366th would split at byte 4,096
		expect(shown.length).toBe(1_365);
	});

	it("I5: a record commits the answer — the two readers agree on what a record is", () => {
		for (const raw of [null, "", "{", "[]", "null", '{"outcome":""}', '{"requests":3}', '{"outcome":"completed"}', '{"outcome":"failed","error":"402: no balance"}', '{"outcome":"failed","error":""}']) {
			expect(extensionRecord(raw), String(raw)).toEqual(runtimeRecord(raw));
		}
		expect(runtimeRecord('{"outcome":"completed"}')).toEqual({ outcome: "completed" });
		expect(runtimeRecord('{"requests":3}')).toBeNull();
		expect(runtimeRecord("{")).toBeNull();
	});
});
