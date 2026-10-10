/**
 * `plan`: the second front-end of the program extension (research). The model writes builder code
 * (src/ir/builder.ts) that DECLARES tool calls; the plan is validated, then the engine runs it —
 * every call as a CHILD CALL through the kernel (`ctx.invoke`), so ledger, approval and crash
 * behaviour are those of the `program` tool; what the engine adds is that independent calls overlap
 * and dependent ones wait, decided by data flow plus effects a TRUSTED host declares.
 */
import { defineTool, type KisoExtension, type Tool, type ToolContext, type ToolResult } from "@vincemakes/kiso-core";
import { run } from "./ir/engine.js";
import { guardedInvoke, type BindingSource } from "./binding.js";
import { parseScope, ScopeBook, SCOPE_DESCRIPTION, SCOPE_PARAMETER, type ScopeOptions } from "./scope.js";
import { buildPlan } from "./ir/builder.js";
import type { CallResult, Effect, Json } from "./ir/types.js";

export const PLAN_DESCRIPTION = [
	"Run a plan: JavaScript that DECLARES tool calls (nothing runs while your code executes; the system then runs the declared calls, in parallel where they do not depend on each other). Only the value you pass to output(...) comes back.",
	"Globals: call(\"tool\", {args}, {after?:[handles], when?:cond}) returns a handle to that call's result; read fields with dots (p.project_id, r.items[0].id) and pass handles inside later args — that is the dependency. map(list, (item) => ...) runs its body once per element (call inside it freely) and yields what you return; filter(list, (item) => cond); pluck(list, \"key\"); until({max:N, init:0}, (state) => ({next, done})) repeats its body until done is true (at most N times; done is judged on the state at the START of each round); let_(value) binds a computed value so you can read fields of it; output(value).",
	"Text works as in JavaScript: \"gen-\" + item.id and `${p.name}-v2` are fine. Numbers and conditions do not: use add(a,b) sum(list) len(x) and not(x) eq(a,b) neq gt gte lt lte and(a,b) or(a,b) isEmpty(x) ifElse(c,a,b) — JavaScript if, ?:, !, && and || on a result are refused (a result is only a handle, always true). list.map(fn), list.filter(fn), list.join(sep) and concat(...parts) work on results. Literals, objects and arrays are fine.",
	"ALL_TOOLS (name + description), describeTool(name) (input schema) and the literal plan code are available while your code runs; some tools are not listed to you and are reachable only here. A failed call skips what depends on it; independent calls still run, and the failures come back with your output. Calls are real and are not undone.",
].join("\n");

export type EffectsFn = (tool: string, args: Json | undefined) => Effect;

export interface PlanOptions {
	/** Trusted effect declarations. Default: every tool is `unknown`, i.e. a barrier (the plan runs in order). */
	effects?: EffectsFn;
	mode?: "sequential" | "parallel";
	maxCalls?: number;
	maxConcurrency?: number;
	/** Checks each tool's live contract against the one the plan was admitted with (see binding.ts). */
	binding?: BindingSource;
	/** Accept a `scope` on the plan call and decide child calls against it (see scope.ts). */
	scope?: boolean | ScopeOptions;
	/** At most this many children at once (default 8); the engine's own `maxConcurrency` also applies. */
	maxConcurrentChildren?: number;
	/** Bytes of output returned before it is cut (the rest is named, not silently dropped). */
	maxOutputBytes?: number;
}

const parseResult = (content: string): Json => { try { return JSON.parse(content) as Json; } catch { return content; } };

export function createPlanExtension(opts: PlanOptions = {}): KisoExtension {
	const book = new ScopeBook(typeof opts.scope === "object" ? opts.scope : {});
	const plan = defineTool<{ code: string; scope?: unknown }>({
		name: "plan",
		description: opts.scope ? `${PLAN_DESCRIPTION}\n${SCOPE_DESCRIPTION}` : PLAN_DESCRIPTION,
		parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript that declares the plan." }, ...(opts.scope ? { scope: SCOPE_PARAMETER } : {}) }, required: ["code"], additionalProperties: false },
		promptSnippet: "plan - declare tool calls; they run in parallel where independent",
		execute: async (input: { code: string; scope?: unknown }, ctx: ToolContext): Promise<ToolResult> => {
			if (ctx.invoke === undefined || ctx.catalog === undefined) return { content: "plan: child tool calls are not available in this execution", isError: true, errorKind: "precondition" };
			const built = await buildPlan(input.code, ctx.catalog());
			if (!built.ok) return { content: built.error, isError: true, errorKind: "precondition" };
			let scope; try { scope = opts.scope ? parseScope(input.scope) : undefined; } catch (e) { return { content: (e as Error).message, isError: true, errorKind: "invalid_input" }; }
			if (scope !== undefined && ctx.callId !== undefined) book.register(ctx.callId, scope);
			const invoke = guardedInvoke(ctx, opts.binding, opts.maxConcurrentChildren);
			try {
			const r = await run(built.program, {
				mode: opts.mode ?? "parallel",
				maxCalls: opts.maxCalls ?? 500,
				...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
				effects: opts.effects ?? (() => ({ kind: "unknown" })),
				call: async (tool, args): Promise<CallResult> => {
					const res = await invoke(tool, (args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>);
					return res.isError ? { ok: false, error: res.content } : { ok: true, value: parseResult(res.content) };
				},
			});
			const lines: string[] = [];
			let body = JSON.stringify(r.output ?? null);
			const cap = opts.maxOutputBytes ?? 20_000;
			if (body.length > cap) body = `${body.slice(0, cap)}… [cut: ${body.length - cap} more characters; ask for less in output()]`;
			lines.push(r.output !== undefined ? `output: ${body}` : "output: none (it depended on a failed step)");
			const skipped = Object.values(r.nodes).filter((n) => n.status === "skipped").length;
			lines.push(`calls made: ${r.started.length - r.errors.filter((e) => e.tool !== undefined).length} ok, ${r.errors.filter((e) => e.tool !== undefined).length} failed${skipped > 0 ? `, ${skipped} step(s) skipped because something they need failed` : ""}; overlapped up to ${r.maxInFlight}`);
			for (const e of r.errors.slice(0, 12)) lines.push(`failed ${e.tool ?? e.id}${e.args !== undefined ? ` ${JSON.stringify(e.args).slice(0, 160)}` : ""}: ${e.error.slice(0, 300)}`);
			if (r.errors.length > 12) lines.push(`… and ${r.errors.length - 12} more failures`);
			if (!r.ok) lines.push("Calls that succeeded were applied and are not undone.");
			return { content: lines.join("\n"), isError: !r.ok };
			} finally { if (ctx.callId !== undefined) book.release(ctx.callId); }
		},
	});
	return { name: "plan", tools: [plan as unknown as Tool], ...(opts.scope ? { approvals: [book.policy(["plan"])], hooks: book.hooks(["plan"]) } : {}), systemPrompt: { append: "Tools you do not see listed (for example those of an MCP server) are reachable through the plan tool: ALL_TOOLS and describeTool(name) list them, call(\"name\", args) calls them." } };
}
