/**
 * Trusted resource footprints (research, no kernel change; kiso-doc/rfc-resource-effects-2026-10-10.md).
 *
 * The HOST registers, per tool, a resolver: a pure function from the tool's validated input to the resources the call reads and
 * writes. `trustedEffects` turns the table into the `effects` function the engine's scheduler consumes. A program, a plan, the model
 * and a tool description never supply a footprint; only the runtime calls the resolver, on the arguments it is about to send.
 *
 * Anything doubtful falls back to "unknown", which the scheduler treats as a barrier (runs in program order, alone):
 *   no resolver for the tool, an exception, a promise (resolvers are synchronous), a malformed result, a resolver that answers
 *   differently when asked twice (non-deterministic), or an explicit "exclusive". The fallback and its reason are reported.
 *
 * `args` may be partial while a call waits for its inputs (absent fields are unknown): a resolver must answer "exclusive" for a
 * field it needs and does not find. Reads and writes are folded into one key set (reads of a call that also writes are treated as
 * writes: conservative); a call with an empty footprint is not assumed pure - it falls back to unknown.
 */
import type { Effect, Json } from "./ir/types.js";

export type Footprint = { readonly reads?: readonly string[]; readonly writes?: readonly string[]; readonly group?: string } | "exclusive";
export type Resolver = (input: Readonly<Record<string, unknown>>) => Footprint;
export interface FootprintOptions { onFallback?: (tool: string, reason: string) => void; maxKeys?: number }

const keyOk = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 200 && !/[\u0000-\u001f]/.test(k);

export function trustedEffects(resolvers: Readonly<Record<string, Resolver>>, opts: FootprintOptions = {}): (tool: string, args: Json | undefined) => Effect {
	const maxKeys = opts.maxKeys ?? 64;
	const fall = (tool: string, reason: string): Effect => { opts.onFallback?.(tool, reason); return { kind: "unknown" }; };
	const once = (r: Resolver, input: Record<string, unknown>): Footprint | undefined | "bad" => {
		let f: unknown;
		try { f = r(input); } catch { return undefined; }
		if (f !== null && typeof f === "object" && typeof (f as { then?: unknown }).then === "function") return "bad";
		return f as Footprint;
	};
	return (tool, args) => {
		const r = resolvers[tool];
		if (r === undefined) return fall(tool, "no resolver for this tool");
		const input = args !== null && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
		const a = once(r, input), b = once(r, input);
		if (a === undefined || b === undefined) return fall(tool, "the resolver threw");
		if (a === "bad" || b === "bad") return fall(tool, "the resolver is not synchronous");
		if (JSON.stringify(a) !== JSON.stringify(b)) return fall(tool, "the resolver is not deterministic");
		if (a === "exclusive") return fall(tool, "the resolver declared the call exclusive (or an input it needs is not known yet)");
		if (a === null || typeof a !== "object") return fall(tool, "malformed footprint");
		const reads = a.reads ?? [], writes = a.writes ?? [];
		if (!Array.isArray(reads) || !Array.isArray(writes) || ![...reads, ...writes].every(keyOk)) return fall(tool, "malformed footprint");
		if (reads.length + writes.length === 0) return fall(tool, "an empty footprint is not assumed pure");
		if (reads.length + writes.length > maxKeys) return fall(tool, "too many resources in one footprint");
		return writes.length > 0 ? { kind: "write", keys: [...new Set([...reads, ...writes])] } : { kind: "read", keys: [...new Set(reads)] };
	};
}

/** The group a tool's resolver names for rate limiting (static: the resolver is asked with an empty input and must answer with a group even then). */
export function groupOfTool(resolvers: Readonly<Record<string, Resolver>>): (tool: string) => string {
	return (tool) => { try { const f = resolvers[tool]?.({}); return f !== undefined && f !== "exclusive" && f.group !== undefined ? f.group : "(none)"; } catch { return "(none)"; } };
}
