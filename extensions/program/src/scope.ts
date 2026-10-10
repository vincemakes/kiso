/**
 * Scope-shaped approval (research prototype, extension level - no kernel change).
 *
 * The program (or plan) call may carry `scope`: the tools it intends to use, optional argument constraints and
 * call counts. The human approves the PROGRAM CALL, and that call's input includes the scope, so the scope is what
 * was approved and it is durable in the log with the call. Then every child call is decided here:
 *   - inside the scope (tool matches, every `where` key matches, the entry's count not used up) -> allow
 *     (this policy's allow beats the tool's own "ask": the human already answered for the whole scope);
 *   - outside it -> deny with the reason (never ask in the middle of a running handler, never widen);
 *   - the program declared no scope -> abstain (nothing changes: a child that needs a human is refused as before).
 * It is a policy in the composed chain, so an explicit deny from any other policy still wins, schema validation
 * still runs before the chain, and every child still gets its own started/receipt.
 */
import type { ApprovalPolicy } from "@vincemakes/kiso-core";

export type ScopeValue = string | number | boolean;
export interface ScopeEntry { readonly tool: string; readonly maxCalls?: number; readonly where?: Readonly<Record<string, ScopeValue | readonly ScopeValue[]>> }

const MAX_ENTRIES = 50;
const isValue = (v: unknown): v is ScopeValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Validate a declared scope. Throws a message the model can act on. undefined = no scope declared. */
export function parseScope(raw: unknown): readonly ScopeEntry[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) throw new Error("scope must be an array of { tool, maxCalls?, where? }");
	if (raw.length > MAX_ENTRIES) throw new Error(`scope has too many entries (limit ${MAX_ENTRIES})`);
	return raw.map((e: unknown, i: number): ScopeEntry => {
		const o = (e ?? {}) as Record<string, unknown>;
		if (typeof o.tool !== "string" || o.tool === "" || o.tool.includes("*")) throw new Error(`scope[${i}]: name an explicit tool (wildcards are not allowed)`);
		if (o.maxCalls !== undefined && !(Number.isInteger(o.maxCalls) && (o.maxCalls as number) >= 1)) throw new Error(`scope[${i}]: maxCalls must be a positive integer`);
		let where: Record<string, ScopeValue | readonly ScopeValue[]> | undefined;
		if (o.where !== undefined) {
			if (o.where === null || typeof o.where !== "object" || Array.isArray(o.where)) throw new Error(`scope[${i}]: where must be an object of argument constraints`);
			where = {};
			for (const [k, v] of Object.entries(o.where as Record<string, unknown>)) {
				if (isValue(v) || (Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(isValue))) where[k] = v as ScopeValue | readonly ScopeValue[];
				else throw new Error(`scope[${i}]: where.${k} must be a string, number, boolean or a list of them`);
			}
		}
		return { tool: o.tool, ...(o.maxCalls !== undefined ? { maxCalls: o.maxCalls as number } : {}), ...(where !== undefined ? { where } : {}) };
	});
}

export const SCOPE_PARAMETER = {
	type: "array",
	description: "Optional. The tools this call will use: [{ tool, maxCalls?, where? }]. where limits arguments, e.g. { project_id: \"p_1\" } or { n: [1, 2] }. The user approves this call together with the scope; a call outside it is denied, never asked.",
	items: { type: "object", properties: { tool: { type: "string" }, maxCalls: { type: "integer" }, where: { type: "object" } }, required: ["tool"] },
} as const;
export const SCOPE_DESCRIPTION = "Declare the tools you will call in `scope` when they need approval: the user approves once, for exactly that scope.";

export class ScopeBook {
	readonly #scopes = new Map<string, { entries: readonly ScopeEntry[]; used: number[] }>();
	register(callId: string, entries: readonly ScopeEntry[]): void { this.#scopes.set(callId, { entries, used: entries.map(() => 0) }); }
	release(callId: string): void { this.#scopes.delete(callId); }

	/** The policy that goes into the extension's `approvals`. `fronts` = the names of the tools that carry a scope. */
	policy(fronts: readonly string[]): ApprovalPolicy {
		return {
			decide: (call, ctx) => {
				const callId = (ctx as { callId?: string }).callId;
				if (callId === undefined) return { action: "abstain" };
				if (fronts.includes(call.name) && !callId.includes("/")) {
					// the program call itself: with a scope declared the human is shown it; a bad scope is refused here, before anything runs
					try { return parseScope(call.input.scope) === undefined ? { action: "abstain" } : { action: "ask" }; } catch (e) { return { action: "deny", reason: (e as Error).message }; }
				}
				if (!callId.includes("/")) return { action: "abstain" };
				const book = this.#scopes.get(callId.split("/")[0]!);
				if (book === undefined) return { action: "abstain" };
				const input = call.input as Record<string, unknown>;
				const hit = book.entries.findIndex((e, i) => e.tool === call.name && (e.maxCalls === undefined || book.used[i]! < e.maxCalls) && Object.entries(e.where ?? {}).every(([k, want]) => (Array.isArray(want) ? want.includes(input[k] as ScopeValue) : want === input[k])));
				if (hit < 0) {
					const approved = book.entries.map((e) => `${e.tool}${e.where ? JSON.stringify(e.where) : ""}${e.maxCalls ? ` x${e.maxCalls}` : ""}`).join(", ");
					return { action: "deny", reason: `outside the approved scope of this program (${call.name} ${JSON.stringify(call.input).slice(0, 120)}); approved: ${approved || "nothing"}. Ask for a new approval with a wider scope.` };
				}
				book.used[hit]! += 1;
				return { action: "allow" };
			},
		};
	}
}
