/**
 * Resource footprint scheduling, free (A "scheduler experiment independent of the kernel", owner's ruling 2026-10-11).
 * Server: every call takes wall time; `update_customer` is a NON-ATOMIC read-modify-write (two overlapping updates of one
 * record lose one); a record can be reached by id or by email. Correctness first: no lost update, final state = the sequential reference.
 * The footprint comes only from trusted resolvers the runtime calls; nothing a program or an input says can change it.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/ir/builder.js";
import { run } from "../src/ir/engine.js";
import type { Json } from "../src/ir/types.js";
import { ChildLimiter, groupOfTool, trustedEffects, type Resolver } from "../src/index.js";
import { CATALOG, Lab } from "./sched-lab.js";

const L = 15;
const DIRECTORY: [string, string][] = [["a@x", "A"], ["b@x", "B"]];
const byId: Resolver = (i) => (typeof i.customer_id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(i.customer_id) ? { writes: [`customer:${i.customer_id}`], group: "crm" } : "exclusive");
const dir = new Map(DIRECTORY);
const byEmail: Resolver = (i) => (typeof i.email === "string" && dir.has(i.email) ? { writes: [`customer:${dir.get(i.email)}`], group: "crm" } : "exclusive");
const RESOLVERS = { update_customer: byId, update_by_email: byEmail };

async function exec(code: string, opts: { resolvers?: Record<string, Resolver>; mode?: "sequential" | "parallel"; latency?: number; limiter?: ChildLimiter; fallbacks?: string[] } = {}) {
	const lab = new Lab({ latencyMs: opts.latency ?? L }); for (const [e, id] of DIRECTORY) lab.directory.set(e, id);
	const built = await buildPlan(code, CATALOG);
	if (!built.ok) throw new Error(built.error);
	const effects = trustedEffects(opts.resolvers ?? RESOLVERS, { onFallback: (t, r) => opts.fallbacks?.push(`${t}: ${r}`) });
	const t0 = Date.now();
	const r = await run(built.program, { mode: opts.mode ?? "parallel", effects, maxConcurrency: 16, call: (t, a) => (opts.limiter ? opts.limiter.run(t, () => lab.call(t, a as Record<string, Json>)) : lab.call(t, a as Record<string, Json>)) });
	return { lab, r, wall: Date.now() - t0, state: Object.fromEntries([...lab.state.entries()].sort()) };
}
const UPDATES = `call("update_customer", { customer_id: "A" }); call("update_customer", { customer_id: "A" }); call("update_customer", { customer_id: "B" }); call("update_customer", { customer_id: "C" }); call("update_customer", { customer_id: "B" });`;

describe("trusted footprints on a server with real concurrency", () => {
	it("different records overlap, the same record is serial: no lost update, the sequential result, faster than sequential", async () => {
		const par = await exec(UPDATES), seq = await exec(UPDATES, { mode: "sequential" });
		expect(par.lab.lost).toBe(0);
		expect(par.state).toEqual({ "customer:A": 2, "customer:B": 2, "customer:C": 1 });
		expect(par.state).toEqual(seq.state);
		expect(par.lab.maxInflight).toBeGreaterThan(1);
		expect(par.wall).toBeLessThan(seq.wall * 0.7);
	});
	it("the hazard is real: without the footprints (every call unknown) it is correct but serial; naive parallel JS loses updates", async () => {
		const blind = await exec(UPDATES, { resolvers: {} });
		expect(blind.lab.lost).toBe(0);
		expect(blind.lab.maxInflight).toBe(1);
		const lab = new Lab({ latencyMs: L });
		await Promise.all(["A", "A", "B", "C", "B"].map((id) => lab.call("update_customer", { customer_id: id })));
		expect(lab.lost).toBeGreaterThan(0);
	});
	it("aliasing: one record reached by id and by email maps to ONE resource; no lost update", async () => {
		const code = `for (let i = 0; i < 3; i++) { call("update_customer", { customer_id: "A" }); call("update_by_email", { email: "a@x" }); }`;
		const r = await exec(code);
		expect(r.lab.lost).toBe(0);
		expect(r.state).toEqual({ "customer:A": 6 });
	});
	it("an alias the host cannot resolve is exclusive, with a reason, and still correct", async () => {
		const fb: string[] = [];
		const lab = new Lab({ latencyMs: L }); lab.directory.set("ghost@x", "A"); // reachable, but the host's resolver does not know this email
		const built = await buildPlan(`call("update_customer", { customer_id: "A" }); call("update_by_email", { email: "ghost@x" }); call("update_customer", { customer_id: "A" });`, CATALOG);
		if (!built.ok) throw new Error(built.error);
		const r = await run(built.program, { mode: "parallel", effects: trustedEffects(RESOLVERS, { onFallback: (t, why) => fb.push(`${t}: ${why}`) }), call: (t, a) => lab.call(t, a as Record<string, Json>) });
		expect(r.ok).toBe(true);
		expect(lab.lost).toBe(0);
		expect(lab.state.get("customer:A")).toBe(3);
		expect(fb.some((x) => /update_by_email.*exclusive/.test(x))).toBe(true);
	});
	it("a resolver that throws, is async, is non-deterministic, returns garbage or an empty footprint falls back to exclusive; nothing is lost", async () => {
		const bad: Record<string, Resolver>[] = [
			{ update_customer: () => { throw new Error("boom"); } },
			{ update_customer: (async () => ({ writes: ["customer:A"] })) as unknown as Resolver },
			{ update_customer: (() => { let n = 0; return () => ({ writes: [`customer:${n++}`] }); })() },
			{ update_customer: (() => ({ writes: [42] })) as unknown as Resolver },
			{ update_customer: () => ({}) },
			{ update_customer: () => ({ writes: ["customer:A".repeat(100)] }) },
		];
		for (const resolvers of bad) {
			const fb: string[] = [];
			const r = await exec(UPDATES, { resolvers, fallbacks: fb });
			expect(r.lab.lost, JSON.stringify(Object.keys(resolvers))).toBe(0);
			expect(r.lab.maxInflight).toBe(1); // exclusive = alone
			expect(fb.length).toBeGreaterThan(0);
		}
	});
	it("an input cannot talk its way to a footprint: odd types and spoof fields are exclusive or ignored", async () => {
		const fb: string[] = [];
		const code = `call("update_customer", { customer_id: "A", writes: [], reads: ["x"], footprint: { writes: [] } }); call("update_customer", { customer_id: "A" });`;
		const r = await exec(code, { fallbacks: fb });
		expect(r.lab.lost).toBe(0);
		expect(r.state).toEqual({ "customer:A": 2 }); // both on A, serial, whatever the extra fields claim
		const eff = trustedEffects(RESOLVERS);
		expect(eff("update_customer", { customer_id: ["A"] } as never)).toEqual({ kind: "unknown" });
		expect(eff("update_customer", { customer_id: "A\u0000B" } as never)).toEqual({ kind: "unknown" }); // a control character in an id: the resolver's own pattern refuses it
		expect(eff("update_customer", {})).toEqual({ kind: "unknown" }); // the field is not known yet: exclusive
	});
	it("a footprint the PROGRAM tries to supply is not read: node options cannot grant or remove a conflict", async () => {
		const code = `call("update_customer", { customer_id: "A" }, { writes: [], footprint: "none", concurrent: true }); call("update_customer", { customer_id: "A" }, { writes: [] });`;
		const r = await exec(code);
		expect(r.lab.lost).toBe(0);
		expect(r.state).toEqual({ "customer:A": 2 });
	});
	it("a group bound (the CRM allows 2 at once) holds across tools inside the global one", async () => {
		const limiter = new ChildLimiter({ global: 8, perGroup: 2, groupOf: groupOfTool(RESOLVERS) });
		const code = `for (const id of ["A","B","C","D","E","F"]) { call("update_customer", { customer_id: id }); }`;
		const r = await exec(code, { limiter });
		expect(r.lab.lost).toBe(0);
		expect(r.lab.maxInflight).toBeLessThanOrEqual(2);
		expect(Object.keys(r.state)).toHaveLength(6);
	});
	it("pending inputs: a call whose key is already known does not block others while its value is pending, one whose KEY is pending does (conservative)", async () => {
		const known = await exec(`const g = call("get", { k: "src" }); call("update_customer", { customer_id: "A" }, { after: [g] }); call("update_customer", { customer_id: "B" }); call("update_customer", { customer_id: "C" });`);
		expect(known.lab.maxInflight).toBeGreaterThan(1);
		const pendingKey = await exec(`const g = call("get", { k: "src" }); call("update_customer", { customer_id: g.k }); call("update_customer", { customer_id: "B" });`, { resolvers: { ...RESOLVERS, get: () => ({ reads: ["kv:src"] }) } });
		expect(pendingKey.lab.lost).toBe(0);
		// while the update's KEY is unknown (the get has not answered) the update B behind it must not start; once the key is known they are disjoint and may overlap
		const log = pendingKey.lab.log;
		expect(log.findIndex((l) => l.startsWith('start update_customer {"customer_id":"B"}'))).toBeGreaterThan(log.findIndex((l) => l.startsWith('end get')));
	});
	it("the experiment has teeth: a host resolver that gets the ALIASING wrong is caught as lost updates (the trust is in the resolver)", async () => {
		const wrong: Record<string, Resolver> = { update_customer: byId, update_by_email: (i) => ({ writes: [`email:${String(i.email)}`] }) }; // two names for one record, not unified
		const r = await exec(`for (let i = 0; i < 3; i++) { call("update_customer", { customer_id: "A" }); call("update_by_email", { email: "a@x" }); }`, { resolvers: wrong });
		expect(r.lab.lost).toBeGreaterThan(0);
	});
	it("the experiment has teeth: a resolver that always answers one key serialises everything (correct, no parallelism); one that answers nothing useful is refused", async () => {
		const coarse = await exec(UPDATES, { resolvers: { update_customer: () => ({ writes: ["crm"] }) } });
		expect(coarse.lab.lost).toBe(0);
		expect(coarse.lab.maxInflight).toBe(1);
	});
});
