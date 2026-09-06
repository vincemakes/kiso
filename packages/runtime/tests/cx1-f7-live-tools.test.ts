/**
 * CX-1 F7a — an extension's live tool table is never frozen.
 *
 * The agent eagerly registered an extension's startup (cached) tools as
 * static entries and ALSO registered the live source; static entries
 * won every lookup, so a background refresh (the MCP bridge replacing
 * its cached definitions in place) was masked: the adapter kept
 * receiving the cached schema, and a removed tool stayed visible
 * (audit F7). Now extension tools are reached only through their live
 * source, captured once per request.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type StreamOptions, type Tool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

function tool(name: string, description: string): Tool {
	return defineTool({ name, description, parameters: { type: "object", properties: {} }, execute: async () => ({ content: description, isError: false }) });
}

/** Records the tool table each request advertised; answers end_turn. */
function capturing(): { adapter: Adapter; seen: string[][] } {
	const seen: string[][] = [];
	const adapter = {
		async *stream(opts: StreamOptions): AsyncIterable<AdapterEvent> {
			seen.push((opts.tools ?? []).map((t) => `${t.name}:${t.description}`));
			yield { type: "stop", reason: "end_turn", seq: 0 } as unknown as AdapterEvent;
		},
	} as unknown as Adapter;
	return { adapter, seen };
}

describe("CX-1 F7a — the live table reaches the model", () => {
	it("a cached definition replaced before the run → the adapter receives the FRESH schema; a removed tool is absent", async () => {
		const live: Tool[] = [tool("mcp__s__a", "cached a"), tool("mcp__s__b", "cached b")];
		const { adapter, seen } = capturing();
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cx1-f7-")));
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			extensions: [{ name: "mcp", tools: live }],
		});
		// the bridge's background refresh: replace in place (splice + push)
		live.splice(0, live.length, tool("mcp__s__a", "fresh a"));
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("go")) {
			/* drain */
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("mcp__s__a:fresh a");
		expect(seen[0]!.some((s) => s.startsWith("mcp__s__b:"))).toBe(false);
	});

	it("a startup tool colliding with a built-in still throws at agent creation (the loud failure stays)", () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cx1-f7c-")));
		expect(() =>
			createAgent({
				model: "faux",
				store,
				tools: [tool("clash", "built-in")],
				adapter: capturing().adapter,
				extensions: [{ name: "ext", tools: [tool("clash", "extension")] }],
			}),
		).toThrow(/clash/);
	});
});
