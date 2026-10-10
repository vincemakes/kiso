import type { ToolContext, ToolResult } from "@vincemakes/kiso-core";

/** Where a program can ask what a tool IS right now (the MCP bridge: a fresh tools/list). */
export interface BindingSource {
	liveDigest(toolName: string): Promise<string | undefined>;
	/** when to re-ask: `after-failure` (default: before the first use of a tool, and again after a call to it failed) or `every-call` */
	readonly recheck?: "after-failure" | "every-call";
}

/**
 * `ctx.invoke` with a binding check in front. The program was admitted against the request's tool table (each catalog
 * entry may carry the provider's `digest`); before the FIRST use of a tool in this execution - and again after a call
 * to it failed (a server that changes mid-program usually starts by rejecting), or before every call when
 * `recheck: "every-call"` - the live contract is fetched and compared. A difference refuses the call before anything starts: no `started`, no effect, an explicit
 * error. A tool with no admitted digest, or a source that cannot say, is not guarded (the call, if it fails, fails by
 * itself). A digest proves the DECLARATION is unchanged, not that the server's behaviour is.
 */
export function guardedInvoke(ctx: ToolContext, source: BindingSource | undefined): NonNullable<ToolContext["invoke"]> {
	const invoke = ctx.invoke!;
	if (source === undefined || ctx.catalog === undefined) return invoke;
	const verdicts = new Map<string, Promise<string | undefined>>();
	const short = (d: string): string => d.replace("sha256:", "").slice(0, 10);
	return async (name, input): Promise<ToolResult> => {
		const admitted = ctx.catalog!().find((t) => t.name === name)?.digest;
		if (admitted !== undefined) {
			let v = verdicts.get(name);
			if (v === undefined) { v = source.liveDigest(name).then((live) => (live !== undefined && live !== admitted ? `${name} changed since this program was admitted (bound ${short(admitted)}, the server now reports ${short(live)}); nothing was called` : undefined), () => undefined); verdicts.set(name, v); }
			const refusal = await v;
			if (refusal !== undefined) return { content: refusal, isError: true, errorKind: "precondition" };
		}
		const result = await invoke(name, input);
		if (result.isError || source.recheck === "every-call") verdicts.delete(name); // ask again before the next call
		return result;
	};
}
