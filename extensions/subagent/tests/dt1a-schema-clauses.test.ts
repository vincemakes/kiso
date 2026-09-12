import { describe, expect, it } from "vitest";
import createSubagentExtension from "../src/kiso-subagent.mjs";

/**
 * PR-1c T1: the DELEGATE SCHEMA'S CONTRACT CLAUSES, pinned before the
 * schema is compacted.
 *
 * The DT-1a delegation contract lives in four `description` strings on
 * `delegate`'s parameters, and NOTHING asserted on them.
 * `tests/tool-schema-closed-world.test.ts` exercises the tool, but it
 * checks STRUCTURE — that `additionalProperties: false` rejects an
 * invented field. A compaction that keeps every field and deletes the
 * sentence saying a scoped child has no shell passes it clean.
 *
 * WHAT THIS TEST CAN AND CANNOT DO, said plainly: a test cannot read
 * meaning. So each clause is pinned as the FACTS it must state, each fact
 * as an alternation over the ways it can honestly be worded. A rewording
 * that keeps the facts passes; a compaction that drops one fails and
 * names it. That is weaker than "the semantics are preserved" and
 * stronger than nothing, which is what was there before.
 *
 * If a clause must genuinely change, this test is re-pinned with a
 * DECLARED SUPERSESSION naming what changed and why — never quietly
 * updated to match new text.
 */

interface Schema {
	readonly properties: { readonly tasks: { readonly items: { readonly properties: Record<string, { readonly description?: string; readonly enum?: readonly string[] }> } } };
}

async function delegateParams(): Promise<Schema> {
	const prev = process.env.KISO_SUBAGENT_DEPTH;
	delete process.env.KISO_SUBAGENT_DEPTH; // depth 0 — the tool exists
	const ext = await createSubagentExtension();
	if (prev !== undefined) process.env.KISO_SUBAGENT_DEPTH = prev;
	const tool = (ext.tools ?? []).find((t: { name: string }) => t.name === "delegate");
	expect(tool, "the delegate tool exists at depth 0").toBeDefined();
	return (tool as { parameters: Schema }).parameters;
}

/** Each fact: a name, and the ways it may honestly be worded. */
const CLAUSES: ReadonlyArray<{ readonly field: string; readonly facts: ReadonlyArray<readonly [string, RegExp]> }> = [
	{
		field: "scope",
		facts: [
			["scope is the child's allowed WRITE paths", /write|writable/i],
			["a scoped child has NO shell", /no shell|without shell|shell is removed|loses (the )?shell/i],
			["explorer and reviewer with scope are REFUSED", /(explorer|reviewer)[^.]*refus|refus[^.]*(explorer|reviewer)/i],
			["a write outside the scope is refused", /outside[^.]*(refus|denied)|refus[^.]*outside/i],
		],
	},
	{
		field: "acceptance",
		facts: [
			["exactly one of check or evaluator", /exactly one|one of/i],
			["check names something the USER configured", /configur/i],
			["evaluator is a path OUTSIDE the project", /outside the project/i],
			["acceptance is NEVER a command", /never a command|not a command/i],
			["the PARENT runs it after the child completes", /parent runs|run by the parent/i],
		],
	},
	{
		field: "model",
		facts: [["model names a profile the USER configured", /configur/i]],
	},
	{
		field: "after",
		facts: [
			["tester only", /tester only|only.{0,12}tester/i],
			["names an earlier task, 1-based", /1-based|index/i],
			["the tester runs in THAT worktree", /worktree/i],
		],
	},
];

describe("DT-1a: the delegate schema states its contract", () => {
	it("the four roles are still the enum", async () => {
		const p = await delegateParams();
		expect(p.properties.tasks.items.properties.role?.enum).toEqual(["explorer", "implementer", "reviewer", "tester"]);
	});

	for (const { field, facts } of CLAUSES) {
		for (const [name, pattern] of facts) {
			it(`${field}: ${name}`, async () => {
				const p = await delegateParams();
				const text = p.properties.tasks.items.properties[field]?.description ?? "";
				expect(text, `delegate.${field} has a description`).not.toBe("");
				expect(text, `delegate.${field} must state: ${name}\n  got: ${text}`).toMatch(pattern);
			});
		}
	}
});
