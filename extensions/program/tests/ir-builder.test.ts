/**
 * The builder front-end: code that declares work, run in the sandbox, produces the IR.
 * Nothing is executed; mistakes that would silently change meaning in plain JavaScript
 * (a handle used as a value, an undefined property, an operator on a handle) are errors.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/ir/builder.js";
import { run } from "../src/ir/engine.js";
import { World } from "./ir-backend.js";

const catalog = [
	{ name: "get", description: "read a key", inputSchema: { type: "object", properties: { k: { type: "string" } } } },
	{ name: "incr", description: "add one to a key", inputSchema: { type: "object", properties: { k: { type: "string" } } } },
	{ name: "ping", description: "echo", inputSchema: { type: "object", properties: { x: {} } } },
];
const ok = async (code: string) => { const r = await buildPlan(code, catalog); if (!r.ok) throw new Error(r.error); return r.program; };

describe("builder: code -> IR", () => {
	it("a chain of calls with handle paths and an output", async () => {
		const p = await ok(`const a = call("get", { k: "x" }); const b = call("ping", { x: a.items[0].name }); output({ b });`);
		expect(p.nodes).toHaveLength(2);
		expect(p.nodes[1]).toMatchObject({ kind: "call", tool: "ping", args: { obj: { x: { ref: p.nodes[0]!.id, path: ["items", 0, "name"] } } } });
		expect(p.output).toEqual({ obj: { b: { ref: p.nodes[1]!.id } } });
	});

	it("map, filter, pluck and until build containers and pure steps", async () => {
		const p = await ok(`
			const xs = map([1, 2, 3], (n) => call("ping", { x: n }));
			const big = filter(xs, (v) => gt(v, 1));
			const ids = pluck(big, "id");
			const u = until({ max: 3, init: 0 }, (s) => { call("incr", { k: "n" }); return { next: add(s, 1), done: gte(s, 1) }; });
			output({ ids, u });`);
		expect(p.nodes.map((n) => n.kind)).toEqual(["map", "let", "let", "until"]);
		const filt = p.nodes[1]! as { value: { op: string; where: { op: string; a: { ref: string } } } };
		expect(filt.value.op).toBe("filter");
		expect(filt.value.where.a).toEqual({ ref: "$" });
	});

	it("a plan that is built is exactly the plan that runs: the result equals the same program evaluated by hand", async () => {
		const p = await ok(`
			const a = call("incr", { k: "n" }); const b = call("incr", { k: "n" }, { after: [a] });
			const rs = map(["x", "y"], (k) => call("get", { k }));
			output({ b, rs, total: sum(rs) });`);
		const w = new World(1, 0, 1);
		const r = await run(p, { mode: "parallel", call: (t, x) => w.call(t, x), effects: (t, x) => w.effects(t, x) });
		expect(r.ok).toBe(true);
		expect(r.output).toEqual({ b: 2, rs: [0, 0], total: 0 });
	});

	it("when and after become node options", async () => {
		const p = await ok(`const a = call("get", { k: "n" }); call("incr", { k: "n" }, { when: gt(a, 5), after: [a] });`);
		expect(p.nodes[1]).toMatchObject({ after: [p.nodes[0]!.id], when: { op: "gt" } });
	});

	it("mistakes are errors, not silent wrong plans", async () => {
		const bad = async (code: string, re: RegExp) => { const r = await buildPlan(code, catalog); expect(r.ok).toBe(false); expect((r as { error: string }).error).toMatch(re); };
		await bad(`const a = call("get", { k: "x" }); const c = call("ping", { x: a.nope.deeper }); output(c); const d = call("ping", { x: undefined });`, /undefined value/);
		await bad(`const a = call("get", { k: "x" }); const t = add(a, 1); output(t.value);`, /computed value/);
		await bad(`const rs = map([1], (n) => call("ping", { x: n })); filter(rs, (r) => call("get", { k: "x" }));`, /not allowed inside filter/);
		await bad(`call("get", { k: "x" }, { after: ["c1"] });`, /after: expects handles/);
		await bad(`const u = until({ max: 3, init: 0 }, (s) => 5);`, /next, done/);
		await bad(`const a = call("get", { k: "x" }); output({ z: a, y: nonexistentThing });`, /nonexistentThing/);
	});

	it("a runaway plan is interrupted by the time limit", async () => {
		const r = await buildPlan(`while (true) {}`, catalog, { timeoutMs: 300 });
		expect(r.ok).toBe(false);
	});

	it("the validator's rules still apply to a built plan (an output must name top-level steps)", async () => {
		const r = await buildPlan(`const m = map([1], (n) => { const inner = call("ping", { x: n }); return inner; }); const only = call("ping", { x: 1 }); output({ only });`, catalog);
		expect(r.ok).toBe(true);
	});

	it("the sandbox has no ambient authority in plan mode either", async () => {
		const r = await ok(`output({ p: typeof process, f: typeof fetch, r: typeof require });`);
		expect(r.output).toEqual({ obj: { p: { lit: "undefined" }, f: { lit: "undefined" }, r: { lit: "undefined" } } });
	});

	it("the catalog is available synchronously (the plan cannot call tools to look around)", async () => {
		const p = await ok(`output({ names: ALL_TOOLS.map((t) => t.name), schema: describeTool("get").inputSchema });`);
		expect(JSON.stringify(p.output)).toContain('"get"');
	});
});

describe("builder: the JavaScript habits the model actually has (A2, from 148 recorded plans)", () => {
	const plan = async (code: string) => { const r = await buildPlan(code, catalog); if (!r.ok) throw new Error(r.error); return r.program; };
	const fail = async (code: string) => { const r = await buildPlan(code, catalog); expect(r.ok).toBe(false); return (r as { error: string }).error; };

	it('"gen-" + item and a template literal build a concat, exactly like the string they look like', async () => {
		const p = await plan('const a = call("get", { k: "x" }); const b = call("ping", { x: "id-" + a.name + "-" + `${a.id}!` }); output({ b });');
		expect(p.nodes[1]).toMatchObject({ args: { obj: { x: { op: "concat", parts: [{ lit: "id-" }, { ref: "c1", path: ["name"] }, { lit: "-" }, { ref: "c1", path: ["id"] }, { lit: "!" }] } } } });
		const r = await run(p, { mode: "sequential", call: async (t, x) => (t === "get" ? { ok: true, value: { name: "N", id: 7 } } : { ok: true, value: x }), effects: () => ({ kind: "unknown" }) });
		expect(r.ok).toBe(true);
		expect(r.output).toEqual({ b: { x: "id-N-7!" } }); // the text is what the JavaScript looks like it says
	});

	it("inside map, the item works in a key: call_id: 'gen-' + s", async () => {
		const p = await plan('const out = map(["a", "b"], (s) => call("ping", { x: "gen-" + s })); output(out);');
		const m = p.nodes[0]! as { body: { args: { obj: { x: { op: string } } } }[] };
		expect(m.body[0]!.args.obj.x.op).toBe("concat");
	});

	it("a handle plus a bare number is refused, naming add() and concat(): the same text could mean either", async () => {
		expect(await fail('const a = call("get", { k: "x" }); output(a.n + 1);')).toMatch(/add\(.*concat\(/);
		expect(await fail('const a = call("get", { k: "x" }); output(a.n * 2);')).toMatch(/number|add\(/);
	});

	it("a handle in a condition is refused, because it would always be true", async () => {
		for (const code of [
			'const a = call("get", { k: "x" }); if (a.ok) { call("incr", { k: "n" }); }',
			'const a = call("get", { k: "x" }); output(a.ok ? 1 : 2);',
			'const a = call("get", { k: "x" }); output(!a.ok);',
			'const a = call("get", { k: "x" }); output(a.x && a.y);',
			'const a = call("get", { k: "x" }); output(a.x || a.y);',
		]) expect(await fail(code)).toMatch(/not\(|ifElse|and\(|when/);
		// strings and comments that merely contain those characters are fine
		await plan('// is it ok? && ||\nconst a = call("get", { k: "x?y" }); output(concat("!! ", a));');
	});

	it("handle.map / .filter / .join read as the model writes them", async () => {
		const p = await plan('const xs = call("get", { k: "list" }); const ys = xs.items.map((i) => call("ping", { x: i.id })); const z = xs.items.filter((i) => gt(i.n, 1)); output({ ys, n: len(z), j: xs.tags.join(",") });');
		expect(p.nodes.map((n) => n.kind)).toEqual(["call", "map", "let"]);
		expect(p.nodes[1]).toMatchObject({ kind: "map", over: { ref: "c1", path: ["items"] } });
	});

	it("describeTool with a plan value says it needs a literal name", async () => {
		expect(await fail('const names = ["get", "incr"]; output(map(names, (n) => describeTool(n)));')).toMatch(/literal tool name/);
	});

	it("the catalog does not list the plan tool or the program tool themselves", async () => {
		const r = await buildPlan('output(ALL_TOOLS.map((t) => t.name));', [...catalog, { name: "plan", description: "x".repeat(2000), inputSchema: {} }, { name: "program", description: "y", inputSchema: {} }]);
		expect(r.ok).toBe(true);
		expect(JSON.stringify((r as { program: { output: unknown } }).program.output)).not.toMatch(/"plan"|"program"/);
	});
});
