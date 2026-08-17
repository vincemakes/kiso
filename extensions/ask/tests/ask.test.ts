/**
 * KC3.5 T-Q2 — the ask extension: the schema the registry enforces, the
 * result shapes, and the structural TTY gate.
 *
 * The bounds are not decoration. A model that sends five questions, one
 * option, or a twenty-cell header must meet an HONEST refusal from the
 * L3 registry — ajv's own message, through the ordinary invalid-arguments
 * path — never a crash and never a half-rendered panel. So the schema is
 * validated here exactly as the kernel validates it: `validateArgs`, the
 * same function the tool loop calls.
 *
 * Tested against the BUILT dist/kiso-ask.mjs — the artifact the built-in
 * layer imports.
 */

import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import createAskExtension, { ASK_PARAMETERS } from "../dist/kiso-ask.mjs";

/** The kernel's L3 validation is ajv (core's one runtime dependency), and
 *  its failure reads `<instancePath> <ajv message>`. `validateArgs` is
 *  not public API, so this mirrors it exactly — and the kernel's OWN path
 *  is proven end to end by the cli gate, where an invalid ask_user call
 *  meets the honest refusal in a real session (T-Q3). */
const ajv = new Ajv({ strict: false });
const compiled = ajv.compile(ASK_PARAMETERS as object);
function why(input: unknown): string | null {
	if (compiled(input)) return null;
	const first = compiled.errors?.[0];
	return first ? `${first.instancePath || "/"} ${first.message ?? "is invalid"}` : "arguments failed schema validation";
}

const ctx = { signal: new AbortController().signal };

/** A bridge that records what it was asked and answers with a script. */
function bridge(answer: unknown): { ask: (spec: unknown) => Promise<unknown>; seen: unknown[] } {
	const seen: unknown[] = [];
	return {
		seen,
		ask: async (spec: unknown) => {
			seen.push(spec);
			return answer;
		},
	};
}

const askTool = async (ui?: { ask: (spec: unknown) => Promise<unknown> }) => {
	const ext = await createAskExtension(ui);
	return ext.tools?.find((t) => t.name === "ask_user");
};

const ONE = { question: "which bundler?", options: [{ label: "vite" }, { label: "esbuild" }] };

describe("T-Q2 — the schema: 1-4 questions, 2-4 options, the header cap", () => {
	const valid = why;

	it("the legal shapes pass: one question, four questions, multiSelect, descriptions, a 12-cell header", () => {
		expect(valid({ questions: [ONE] })).toBeNull();
		expect(valid({ questions: [ONE, ONE, ONE, ONE] })).toBeNull();
		expect(
			valid({
				questions: [
					{
						question: "which runners?",
						header: "runners", // ≤ 12
						multiSelect: true,
						options: [{ label: "vitest", description: "fast" }, { label: "node:test" }, { label: "playwright" }, { label: "jest" }],
					},
				],
			}),
		).toBeNull();
		expect(valid({ questions: [{ ...ONE, header: "123456789012" }] })).toBeNull(); // exactly 12
	});

	it("FIVE questions are refused — with an honest message, never a crash", () => {
		const why = valid({ questions: [ONE, ONE, ONE, ONE, ONE] });
		expect(why).not.toBeNull();
		expect(why).toContain("questions");
		expect(why).toContain("4 items");
	});

	it("zero questions, one option, and five options are each refused", () => {
		expect(valid({ questions: [] })).toContain("1 items");
		expect(valid({ questions: [{ question: "q?", options: [{ label: "only" }] }] })).toContain("2 items");
		expect(
			valid({ questions: [{ question: "q?", options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] }] }),
		).toContain("4 items");
	});

	it("a header over 12 cells is refused — the panel's title row is a promise, not a hope", () => {
		const why = valid({ questions: [{ ...ONE, header: "1234567890123" }] });
		expect(why).toContain("header");
		expect(why).toContain("12 characters");
	});

	it("the malformed shapes are refused: no options, empty labels, unknown fields, a missing question", () => {
		expect(valid({ questions: [{ question: "q?" }] })).toContain("options");
		expect(valid({ questions: [{ question: "", options: [{ label: "a" }, { label: "b" }] }] })).toContain("1 character");
		expect(valid({ questions: [{ question: "q?", options: [{ label: "" }, { label: "b" }] }] })).toContain("1 character");
		expect(valid({ questions: [{ ...ONE, urgency: "high" }] })).toContain("additional properties");
		expect(valid({ questions: [{ options: [{ label: "a" }, { label: "b" }] }] })).toContain("question");
		expect(valid({})).toContain("questions");
	});

	it("the tool PUBLISHES that schema — the registry validates the same object the model reads", async () => {
		const tool = await askTool(bridge({ answers: [] }));
		expect(tool!.parameters).toBe(ASK_PARAMETERS);
	});
});

describe("T-Q2 — the tool: idempotent by declaration, JSON by result", () => {
	it("ask_user declares idempotent — asking again is safe, a question has no side effect", async () => {
		const tool = await askTool(bridge({ answers: [] }));
		expect(tool!.idempotent).toBe(true);
	});

	it("the answers come back as ONE JSON tool_result — the three shapes ride it unchanged", async () => {
		const answers = {
			answers: [
				{ q: "which bundler?", choice: "vite" },
				{ q: "which runners?", choices: ["vitest", "playwright"] },
				{ q: "anything else?", custom: "ship it" },
			],
		};
		const ui = bridge(answers);
		const tool = await askTool(ui);
		const result = (await tool!.execute({ questions: [ONE] }, ctx)) as { content: string; isError: boolean };
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual(answers);
		expect(ui.seen).toEqual([{ questions: [ONE] }]); // the spec reaches the panel verbatim
	});

	it("a DECLINE is an outcome, not an error — the result names what went unanswered", async () => {
		const declined = { declined: ["which bundler? (vite, esbuild)"] };
		const tool = await askTool(bridge(declined));
		const result = (await tool!.execute({ questions: [ONE] }, ctx)) as { content: string; isError: boolean };
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content)).toEqual(declined);
	});

	it("an empty question list is refused by the tool too — the guard under the schema", async () => {
		const tool = await askTool(bridge({ answers: [] }));
		const result = (await tool!.execute({ questions: [] }, ctx)) as { content: string; isError: boolean };
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no questions");
	});
});

describe("T-Q2 — the TTY gate is STRUCTURAL: no bridge, no tool", () => {
	it("a factory called with no panel bridge yields the extension with an EMPTY tool list", async () => {
		for (const ui of [undefined, null, {}, { ask: "not a function" }] as unknown[]) {
			const ext = await createAskExtension(ui as never);
			expect(ext.name).toBe("ask");
			expect(ext.tools).toEqual([]);
		}
	});

	it("with a bridge, exactly one tool — named ask_user", async () => {
		const ext = await createAskExtension(bridge({ answers: [] }));
		expect(ext.tools?.map((t) => t.name)).toEqual(["ask_user"]);
	});
});
