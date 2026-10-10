/**
 * Scheduler lab (A2, no model, no spend): a domain server with REAL concurrency — every call takes
 * wall time, a read-modify-write on one key is not atomic (two overlapping increments lose an
 * update), a concurrency limit refuses the excess, and chosen calls fail. Scenarios are run by
 * executors that differ only in who decides the execution strategy:
 *
 *   js-seq      plain JavaScript, `await` one call at a time (the safe, slow baseline)
 *   js-naive    plain JavaScript, Promise.all over everything (what an unaware author writes)
 *   js-best     plain JavaScript written by someone who knows the hazards of THIS scenario
 *               (per-key chains, a worker pool at the limit, per-chain error handling)
 *   ir-seq      the logical program, sequential schedule (no optimisation)
 *   ir-par      the logical program, conflict-aware parallel schedule (declared effects)
 *
 * CORRECTNESS FIRST: an executor is correct when its final world state equals the reference run
 * (js-seq on a zero-latency server) and no call was refused or lost. Speed is reported only next
 * to that verdict.
 */
import { buildPlan } from "../src/ir/builder.js";
import { run } from "../src/ir/engine.js";
import type { Effect, Json } from "../src/ir/types.js";

export interface LabOpts { latencyMs: number; limit?: number | undefined; failPut?: (k: string) => boolean }
export class Lab {
	state = new Map<string, number>();
	calls = 0; refused = 0; lost = 0; inflight = 0; maxInflight = 0; failed = 0;
	log: string[] = [];
	directory = new Map<string, string>(); // email -> customer id: a record reachable by two names
	constructor(readonly o: LabOpts, seed: Record<string, number> = {}) { for (const [k, v] of Object.entries(seed)) this.state.set(k, v); }
	private sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
	async call(tool: string, a: Record<string, Json>): Promise<{ ok: boolean; value?: Json; error?: string }> {
		this.calls++;
		if (this.o.limit !== undefined && this.inflight >= this.o.limit) { this.refused++; return { ok: false, error: "rate_limited" }; }
		this.inflight++; this.maxInflight = Math.max(this.inflight, this.maxInflight);
		this.log.push(`start ${tool} ${JSON.stringify(a)}`);
		try {
			await this.sleep(this.o.latencyMs);
			const k = String(a.k ?? "");
			if (tool === "get") return { ok: true, value: { k, v: this.state.get(k) ?? 0 } };
			if (tool === "incr") {
				const before = this.state.get(k) ?? 0;
				await this.sleep(this.o.latencyMs); // the non-atomic read-modify-write window
				const now = this.state.get(k) ?? 0;
				if (now !== before) this.lost++; // someone else wrote in between: this write overwrites theirs
				this.state.set(k, before + 1);
				return { ok: true, value: before + 1 };
			}
			if (tool === "update_customer" || tool === "update_by_email") {
				const id = tool === "update_customer" ? String(a.customer_id ?? "") : this.directory.get(String(a.email ?? "")) ?? "";
				if (id === "") return { ok: false, error: "unknown customer" };
				const key = `customer:${id}`;
				const before = this.state.get(key) ?? 0;
				await this.sleep(this.o.latencyMs); // non-atomic read-modify-write
				if ((this.state.get(key) ?? 0) !== before) this.lost++;
				this.state.set(key, before + 1);
				return { ok: true, value: before + 1 };
			}
			if (tool === "put") {
				if (this.o.failPut?.(k)) { this.failed++; return { ok: false, error: "boom" }; }
				this.state.set(k, Number(a.v ?? 0)); return { ok: true, value: Number(a.v ?? 0) };
			}
			return { ok: false, error: `unknown tool ${tool}` };
		} finally { this.inflight--; this.log.push(`end ${tool} ${JSON.stringify(a)}`); }
	}
}

export const effects = (tool: string, args: Json | undefined): Effect => {
	const a = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, Json>) : undefined;
	const keys: string[] | "*" = a && a.k !== undefined ? [String(a.k)] : "*";
	return tool === "get" ? { kind: "read", keys } : { kind: "write", keys };
};
export const CATALOG = ["get", "incr", "put", "update_customer", "update_by_email"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

export type Exec = "js-seq" | "js-naive" | "js-best" | "ir-seq" | "ir-par" | "ir-par-aware";
export interface Outcome { scenario: string; exec: Exec; wallMs: number; calls: number; extraCalls: number; refused: number; lost: number; failedCalls: number; maxInflight: number; stateOk: boolean; note?: string }
export interface Scenario {
	name: string; seed: Record<string, number>; opts: Omit<LabOpts, "latencyMs">; limit?: number | undefined;
	js: Partial<Record<Exec, (lab: Lab) => Promise<void>>>;
	ir: string;
	/** engine concurrency when the author knows the limit (ir-par-aware) */
	aware?: number;
}

const keys = (n: number, p = "k") => Array.from({ length: n }, (_, i) => `${p}${i}`);
const pool = async <T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]!; await f(x); } })); };
const retry = async (lab: Lab, tool: string, a: Record<string, Json>): Promise<void> => { for (let t = 0; t < 50; t++) { const r = await lab.call(tool, a); if (r.ok || r.error !== "rate_limited") return; await new Promise((res) => setTimeout(res, lab.o.latencyMs)); } };

export const SCENARIOS: Scenario[] = [
	{
		name: "S1 independent fan-out (60 reads)", seed: Object.fromEntries(keys(60).map((k, i) => [k, i])), opts: {},
		js: {
			"js-seq": async (l) => { for (const k of keys(60)) await l.call("get", { k }); },
			"js-naive": async (l) => { await Promise.all(keys(60).map((k) => l.call("get", { k }))); },
			"js-best": async (l) => { await pool(keys(60), 16, (k) => l.call("get", { k }).then(() => undefined)); },
		},
		ir: `const rs = map(${JSON.stringify(keys(60))}, (k) => call("get", { k })); output({ total: sum(pluck(rs, "v")) });`,
	},
	{
		name: "S2 same-key conflicts (8 keys x 6 increments, then read)", seed: {}, opts: {},
		js: {
			"js-seq": async (l) => { for (let r = 0; r < 6; r++) for (const k of keys(8)) await l.call("incr", { k }); },
			"js-naive": async (l) => { await Promise.all(Array.from({ length: 6 }, () => keys(8)).flat().map((k) => l.call("incr", { k }))); },
			"js-best": async (l) => { await Promise.all(keys(8).map(async (k) => { for (let r = 0; r < 6; r++) await l.call("incr", { k }); })); },
		},
		ir: `for (let r = 0; r < 6; r++) map(${JSON.stringify(keys(8))}, (k) => call("incr", { k })); output({ done: 1 });`,
	},
	{
		name: "S3 concurrency limit 4 (24 reads)", seed: Object.fromEntries(keys(24).map((k, i) => [k, i])), opts: { limit: 4 }, aware: 4,
		js: {
			"js-seq": async (l) => { for (const k of keys(24)) await l.call("get", { k }); },
			"js-naive": async (l) => { await Promise.all(keys(24).map((k) => l.call("get", { k }))); },
			"js-best": async (l) => { await pool(keys(24), 4, (k) => retry(l, "get", { k })); },
		},
		ir: `const rs = map(${JSON.stringify(keys(24))}, (k) => call("get", { k })); output({ total: sum(pluck(rs, "v")) });`,
	},
	{
		name: "S4 dynamic dependency (revise the low ones until none is low)", seed: Object.fromEntries(keys(16).map((k, i) => [k, (i * 37) % 100 > 60 ? 80 : 10 + i])), opts: {},
		js: {
			"js-seq": async (l) => { for (let round = 0; round < 3; round++) { const low: { k: string; v: number }[] = []; for (const k of keys(16)) { const r = await l.call("get", { k }); const v = (r.value as { v: number }).v; if (v < 50) low.push({ k, v }); } if (low.length === 0) break; for (const x of low) await l.call("put", { k: x.k, v: x.v + 60 }); } },
			"js-naive": async (l) => { for (let round = 0; round < 3; round++) { const rs = await Promise.all(keys(16).map((k) => l.call("get", { k }))); const low = rs.map((r) => r.value as { k: string; v: number }).filter((x) => x.v < 50); if (low.length === 0) break; await Promise.all(low.map((x) => l.call("put", { k: x.k, v: x.v + 60 }))); } },
			"js-best": async (l) => { for (let round = 0; round < 3; round++) { const rs = await Promise.all(keys(16).map((k) => l.call("get", { k }))); const low = rs.map((r) => r.value as { k: string; v: number }).filter((x) => x.v < 50); if (low.length === 0) break; await Promise.all(low.map((x) => l.call("put", { k: x.k, v: x.v + 60 }))); } },
		},
		ir: `const u = until({ max: 3, init: 0 }, (round) => {
			const rs = map(${JSON.stringify(keys(16))}, (k) => call("get", { k }));
			const low = filter(rs, (r) => lt(r.v, 50));
			map(low, (x) => call("put", { k: x.k, v: add(x.v, 60) }));
			return { next: add(round, 1), done: isEmpty(low) };
		}); output({ rounds: u });`,
	},
	{
		name: "S5 failures (30 chains of 3 steps, every 5th write fails)", seed: Object.fromEntries(keys(30, "a").map((k, i) => [k, i + 1])), opts: { failPut: (k) => Number(k.slice(1)) % 5 === 0 },
		js: {
			"js-seq": async (l) => { for (let i = 0; i < 30; i++) { const a = await l.call("get", { k: `a${i}` }); const p = await l.call("put", { k: `b${i}`, v: (a.value as { v: number }).v }); if (p.ok) await l.call("get", { k: `b${i}` }); } },
			"js-naive": async (l) => { await Promise.all(keys(30, "").map(async (_, i) => { const a = await l.call("get", { k: `a${i}` }); await l.call("put", { k: `b${i}`, v: (a.value as { v: number }).v }); await l.call("get", { k: `b${i}` }); })); },
			"js-best": async (l) => { await pool(Array.from({ length: 30 }, (_, i) => i), 16, async (i) => { const a = await l.call("get", { k: `a${i}` }); const p = await l.call("put", { k: `b${i}`, v: (a.value as { v: number }).v }); if (p.ok) await l.call("get", { k: `b${i}` }); }); },
		},
		ir: `for (let i = 0; i < 30; i++) { const a = call("get", { k: "a" + i }); const b = call("put", { k: "b" + i, v: a.v }); call("get", { k: "b" + i }, { after: [b] }); }`,
	},
];

async function runIr(sc: Scenario, lab: Lab, mode: "sequential" | "parallel", maxConcurrency?: number): Promise<string | undefined> {
	const built = await buildPlan(sc.ir, CATALOG);
	if (!built.ok) return `build: ${built.error}`;
	const r = await run(built.program, { mode, call: (t, a) => lab.call(t, a as Record<string, Json>), effects, ...(maxConcurrency !== undefined ? { maxConcurrency } : {}) });
	return r.ok || r.errors.length > 0 ? undefined : r.error;
}

export async function runScenario(sc: Scenario, latencyMs: number): Promise<Outcome[]> {
	// reference: the plain sequential program on a zero-latency server
	const ref = new Lab({ ...sc.opts, latencyMs: 0, limit: undefined }, sc.seed);
	await sc.js["js-seq"]!(ref);
	const want = JSON.stringify([...ref.state.entries()].sort());
	const wantCalls = ref.calls;
	const out: Outcome[] = [];
	const execs: Exec[] = ["js-seq", "js-naive", "js-best", "ir-seq", "ir-par", ...(sc.aware ? (["ir-par-aware"] as Exec[]) : [])];
	for (const exec of execs) {
		const lab = new Lab({ ...sc.opts, latencyMs }, sc.seed);
		const t0 = Date.now();
		let note: string | undefined;
		try {
			if (exec.startsWith("js")) await sc.js[exec]!(lab);
			else note = await runIr(sc, lab, exec === "ir-seq" ? "sequential" : "parallel", exec === "ir-par-aware" ? sc.aware : undefined);
		} catch (e) { note = `threw: ${e instanceof Error ? e.message : String(e)}`; }
		out.push({ scenario: sc.name, exec, wallMs: Date.now() - t0, calls: lab.calls, extraCalls: lab.calls - lab.refused - wantCalls, refused: lab.refused, lost: lab.lost, failedCalls: lab.failed, maxInflight: lab.maxInflight, stateOk: JSON.stringify([...lab.state.entries()].sort()) === want && lab.refused === 0 && lab.lost === 0 && lab.calls - lab.refused === wantCalls, ...(note ? { note } : {}) });
	}
	return out;
}
