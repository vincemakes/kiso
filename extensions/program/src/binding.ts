import type { ToolContext, ToolResult } from "@vincemakes/kiso-core";

export const DEFAULT_MAX_CONCURRENT_CHILDREN = 8;

/**
 * The kernel's window bounds the calls the MODEL issues in one turn; children are not counted in it, so once a host
 * declares a tool `shared` a single `Promise.all` could put the whole call budget on a server at once. The program
 * bounds its own children: at most `max` run at a time, the rest wait their turn (FIFO). A wait is not a refusal.
 */
export function bounded(invoke: NonNullable<ToolContext["invoke"]>, max: number): NonNullable<ToolContext["invoke"]> {
	let running = 0; const waiting: (() => void)[] = [];
	return async (name, input) => {
		if (running >= max) await new Promise<void>((r) => waiting.push(r));
		running += 1;
		try { return await invoke(name, input); } finally { running -= 1; waiting.shift()?.(); }
	};
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
export function guardedInvoke(ctx: ToolContext, source: BindingSource | undefined, maxConcurrent = DEFAULT_MAX_CONCURRENT_CHILDREN): GuardedInvoke {
	const invoke = bounded(ctx.invoke!, maxConcurrent);
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
