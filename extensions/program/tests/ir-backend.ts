/**
 * A deterministic key-value world for the engine tests: every observable consequence of a
 * schedule (results, final state, per-key write order, which calls ran) is recoverable from it.
 * Failures are a pure function of (seed, tool, args), so they hit the same calls whatever the
 * schedule; an `incr` that fails still applies half the time (a partial effect).
 */
import type { CallResult, Effect, Json } from "../src/ir/types.js";

const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export class World {
	state = new Map<string, number>();
	/** per key: the writes applied, in the order they were applied */
	writes = new Map<string, string[]>();
	constructor(readonly seed: number, readonly failPct: number, readonly delayMs = 2) {}

	private applied(key: string, what: string): void { (this.writes.get(key) ?? this.writes.set(key, []).get(key)!).push(what); }
	private fails(tool: string, args: Json): boolean { return this.failPct > 0 && hash(`${this.seed}|${tool}|${JSON.stringify(args)}`) % 100 < this.failPct; }

	async call(tool: string, args: Json): Promise<CallResult> {
		await new Promise((r) => setTimeout(r, Math.floor(Math.random() * this.delayMs)));
		const a = (args ?? {}) as Record<string, Json>;
		const bad = this.fails(tool, args);
		const keyOf = (): string => String(a.k);
		switch (tool) {
			case "get": case "legacy": return bad ? { ok: false, error: "get failed" } : { ok: true, value: this.state.get(keyOf()) ?? 0 };
			case "put": {
				if (bad) return { ok: false, error: "put failed" };
				this.state.set(keyOf(), Number(a.v)); this.applied(keyOf(), `put ${a.v}`); return { ok: true, value: Number(a.v) };
			}
			case "incr": {
				const apply = !bad || hash(`${this.seed}|half|${JSON.stringify(args)}`) % 2 === 0;
				let v = this.state.get(keyOf()) ?? 0;
				if (apply) { v += 1; this.state.set(keyOf(), v); this.applied(keyOf(), "incr"); }
				return bad ? { ok: false, error: "incr failed" } : { ok: true, value: v };
			}
			case "sum": return bad ? { ok: false, error: "sum failed" } : { ok: true, value: (a.ks as string[]).reduce((s, k) => s + (this.state.get(k) ?? 0), 0) };
			case "dump": return bad ? { ok: false, error: "dump failed" } : { ok: true, value: Object.fromEntries([...this.state].sort(([x], [y]) => (x < y ? -1 : 1))) };
			case "ping": return bad ? { ok: false, error: "ping failed" } : { ok: true, value: (a.x as Json) ?? null };
			default: return { ok: false, error: `unknown tool ${tool}` };
		}
	}

	/** the trusted declaration: what each tool does to which keys */
	effects(tool: string, args: Json | undefined): Effect {
		const a = (args ?? undefined) as Record<string, Json> | undefined;
		const key = (): string[] | "*" => (a && typeof a.k === "string" ? [a.k] : "*");
		switch (tool) {
			case "get": return { kind: "read", keys: key() };
			case "put": case "incr": return { kind: "write", keys: key() };
			case "sum": return { kind: "read", keys: a && Array.isArray(a.ks) ? (a.ks as string[]) : "*" };
			case "dump": return { kind: "read", keys: "*" };
			case "ping": return { kind: "pure" };
			default: return { kind: "unknown" }; // `legacy` and anything undeclared
		}
	}

	snapshot(): { state: [string, number][]; writes: [string, string[]][] } {
		return { state: [...this.state].sort(([x], [y]) => (x < y ? -1 : 1)), writes: [...this.writes].sort(([x], [y]) => (x < y ? -1 : 1)) };
	}
}
