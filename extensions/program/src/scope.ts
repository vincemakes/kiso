/**
 * Scope-shaped approval (research prototype, extension level - no kernel change).
 *
 * REQUESTED vs GRANTED (owner's ruling, 2026-10-10/11): the scope a model writes is only a REQUEST. It limits the program (a child outside it is
 * always denied) but it grants nothing by itself. A grant exists only when (a) the program call was approved by a HUMAN (a `permission_decided`
 * without `decidedBy`, for the scope the human was shown), or (b) the host's own `grant(scope, input)` function approved THAT scope. A call some policy
 * simply allowed (a blanket mode, or a policy the host trusts but which never looked at the scope) is not a grant: its in-scope children are decided by their own policies as if no scope had been declared (an `ask` is refused). Grants are keyed by the
 * parent call id and removed when the program ends; they are observed from the event stream, which delivers a decision before the call's `started`.
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
import { createHash } from "node:crypto";
import type { ApprovalPolicy, HookHost } from "@vincemakes/kiso-core";

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

export interface ScopeOptions {
	/**
	 * The host's own judgement of an actual scope (sync, pure). Returning true GRANTS that scope for that call; anything else, or a throw, grants nothing.
	 * There is no grant by name: a policy that merely allows the program call has not reviewed the scope, however much the host trusts it.
	 */
	readonly grant?: (scope: readonly ScopeEntry[], input: Readonly<Record<string, unknown>>) => boolean;
}

/** sha256 of the canonical JSON of a scope: what the human saw is compared with what the program then runs under. */
export function scopeDigest(entries: readonly ScopeEntry[]): string {
	const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
	return `sha256:${createHash("sha256").update(JSON.stringify(canon(entries))).digest("hex")}`;
}

interface Decision { approved: boolean; decidedBy?: string; decisionId: string }

export class ScopeBook {
	readonly #scopes = new Map<string, { entries: readonly ScopeEntry[]; used: number[]; granted: boolean }>();
	readonly #pending = new Set<string>(); // scope-bearing program calls whose decision is still to be observed
	readonly #decisions = new Map<string, Decision>();
	readonly #seenDigest = new Map<string, string>(); // what the human was shown (from permission_requested)
	constructor(readonly opts: ScopeOptions = {}) {}

	/** The grant, if any, for a parent call: the host judged this scope, or a human approved it and the scope is the one the human saw. Fails closed. */
	#grantFor(callId: string, entries: readonly ScopeEntry[], input: Readonly<Record<string, unknown>>): boolean {
		if (this.opts.grant !== undefined) { try { if (this.opts.grant(entries, input) === true) return true; } catch { /* a judge that fails grants nothing */ } }
		const d = this.#decisions.get(callId);
		if (d === undefined || !d.approved || d.decidedBy !== undefined) return false; // only a HUMAN decision (no decidedBy) counts here
		const shown = this.#seenDigest.get(callId);
		return shown !== undefined && shown === scopeDigest(entries); // the human must have been shown exactly this scope
	}
	register(callId: string, entries: readonly ScopeEntry[], input: Readonly<Record<string, unknown>> = {}): void { this.#scopes.set(callId, { entries, used: entries.map(() => 0), granted: this.#grantFor(callId, entries, input) }); }
	release(callId: string): void { this.#scopes.delete(callId); this.#pending.delete(callId); this.#decisions.delete(callId); this.#seenDigest.delete(callId); }
	/** Whether a registered scope is a grant (for tests and audit). */
	isGranted(callId: string): boolean { return this.#scopes.get(callId)?.granted === true; }

	/** Observes how a scope-bearing program call was decided. Add to the extension's hooks. */
	hooks(fronts: readonly string[]): HookHost {
		return {
			onEvent: async (event) => {
				const e = event as unknown as { type: string; callId?: string; name?: string; input?: Record<string, unknown>; decision?: string; decidedBy?: string; decisionId?: string };
				if (e.callId === undefined) return;
				if (e.type === "permission_requested" && e.name !== undefined && fronts.includes(e.name) && this.#pending.has(e.callId)) {
					try { const sc = parseScope(e.input?.scope); if (sc !== undefined) this.#seenDigest.set(e.callId, scopeDigest(sc)); } catch { /* refused elsewhere */ }
				}
				if (e.type === "permission_decided" && this.#pending.has(e.callId)) {
					this.#decisions.set(e.callId, { approved: e.decision === "approved", ...(e.decidedBy !== undefined ? { decidedBy: e.decidedBy } : {}), decisionId: e.decisionId ?? "" });
				}
			},
		};
	}

	/** The policy that goes into the extension's `approvals`. `fronts` = the names of the tools that carry a scope. */
	policy(fronts: readonly string[]): ApprovalPolicy {
		return {
			decide: (call, ctx) => {
				const callId = (ctx as { callId?: string }).callId;
				if (callId === undefined) return { action: "abstain" };
				// a child is `<registered running parent>/<number>`: matched against the parents this book knows, never by "contains a slash" (a provider id may)
				const parentId = [...this.#scopes.keys()].find((id) => callId.startsWith(`${id}/`) && /^\d+$/.test(callId.slice(id.length + 1)));
				if (parentId === undefined && fronts.includes(call.name)) {
					// the program call itself: with a scope declared the human is shown it; a bad scope is refused here, before anything runs
					try {
						if (parseScope(call.input.scope) === undefined) return { action: "abstain" };
						this.#pending.add(callId); this.#decisions.delete(callId); this.#seenDigest.delete(callId); // a reused call id must not inherit an old grant
						return { action: "ask" };
					} catch (e) { return { action: "deny", reason: (e as Error).message }; }
				}
				if (parentId === undefined) return { action: "abstain" };
				const book = this.#scopes.get(parentId);
				if (book === undefined) return { action: "abstain" };
				const input = call.input as Record<string, unknown>;
				const hit = book.entries.findIndex((e, i) => e.tool === call.name && (e.maxCalls === undefined || book.used[i]! < e.maxCalls) && Object.entries(e.where ?? {}).every(([k, want]) => (Array.isArray(want) ? want.includes(input[k] as ScopeValue) : want === input[k])));
				if (hit < 0) {
					const approved = book.entries.map((e) => `${e.tool}${e.where ? JSON.stringify(e.where) : ""}${e.maxCalls ? ` x${e.maxCalls}` : ""}`).join(", ");
					return { action: "deny", reason: `outside the ${book.granted ? "approved" : "requested"} scope of this program (${call.name} ${JSON.stringify(call.input).slice(0, 120)}); declared: ${approved || "nothing"}. Ask for a new approval with a wider scope.` };
				}
				if (!book.granted) return { action: "abstain" }; // in the request, but nobody granted it: the tool's own policy decides
				book.used[hit]! += 1;
				return { action: "allow" };
			},
		};
	}
}
