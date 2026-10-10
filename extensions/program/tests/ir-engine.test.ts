/**
 * The engine's two schedules (invariants I17-I19). The reference is the SEQUENTIAL schedule;
 * the parallel one is correct iff everything observable is equal: result, every node's status
 * and value, the final state, the order of writes per key, and the multiset of calls made.
 * Part 1 pins the meaning with small programs; part 2 is differential: random programs and
 * random failure injection, thousands of runs, against the reference.
 */
import { describe, expect, it } from "vitest";
import { run, validate } from "../src/ir/engine.js";
import type { Expr, Json, Node, Program } from "../src/ir/types.js";
import { World } from "./ir-backend.js";

const lit = (v: Json): Expr => ({ lit: v });
const ref = (id: string, ...path: (string | number)[]): Expr => ({ ref: id, ...(path.length ? { path } : {}) });
const call = (id: string, tool: string, args: Record<string, Expr>, extra: Partial<Node> = {}): Node => ({ id, kind: "call", tool, args: { obj: args }, ...extra }) as Node;

async function both(p: Program, w: () => World) {
	const a = w(), b = w();
	const seq = await run(p, { mode: "sequential", call: (t, x) => a.call(t, x), effects: (t, x) => a.effects(t, x) });
	const par = await run(p, { mode: "parallel", call: (t, x) => b.call(t, x), effects: (t, x) => b.effects(t, x), maxConcurrency: 8 });
	return { seq, par, sw: a, pw: b };
}
const world = (failPct = 0) => () => new World(1, failPct);

describe("meaning (small programs, both schedules)", () => {
	it("a chain passes values through references", async () => {
		const p: Program = { nodes: [call("a", "put", { k: lit("x"), v: lit(5) }), call("b", "incr", { k: lit("x") }, { after: ["a"] }), call("c", "get", { k: lit("x") }, { after: ["b"] })], output: { obj: { x: ref("c") } } };
		const { seq, par } = await both(p, world());
		expect(seq.output).toEqual({ x: 6 });
		expect(par.output).toEqual({ x: 6 });
	});

	it("a map fans out over a list and yields per element", async () => {
		const p: Program = { nodes: [{ id: "m", kind: "map", over: lit([1, 2, 3]), as: "n", body: [call("p", "ping", { x: { op: "add", a: ref("n"), b: lit(10) } })], yield: ref("p") }], output: ref("m") };
		const { seq, par } = await both(p, world());
		expect(seq.output).toEqual([11, 12, 13]);
		expect(par.output).toEqual([11, 12, 13]);
	});

	it("a failed call skips what depends on it; independent work still runs; the run is not ok", async () => {
		// seed chosen so that get(k=boom) fails: find it by searching failPct=100 for one tool
		const p: Program = { nodes: [call("bad", "get", { k: lit("a") }), call("dep", "ping", { x: ref("bad") }), call("free", "ping", { x: lit(7) })], output: { obj: { f: ref("free") } } };
		const { seq, par } = await both(p, () => new World(3, 100));
		for (const r of [seq, par]) {
			expect(r.ok).toBe(false);
			expect(r.nodes["0"]!.status).toBe("failed");
			expect(r.nodes["1"]!.status).toBe("skipped");
			expect(r.nodes["2"]!.status).toBe("failed"); // failPct 100 fails every call, including free
		}
		const half = await both(p, () => new World(11, 40));
		expect(JSON.stringify(half.par.nodes)).toBe(JSON.stringify(half.seq.nodes));
	});

	it("`when` false makes a node done with null and does not skip its dependents", async () => {
		const p: Program = { nodes: [call("g", "get", { k: lit("a") }), call("w", "put", { k: lit("a"), v: lit(9) }, { when: { op: "gt", a: ref("g"), b: lit(5) } }), { id: "l", kind: "let", value: { op: "isEmpty", a: ref("w") } }], output: { obj: { l: ref("l"), w: ref("w") } } };
		const { seq, par } = await both(p, world());
		expect(seq.output).toEqual({ l: true, w: null });
		expect(par.output).toEqual(seq.output);
	});

	it("until repeats a body until `done`, bounded by max", async () => {
		const p: Program = { nodes: [{ id: "u", kind: "until", max: 4, init: lit(0), as: "s", body: [call("i", "incr", { k: lit("n") })], next: { op: "add", a: ref("s"), b: lit(1) }, done: { op: "gte", a: ref("s"), b: lit(1) } }, call("fin", "get", { k: lit("n") })], output: { obj: { u: ref("u"), n: ref("fin") } } };
		const { seq, par } = await both(p, world());
		// `done` is judged on the state the iteration STARTED with: iteration 0 sees 0 (not done), iteration 1 sees 1 (done)
		expect(seq.output).toEqual({ u: 2, n: 2 });
		expect(par.output).toEqual({ u: 2, n: 2 });
		// the bound: a `done` that never holds stops at max
		const p2: Program = { nodes: [{ id: "u", kind: "until", max: 3, init: lit(0), as: "s", body: [call("i", "incr", { k: lit("n") })], next: { op: "add", a: ref("s"), b: lit(1) }, done: lit(false) }], output: ref("u") };
		expect((await both(p2, world())).par.output).toBe(3);
	});

	it("validation refuses a forward reference, a duplicate id and an unbounded loop", () => {
		expect(() => validate({ nodes: [call("a", "ping", { x: ref("b") }), call("b", "ping", {})], output: lit(null) })).toThrow(/not defined before/);
		expect(() => validate({ nodes: [call("a", "ping", {}), call("a", "ping", {})], output: lit(null) })).toThrow(/duplicate/);
		expect(() => validate({ nodes: [{ id: "u", kind: "until", max: 9999, init: lit(0), as: "s", body: [], next: ref("s"), done: lit(true) }], output: lit(null) })).toThrow(/max/);
	});
});

describe("scheduling (what may overlap, what may not)", () => {
	const reads = (n: number): Program => ({ nodes: Array.from({ length: n }, (_, i) => call(`r${i}`, "get", { k: lit(`k${i}`) })), output: lit(null) });
	it("independent reads overlap in the parallel schedule and never in the reference", async () => {
		const { seq, par } = await both(reads(8), () => new World(1, 0, 6));
		expect(seq.maxInFlight).toBe(1);
		expect(par.maxInFlight).toBeGreaterThan(1);
	});
	it("two writes to one key never overlap, and run in program order; writes to different keys do overlap", async () => {
		const same: Program = { nodes: [call("w1", "put", { k: lit("a"), v: lit(1) }), call("w2", "put", { k: lit("a"), v: lit(2) })], output: lit(null) };
		const r1 = await both(same, () => new World(1, 0, 6));
		expect(r1.par.maxInFlight).toBe(1);
		expect(r1.pw.snapshot().writes).toEqual([["a", ["put 1", "put 2"]]]);
		const diff: Program = { nodes: [call("w1", "put", { k: lit("a"), v: lit(1) }), call("w2", "put", { k: lit("b"), v: lit(2) })], output: lit(null) };
		expect((await both(diff, () => new World(1, 0, 6))).par.maxInFlight).toBe(2);
	});
	it("a read waits for an earlier write to its key; a call with an undeclared effect is a barrier", async () => {
		const p: Program = { nodes: [call("w", "put", { k: lit("a"), v: lit(4) }), call("r", "get", { k: lit("a") }), call("x", "legacy", { k: lit("zzz") }), call("r2", "get", { k: lit("b") })], output: { obj: { r: ref("r") } } };
		const { par } = await both(p, () => new World(1, 0, 6));
		expect(par.output).toEqual({ r: 4 });
		expect(par.maxInFlight).toBe(1); // w -> r (key a); legacy blocks everything non-pure; r2 waits for legacy
	});
	it("the number of calls is bounded", async () => {
		const r = await run(reads(5), { mode: "parallel", maxCalls: 3, call: async () => ({ ok: true, value: 0 }), effects: () => ({ kind: "read", keys: "*" }) });
		expect(r.ok).toBe(false);
		expect(r.started).toHaveLength(3);
		expect(Object.values(r.nodes).filter((n) => n.status === "failed")).toHaveLength(2); // the calls past the budget fail, they do not run
	});
});

// ── part 2: differential ────────────────────────────────────────────────────
function prng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** A random but well-formed program over the key-value world. */
function randomProgram(seed: number): Program {
	const rnd = prng(seed);
	const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
	const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)]!;
	const KEYS = ["a", "b", "c", "d"];
	let counter = 0;
	const body = (depth: number, visibleNums: string[], visibleLists: string[], count: number): { nodes: Node[]; nums: string[]; lists: string[] } => {
		const nodes: Node[] = []; const nums = [...visibleNums]; const lists = [...visibleLists];
		const num = (): Expr => (nums.length > 0 && rnd() < 0.5 ? ref(pick(nums)) : lit(int(0, 9)));
		const key = (): Expr => lit(pick(KEYS));
		for (let n = 0; n < count; n += 1) {
			const id = `n${counter++}`;
			const extra: Partial<Node> = {};
			if (nodes.length > 0 && rnd() < 0.12) extra.after = [pick(nodes).id];
			if (nums.length > 0 && rnd() < 0.12) extra.when = { op: "gt", a: ref(pick(nums)), b: lit(int(0, 4)) };
			const r = rnd();
			if (r < 0.50) {
				const tool = pick(["get", "get", "put", "incr", "incr", "sum", "dump", "ping", "legacy"]);
				const args: Record<string, Expr> = tool === "put" ? { k: key(), v: num() } : tool === "sum" ? { ks: { arr: [key(), key()] } } : tool === "dump" ? {} : tool === "ping" ? { x: num() } : { k: key() };
				nodes.push(call(id, tool, args, extra));
				if (tool === "get" || tool === "put" || tool === "incr" || tool === "sum" || tool === "ping" || tool === "legacy") nums.push(id);
			} else if (r < 0.62 && nums.length >= 2) {
				nodes.push({ id, kind: "let", value: { op: "add", a: ref(pick(nums)), b: ref(pick(nums)) }, ...extra } as Node);
				nums.push(id);
			} else if (r < 0.74 && nums.length >= 1) {
				nodes.push({ id, kind: "let", value: { arr: [ref(pick(nums)), num(), num()] }, ...extra } as Node);
				lists.push(id);
			} else if (r < 0.90 && depth < 2) {
				const item = `it${counter++}`;
				const inner = body(depth + 1, [...nums, item], [], int(1, 3));
				const over: Expr = lists.length > 0 && rnd() < 0.5 ? ref(pick(lists)) : lit(Array.from({ length: int(0, 4) }, () => int(0, 9)));
				nodes.push({ id, kind: "map", over, as: item, body: inner.nodes, yield: inner.nodes.length ? ref(inner.nodes[inner.nodes.length - 1]!.id) : lit(null), ...extra } as Node);
				lists.push(id);
			} else if (depth < 2) {
				const st = `st${counter++}`;
				const inner = body(depth + 1, [...nums, st], [], 1);
				nodes.push({ id, kind: "until", max: int(1, 3), init: lit(0), as: st, body: inner.nodes, next: { op: "add", a: ref(st), b: lit(1) }, done: { op: "gte", a: ref(st), b: lit(int(0, 2)) }, ...extra } as Node);
				nums.push(id);
			} else {
				nodes.push(call(id, "get", { k: key() }, extra)); nums.push(id);
			}
		}
		return { nodes, nums, lists };
	};
	const top = body(0, [], [], int(4, 12));
	const outs = [...top.nums, ...top.lists].filter((id) => top.nodes.some((n) => n.id === id)).slice(-3);
	return { nodes: top.nodes, output: { obj: Object.fromEntries(outs.map((id) => [id, ref(id)])) } };
}

const view = (r: Awaited<ReturnType<typeof run>>, w: World) => ({
	ok: r.ok, output: r.output ?? null, error: r.error ?? null, nodes: r.nodes,
	calls: r.started.map((c) => `${c.tool} ${JSON.stringify(c.args)}`).sort(), world: w.snapshot(),
});

/** the first few places where two views differ, as short strings (so a failure names the node, not the program) */
function firstDiffs(a: ReturnType<typeof view>, b: ReturnType<typeof view>): string[] {
	const out: string[] = [];
	const j = (x: unknown): string => JSON.stringify(x)?.slice(0, 160) ?? "undefined";
	for (const k of ["ok", "output", "error"] as const) if (j(a[k]) !== j(b[k])) out.push(`${k}: ${j(a[k])} vs ${j(b[k])}`);
	for (const k of Object.keys(a.nodes)) if (j(a.nodes[k]) !== j(b.nodes[k])) out.push(`node ${k}: ${j(a.nodes[k])} vs ${j(b.nodes[k])}`);
	if (j(a.calls) !== j(b.calls)) out.push(`calls: ${a.calls.length} vs ${b.calls.length}`);
	if (j(a.world) !== j(b.world)) out.push(`world: ${j(a.world)} vs ${j(b.world)}`);
	return out.slice(0, 4);
}

describe("differential: the parallel schedule equals the sequential reference", () => {
	for (const failPct of [0, 12, 35]) {
		it(`600 random programs, failure rate ${failPct}%: result, node statuses and values, final state, per-key write order and the set of calls are identical`, async () => {
			let overlapped = 0, withFailures = 0, withBarrier = 0;
			for (let seed = 1; seed <= 600; seed += 1) {
				const program = randomProgram(seed * 7919 + failPct);
				const { seq, par, sw, pw } = await both(program, () => new World(seed, failPct, 2));
				const a = view(seq, sw), b = view(par, pw);
				const diff = firstDiffs(a, b);
				if (diff.length > 0) throw new Error(`seed ${seed} (failure rate ${failPct}%): ${diff.join(" || ")}`);
				if (par.maxInFlight > 1) overlapped += 1;
				if (!seq.ok) withFailures += 1;
				if (JSON.stringify(program).includes("legacy")) withBarrier += 1;
			}
			// the generator must actually exercise what is being tested
			expect(overlapped, "programs where the parallel schedule really overlapped calls").toBeGreaterThan(150);
			if (failPct > 0) expect(withFailures).toBeGreaterThan(60);
			expect(withBarrier).toBeGreaterThan(40);
		}, 120_000);
	}
});
