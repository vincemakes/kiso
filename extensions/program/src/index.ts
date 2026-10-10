/**
 * kiso-program-ext — RESEARCH BRANCH ONLY.
 *
 * `program`: the model writes a script; the script calls tools; only the script's
 * output returns to the model. Every tool call the script makes is a CHILD CALL
 * run through the kernel (`ctx.invoke`): schema validation, the approval chain,
 * a write-ahead `started`, a receipt — so a crash in the middle of a script
 * leaves the same honest ledger a direct call would (kiso-doc/program-invariants.md).
 *
 * Tools marked `hidden` are not declared to the model; the script finds them with
 * `searchTools` / `ALL_TOOLS` and calls them with `tools.<name>(args)`.
 */
import { defineTool, type KisoExtension, type Tool, type ToolContext, type ToolResult } from "@vincemakes/kiso-core";
import { runProgram, type ProgramLimits } from "./sandbox.js";

export { runProgram } from "./sandbox.js";
export type { ProgramHost, ProgramLimits, ProgramResult } from "./sandbox.js";

export const PROGRAM_DESCRIPTION = [
	"Run a JavaScript script that calls tools. Only what the script returns or prints comes back, so use it to do several calls at once and to filter large results before they reach you.",
	"The script is the body of an async function (top-level await and return work). Globals: tools.<name>(args) calls a tool and resolves to its result (parsed JSON when it is JSON), rejecting with an Error on failure; searchTools(query) / ALL_TOOLS / describeTool(name) find tools and show their input schema (some tools are not listed to you and are reachable only here); text(v) and console.log add output; return v returns a value. Use Promise.all for independent calls.",
	"Tool calls are real and are not undone if the script fails later; a failed script reports which calls had completed. No network, files, environment or timers inside the script.",
].join("\n");

const PROMPT_LINE = "Tools you do not see listed (for example those of an MCP server) are reachable through the program tool: in a script, searchTools(\"keywords\") finds them, describeTool(name) shows the schema, tools.<name>(args) calls them.";

export function createProgramExtension(limits: ProgramLimits = {}): KisoExtension {
	const program = defineTool<{ code: string }>({
		name: "program",
		description: PROGRAM_DESCRIPTION,
		parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript: the body of an async function." } }, required: ["code"], additionalProperties: false },
		promptSnippet: "program - run a script that calls tools",
		execute: async (input: { code: string }, ctx: ToolContext): Promise<ToolResult> => {
			if (ctx.invoke === undefined || ctx.catalog === undefined) {
				return { content: "program: child tool calls are not available in this execution (the runtime offers no invoke)", isError: true, errorKind: "precondition" };
			}
			const r = await runProgram(input.code, { invoke: ctx.invoke, catalog: ctx.catalog, signal: ctx.signal }, limits);
			// a failed script may have had effects: a plain failure, so the kernel adds the honest note
			return r.ok ? { content: r.output, isError: false } : { content: r.output, isError: true };
		},
	});
	return { name: "program", tools: [program], systemPrompt: { append: PROMPT_LINE } };
}

/**
 * Hide every tool an extension publishes from the model (they stay callable by a
 * program). The extension's `tools` array may grow after load (the MCP bridge
 * connects in the background), so the view is computed on each read, with a
 * stable object per original tool (the registry de-duplicates by identity).
 */
export function hideTools<E extends KisoExtension>(ext: E): E {
	const cache = new WeakMap<Tool, Tool>();
	const hide = (t: Tool): Tool => {
		let h = cache.get(t);
		if (h === undefined) { h = { ...t, hidden: true }; cache.set(t, h); }
		return h;
	};
	return new Proxy(ext, {
		get(target, key, receiver) {
			if (key === "tools") return (target.tools ?? []).map(hide);
			return Reflect.get(target, key, receiver);
		},
	});
}

export default createProgramExtension;
