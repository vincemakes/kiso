import type { ToolContext, ToolResult } from "@vincemakes/kiso-core";

export const DEFAULT_MAX_CONCURRENT_CHILDREN = 8;

/**
 * The kernel's window bounds the calls the MODEL issues in one turn; children are not counted in it, so once a host
 * declares a tool `shared` one `Promise.all` could put the whole call budget on a server at once. A limiter bounds children
 * AGENT-WIDE: one instance is shared by every program/plan execution of an extension (and by several extensions when the host
 * passes the same one), with an optional per-group bound (default group = the MCP server a tool belongs to) inside the global one.
 * A wait is FIFO and is not a refusal. It bounds what this process sends; a remote rate limit shared with OTHER clients is
 * still the server's to enforce.
 */
export class ChildLimiter {
	readonly #global: number; readonly #perGroup: number | undefined; readonly #groupOf: (tool: string) => string;
	#running = 0; readonly #inGroup = new Map<string, number>(); readonly #waiting: { group: string; go: () => void }[] = [];
	constructor(opts: { global?: number; perGroup?: number; groupOf?: (tool: string) => string } = {}) {
		this.#global = opts.global ?? DEFAULT_MAX_CONCURRENT_CHILDREN; this.#perGroup = opts.perGroup;
		this.#groupOf = opts.groupOf ?? ((t) => /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t)?.[1] ?? "(local)");
	}
	#room(group: string): boolean { return this.#running < this.#global && (this.#perGroup === undefined || (this.#inGroup.get(group) ?? 0) < this.#perGroup); }
	#take(group: string): void { this.#running += 1; this.#inGroup.set(group, (this.#inGroup.get(group) ?? 0) + 1); }
	#pump(): void { for (let i = 0; i < this.#waiting.length; i += 1) { const w = this.#waiting[i]!; if (this.#room(w.group)) { this.#waiting.splice(i, 1); this.#take(w.group); w.go(); i -= 1; } } }
	async run<T>(tool: string, fn: () => Promise<T>): Promise<T> {
		const group = this.#groupOf(tool);
		if (this.#waiting.length > 0 || !this.#room(group)) await new Promise<void>((go) => { this.#waiting.push({ group, go }); this.#pump(); });
		else this.#take(group);
		try { return await fn(); } finally { this.#running -= 1; this.#inGroup.set(group, (this.#inGroup.get(group) ?? 1) - 1); this.#pump(); }
	}
}

/** Where a program can ask what a tool IS right now (the MCP bridge: a fresh tools/list). */
export interface BindingSource {
	liveDigest(toolName: string): Promise<string | undefined>;
	/**
	 * `audit` (default): a check that cannot be made lets the call run and is COUNTED (the result says so).
	 * `enforce`: the binding is checked before EVERY call; a check that cannot be made, or a tool with no digest
	 * (unless listed in `allowUnbound`), refuses the call before it starts.
	 */
	readonly mode?: "audit" | "enforce";
	readonly allowUnbound?: readonly string[];
	/** audit mode only: when to re-ask: `after-failure` (default: before the first use of a tool, and again after a call to it failed) or `every-call` */
	readonly recheck?: "after-failure" | "every-call";
}

export type GuardedInvoke = NonNullable<ToolContext["invoke"]> & { unverified(): number };

/** The line a program/plan result carries when calls ran without a verified binding (audit mode). */
export const unverifiedNote = (n: number): string => `Note: ${n} tool call${n === 1 ? "" : "s"} ran without a verified tool binding (the server was not asked, or could not answer); the contract those calls ran under is not confirmed.`;

/**
 * `ctx.invoke` with a binding check in front. The program was admitted against the request's tool table (each catalog entry
 * may carry the provider's `digest`); the live contract is fetched and compared. A difference refuses the call BEFORE it starts:
 * no `started`, no effect, an explicit message. Modes: see BindingSource. Even `enforce` cannot close the window between the check
 * and the server acting on the call, and a digest proves the DECLARATION unchanged, not the server's behaviour.
 */
export function guardedInvoke(ctx: ToolContext, source: BindingSource | undefined, limiter: ChildLimiter = new ChildLimiter()): GuardedInvoke {
	const raw = ctx.invoke!;
	const invoke: NonNullable<ToolContext["invoke"]> = (name, input) => limiter.run(name, () => raw(name, input));
	let unverified = 0;
	const out = (async (name, input): Promise<ToolResult> => {
		if (source === undefined || ctx.catalog === undefined) return invoke(name, input);
		const enforce = source.mode === "enforce";
		const refuse = (content: string): ToolResult => ({ content, isError: true, errorKind: "precondition" });
		const admitted = ctx.catalog().find((t) => t.name === name)?.digest;
		if (admitted === undefined) {
			if (enforce && !(source.allowUnbound ?? []).includes(name)) return refuse(`${name} has no binding digest, so its contract cannot be checked: enforce mode only runs tools bound to a contract; nothing was called`);
			unverified += 1;
			return invoke(name, input);
		}
		const every = enforce || source.recheck === "every-call";
		let v = every ? undefined : verdicts.get(name);
		if (v === undefined) {
			v = source.liveDigest(name).then((live): Verdict => (live === undefined ? { kind: "unknown" } : live !== admitted ? { kind: "changed", live } : { kind: "same" }), (): Verdict => ({ kind: "unknown" }));
			if (!every) verdicts.set(name, v);
		}
		const verdict = await v;
		if (verdict.kind === "changed") return refuse(`${name} changed since this program was admitted (bound ${short(admitted)}, the server now reports ${short(verdict.live)}); nothing was called`);
		if (verdict.kind === "unknown") {
			if (enforce) return refuse(`${name}: the tool's binding could not be verified (the server did not answer a fresh tool listing); enforce mode refuses the call; nothing was called`);
			unverified += 1;
		}
		const result = await invoke(name, input);
		if (result.isError) verdicts.delete(name); // ask again before the next call
		return result;
	}) as GuardedInvoke;
	const verdicts = new Map<string, Promise<Verdict>>();
	out.unverified = () => unverified;
	return out;
}

type Verdict = { kind: "same" } | { kind: "unknown" } | { kind: "changed"; live: string };
const short = (d: string): string => d.replace("sha256:", "").slice(0, 10);
