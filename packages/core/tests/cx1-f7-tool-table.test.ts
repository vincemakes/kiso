/**
 * CX-1 F7 — live extension tools are never frozen; one table per request.
 *
 * The agent eagerly registered an extension's startup (cached) tools as
 * static entries AND registered the live source; static entries won
 * every lookup, so a background refresh (the MCP bridge replacing its
 * cached definitions) was masked and the model kept the old schema
 * (audit F7). The registry gains `snapshot()`: a captured table — the
 * definition sent to the model, the schema validated against, the
 * execute that runs, the effects the scheduler reads — taken once per
 * request. Two sources publishing one name is an error at the moment
 * it is observed, never a traversal-order pick.
 */

import { describe, expect, it } from "vitest";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";

function tool(name: string, description: string): Tool {
	return defineTool({ name, description, parameters: { type: "object", properties: {} }, execute: async () => ({ content: description, isError: false }) });
}

describe("CX-1 F7 — the registry snapshot", () => {
	it("a live refresh reaches the next snapshot: the fresh schema replaces the cached one, a removed tool is gone", () => {
		const live: Tool[] = [tool("mcp__s__a", "cached a"), tool("mcp__s__b", "cached b")];
		const reg = new ToolRegistry();
		reg.registerLive(() => live, "mcp");
		const t1 = reg.snapshot();
		expect(t1.specs.map((s) => s.description)).toEqual(["cached a", "cached b"]);
		// the bridge replaces its cached definitions in place (splice + push)
		live.splice(0, live.length, tool("mcp__s__a", "fresh a"));
		const t2 = reg.snapshot();
		expect(t2.specs.map((s) => s.description)).toEqual(["fresh a"]);
		expect(t2.get("mcp__s__b")).toBeUndefined();
	});

	it("a snapshot is CAPTURED: a change after assembly does not reach the table that was advertised", async () => {
		const live: Tool[] = [tool("x", "advertised")];
		const reg = new ToolRegistry();
		reg.registerLive(() => live, "ext");
		const table = reg.snapshot();
		live.splice(0, 1, tool("x", "changed under the request"));
		expect(table.specs[0]!.description).toBe("advertised");
		const captured = table.get("x")!;
		expect((await captured.execute({}, { signal: new AbortController().signal })).content).toBe("advertised");
	});

	it("two sources publishing one name → a loud error naming both owners, never a traversal-order pick", () => {
		const reg = new ToolRegistry();
		reg.registerLive(() => [tool("dup", "from alpha")], "alpha");
		reg.registerLive(() => [tool("dup", "from beta")], "beta");
		expect(() => reg.snapshot()).toThrow(/dup.*alpha.*beta|dup.*beta.*alpha/);
	});

	it("a built-in and a live source sharing a name is the same error — unless it is the SAME tool object (the 0.1.27 dedup)", () => {
		const reg = new ToolRegistry();
		const shared = tool("same", "one object");
		reg.register(shared);
		reg.registerLive(() => [shared], "ext");
		expect(reg.snapshot().specs.filter((s) => s.name === "same")).toHaveLength(1); // identity dedup stands
		const reg2 = new ToolRegistry();
		reg2.register(tool("clash", "built-in"));
		reg2.registerLive(() => [tool("clash", "extension")], "ext");
		expect(() => reg2.snapshot()).toThrow(/clash/);
	});

	it("the review's in-place shape (2026-09-07 P2): editing the SOURCE's nested schema and effects after the snapshot does not reach the table — advertised, validated and scheduled values are the captured ones", () => {
		const schema = { type: "object", properties: { target: { type: "string" } } };
		const effects: { precommitSafe?: true } = {};
		const reg = new ToolRegistry();
		reg.register({ name: "x", description: "x", parameters: schema, effects, execute: async () => ({ content: "x", isError: false }) } as never);
		const table = reg.snapshot();
		const before = JSON.stringify(table.specs);
		(schema.properties.target as { type: string }).type = "number";
		effects.precommitSafe = true;
		expect(JSON.stringify(table.specs)).toBe(before); // the advertised schema did not move
		expect((table.get("x")!.parameters as typeof schema).properties.target.type).toBe("string"); // nor the one validated against
		expect(table.get("x")!.effects?.precommitSafe).toBeUndefined(); // nor what the scheduler reads
		expect(table.get("x")!.execute).toBeTypeOf("function"); // the handler is by reference
		expect(reg.snapshot().specs[0]!.inputSchema).toEqual({ type: "object", properties: { target: { type: "number" } } }); // the NEXT request sees the edit
	});
});
