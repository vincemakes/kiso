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
import { createHash } from "node:crypto";
import { ChildLimiter, guardedInvoke, unverifiedNote, type BindingSource } from "./binding.js";
import { parseScope, ScopeBook, SCOPE_DESCRIPTION, SCOPE_PARAMETER, type ScopeOptions } from "./scope.js";
import { runProgram, type ProgramLimits } from "./sandbox.js";

export { runProgram } from "./sandbox.js";
export { ChildLimiter, guardedInvoke, unverifiedNote, type BindingSource, type GuardedInvoke } from "./binding.js";
export { parseScope, scopeDigest, ScopeBook, type ScopeEntry, type ScopeOptions } from "./scope.js";
export { trustedEffects, groupOfTool, type Footprint, type Resolver } from "./footprint.js";
export { createPlanExtension, PLAN_DESCRIPTION, type PlanOptions } from "./plan.js";
export { buildPlan } from "./ir/builder.js";
export { run as runIr, validate as validateIr, conflicts as irConflicts } from "./ir/engine.js";
export type { Program as IrProgram, Effect as IrEffect, RunResult as IrRunResult } from "./ir/types.js";
export type { ProgramHost, ProgramLimits, ProgramResult } from "./sandbox.js";

export const PROGRAM_DESCRIPTION = [
	"Run a JavaScript script that calls tools. Only what the script returns or prints comes back, so use it to do several calls at once and to filter large results before they reach you.",
	"The script is the body of an async function (top-level await and return work). Globals: tools.<name>(args) calls a tool and resolves to its result (parsed JSON when it is JSON), rejecting with an Error on failure; searchTools(query) / ALL_TOOLS / describeTool(name) find tools and show their input schema (some tools are not listed to you and are reachable only here); text(v) and console.log add output; return v returns a value. Use Promise.all for independent calls.",
	"Tool calls are real and are not undone if the script fails later; a failed script reports which calls had completed. No network, files, environment or timers inside the script.",
].join("\n");

const PROMPT_LINE = "Tools you do not see listed (for example those of an MCP server) are reachable through the program tool: in a script, searchTools(\"keywords\") finds them, describeTool(name) shows the schema, tools.<name>(args) calls them.";

export function createProgramExtension(limits: ProgramLimits = {}, opts: { binding?: BindingSource; scope?: boolean | ScopeOptions; maxConcurrentChildren?: number; limiter?: ChildLimiter } = {}): KisoExtension {
	const book = new ScopeBook(typeof opts.scope === "object" ? opts.scope : {});
	const limiter = opts.limiter ?? new ChildLimiter(opts.maxConcurrentChildren !== undefined ? { global: opts.maxConcurrentChildren } : {});
	const program = defineTool<{ code: string; scope?: unknown }>({
		name: "program",
		description: opts.scope ? `${PROGRAM_DESCRIPTION}\n${SCOPE_DESCRIPTION}` : PROGRAM_DESCRIPTION,
		parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript: the body of an async function." }, ...(opts.scope ? { scope: SCOPE_PARAMETER } : {}) }, required: ["code"], additionalProperties: false },
		promptSnippet: "program - run a script that calls tools",
		execute: async (input: { code: string; scope?: unknown }, ctx: ToolContext): Promise<ToolResult> => {
			if (ctx.invoke === undefined || ctx.catalog === undefined) {
				return { content: "program: child tool calls are not available in this execution (the runtime offers no invoke)", isError: true, errorKind: "precondition" };
			}
			let scope; try { scope = opts.scope ? parseScope(input.scope) : undefined; } catch (e) { return { content: (e as Error).message, isError: true, errorKind: "invalid_input" }; }
			if (scope !== undefined && ctx.callId !== undefined) book.register(ctx.callId, scope, input as Record<string, unknown>);
			try {
				const guarded = guardedInvoke(ctx, opts.binding, limiter);
				const r = await runProgram(input.code, { invoke: guarded, catalog: ctx.catalog, signal: ctx.signal }, limits);
				const content = guarded.unverified() > 0 ? `${r.output}\n${unverifiedNote(guarded.unverified())}` : r.output;
				// a failed script may have had effects: a plain failure, so the kernel adds the honest note
				return r.ok ? { content, isError: false } : { content, isError: true };
			} finally { if (ctx.callId !== undefined) book.release(ctx.callId); }
		},
	});
	return { name: "program", tools: [program as unknown as Tool], systemPrompt: { append: PROMPT_LINE }, ...(opts.scope ? { approvals: [book.policy(["program"])], hooks: book.hooks(["program"]) } : {}) };
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

/**
 * HOST policy: declare kernel effects for tools an extension publishes (the MCP bridge declares none, so the kernel runs
 * each of its calls exclusively). `decide(tool)` returns the effects to declare, or undefined to leave the tool as it is.
 * This is the trusted party's statement - the model and the program never get to make it. `concurrency: "shared"` means
 * EVERY invocation of the tool may overlap every other sibling invocation: it is only right for tools the host has
 * checked are free of shared state, rate limits and cost coupling (read-only is necessary, not sufficient).
 */
export function withEffects<E extends KisoExtension>(ext: E, decide: (tool: Tool) => Tool["effects"] | undefined): E {
	const cache = new WeakMap<Tool, Tool>();
	// The declared effects are part of the contract a program is bound to: declaring `shared` (or changing a declaration) changes the digest.
	const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
	const withDigest = (digest: string | undefined, effects: Tool["effects"]): string | undefined => (digest === undefined || effects === undefined || Object.keys(effects).length === 0 ? digest : `sha256:${createHash("sha256").update(`${digest}|${JSON.stringify(canon(effects))}`).digest("hex")}`);
	const effective = (t: Tool): Tool["effects"] => {
		const e = decide(t);
		return e === undefined ? t.effects : { ...t.effects, ...e };
	};
	const wrap = (t: Tool): Tool => {
		let w = cache.get(t);
		if (w === undefined) { const eff = effective(t); const d = withDigest(t.digest, eff); w = decide(t) === undefined && d === t.digest ? t : { ...t, ...(eff !== undefined ? { effects: eff } : {}), ...(d !== undefined ? { digest: d } : {}) }; cache.set(t, w); }
		return w;
	};
	return new Proxy(ext, {
		get(target, key, receiver) {
			if (key === "tools") return (target.tools ?? []).map(wrap);
			if (key === "liveDigest" && typeof (target as { liveDigest?: unknown }).liveDigest === "function") {
				return async (name: string): Promise<string | undefined> => {
					const live = await (target as unknown as { liveDigest(n: string): Promise<string | undefined> }).liveDigest(name);
					const raw = (target.tools ?? []).find((t) => t.name === name);
					return live === undefined || raw === undefined ? live : withDigest(live, effective(raw));
				};
			}
			return Reflect.get(target, key, receiver);
		},
	});
}

/**
 * A BOUNDED wait for an extension that is still connecting (the MCP bridge connects in the
 * background, so a cache-less first request carries none of its tools — findings-mcp-bridge F1).
 * It runs in the async `onUserMessage` hook, which the kernel awaits before the run's first
 * request is assembled (the table is re-snapshotted per request), so the tools are in that
 * snapshot. A kernel line is not needed: the bound is owned by the extension side, as the
 * shell tool owns its foreground wait. It holds only while `ext.connecting` is true, for at most
 * `maxMs`, and passes the message through untouched.
 */
export function connectWait(ext: { readonly name: string; readonly connecting?: boolean }, maxMs = 10_000): KisoExtension {
	return {
		name: `${ext.name}-connect-wait`,
		hooks: {
			onUserMessage: async (msg) => {
				const deadline = Date.now() + maxMs;
				while (ext.connecting === true && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
				return msg;
			},
		},
	};
}

export default createProgramExtension;
