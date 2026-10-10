/**
 * The front-end of the logical program: the model writes ordinary-looking JavaScript that
 * DECLARES work; running it (in the QuickJS sandbox, plan mode) executes NOTHING — it builds
 * the IR the engine then validates, orders and runs.
 *
 *   const p     = call("create_project", { name: "Atlas", budget_credits: 200 });
 *   const subs  = map(names, (n) => call("add_subject", { project_id: p.project_id, name: n }));
 *   const final = until({ max: 5, init: 0 }, (round) => {
 *     const rs  = map(subs, (s) => call("analyze_asset", { asset_id: s.asset_id }));
 *     const bad = filter(rs, (r) => not(r.passes));
 *     map(bad, (b) => call("revise_asset", { asset_id: b.asset_id, instruction: concat("fix ", join(b.issues, " ")) }));
 *     return { next: add(round, 1), done: isEmpty(bad) };
 *   });
 *   output({ project: p.project_id, rounds: final });
 *
 * A value returned by `call`/`map`/`filter`/`pluck`/`until` is a handle: property access builds a
 * path (`p.project_id`), and nothing is read until the plan runs. JavaScript's own operators on a
 * handle do not work (`!r.passes` is always false, a handle is an object), which is why the
 * pure operators are functions (`not`, `eq`, `gt`, `and`, `add`, ...); using a handle where a plain
 * value is needed is reported as an error, never silently wrong.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { QuickJS } from "quickjs-wasi";
import type { ToolSpec } from "@vincemakes/kiso-core";
import { discoverable } from "../catalog.js";
import { validate } from "./engine.js";
import type { Program } from "./types.js";

const PRELUDE = `
(() => {
	let counter = 0;
	const stack = [[]];
	let pure = 0; // >0 while a callback must only build expressions (inside filter)
	let outputExpr;
	const fail = (m) => { throw new Error(m); };
	const tokens = []; // handles that were turned into text by "+" or a template: { expr, hint }
	const TOK = /\\uE000(\\d+)\\uE001/g;
	const mkHandle = (expr) => new Proxy(function () {}, {
		apply() {
			const path = expr.path || [], last = path[path.length - 1];
			if (expr.ref === undefined || last === undefined) fail("a plan value is not a function");
			const base = mkHandle(path.length > 1 ? { ref: expr.ref, path: path.slice(0, -1) } : { ref: expr.ref });
			const args = arguments[2];
			if (last === "map") return globalThis.map(base, args[0]);
			if (last === "filter") return globalThis.filter(base, args[0]);
			if (last === "join") return globalThis.join(base, args[0]);
			fail("." + String(last) + "() is not available on plan values; use map / filter / pluck / len / join / concat");
		},
		get(_, k) {
			if (k === "__isHandle") return true;
			if (k === "__expr") return expr;
			if (k === Symbol.toPrimitive) return (hint) => {
				if (hint === "number") fail("a plan value cannot be used in arithmetic or comparison with JavaScript operators; use add(a, b), sum(list), len(x), gt/lt/eq...");
				tokens.push({ expr, hint });
				return "\\uE000" + (tokens.length - 1) + "\\uE001";
			};
			if (typeof k === "symbol") return undefined;
			if (k === "toJSON" || k === "then") return undefined;
			if (expr.ref === undefined) fail("cannot read ." + String(k) + " of a computed value; use it directly, or bind it with let_(value) first");
			return mkHandle({ ref: expr.ref, path: [...(expr.path || []), /^[0-9]+$/.test(k) ? Number(k) : k] });
		},
		has: () => false,
	});
	const isH = (v) => v !== null && (typeof v === "object" || typeof v === "function") && v.__isHandle === true;
	const textExpr = (str) => {
		const parts = []; let at = 0, m, ambiguous = false;
		TOK.lastIndex = 0;
		while ((m = TOK.exec(str)) !== null) {
			if (m.index > at) parts.push({ lit: str.slice(at, m.index) });
			const t = tokens[Number(m[1])]; if (t.hint === "default") ambiguous = true;
			parts.push(t.expr); at = m.index + m[0].length;
		}
		if (at < str.length) parts.push({ lit: str.slice(at) });
		if (parts.length === 2 && ambiguous && parts.some((p) => p.lit !== undefined && /^\\s*-?\\d+(\\.\\d+)?\\s*$/.test(p.lit))) fail("a plan value plus a bare number is ambiguous (text or addition): use add(x, 1) for a sum or concat(x, '1') for text");
		return parts.length === 1 ? parts[0] : { op: "concat", parts };
	};
	const toExpr = (v) => {
		if (isH(v)) return v.__expr;
		if (v === undefined) fail("an undefined value was used in a plan (check the property name)");
		if (typeof v === "function") fail("a function was used where a value is needed");
		if (Array.isArray(v)) return { arr: v.map(toExpr) };
		if (typeof v === "string" && v.includes("\\uE000")) return textExpr(v);
		if (v === null || typeof v !== "object") return { lit: v };
		return { obj: Object.fromEntries(Object.keys(v).map((k) => [k, toExpr(v[k])])) };
	};
	const emit = (node) => { if (pure) fail("a plan step (" + node.kind + ") is not allowed inside filter"); stack[stack.length - 1].push(node); return mkHandle({ ref: node.id }); };
	const id = (p) => p + String(++counter);
	const idsOf = (hs) => (hs || []).map((h) => { if (!isH(h) || h.__expr.ref === undefined || h.__expr.path) fail("after: expects handles returned by call/map/let_"); return h.__expr.ref; });
	const withOpts = (node, opts) => {
		if (!opts) return node;
		if (opts.after) node.after = idsOf(opts.after);
		if (opts.when !== undefined) node.when = toExpr(opts.when);
		return node;
	};
	globalThis.call = (tool, args, opts) => {
		if (typeof tool !== "string") fail("call(tool, args): tool must be a string name");
		return emit(withOpts({ id: id("c"), kind: "call", tool, args: toExpr(args === undefined ? {} : args) }, opts));
	};
	globalThis.let_ = (value, opts) => emit(withOpts({ id: id("v"), kind: "let", value: toExpr(value) }, opts));
	globalThis.map = (over, fn, opts) => {
		if (typeof fn !== "function") fail("map(list, (item) => ...): the second argument must be a function");
		const as = id("it"), body = [];
		stack.push(body);
		let y;
		try { y = fn(mkHandle({ ref: as }), mkHandle({ ref: as })); } finally { stack.pop(); }
		return emit(withOpts({ id: id("m"), kind: "map", over: toExpr(over), as, body, yield: toExpr(y === undefined ? null : y) }, opts));
	};
	globalThis.until = (cfg, fn, opts) => {
		if (!cfg || typeof fn !== "function") fail("until({ max, init }, (state) => ({ next, done })): bad arguments");
		const as = id("st"), body = [];
		stack.push(body);
		let r;
		try { r = fn(mkHandle({ ref: as })); } finally { stack.pop(); }
		if (!r || r.next === undefined || r.done === undefined) fail("until: the function must return { next, done }");
		return emit(withOpts({ id: id("u"), kind: "until", max: cfg.max, init: toExpr(cfg.init === undefined ? 0 : cfg.init), as, body, next: toExpr(r.next), done: toExpr(r.done) }, opts));
	};
	const bind = (expr) => emit({ id: id("v"), kind: "let", value: expr });
	globalThis.filter = (list, pred) => {
		if (typeof pred !== "function") fail("filter(list, (item) => condition): the second argument must be a function");
		pure += 1; let w; try { w = pred(mkHandle({ ref: "$" })); } finally { pure -= 1; }
		return bind({ op: "filter", list: toExpr(list), where: toExpr(w) });
	};
	globalThis.pluck = (list, key) => bind({ op: "pluck", list: toExpr(list), key });
	globalThis.sum = (list) => mkHandle({ op: "sum", list: toExpr(list) });
	for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "and", "or", "add"]) globalThis[op] = (a, b) => mkHandle({ op, a: toExpr(a), b: toExpr(b) });
	for (const op of ["not", "len", "isEmpty"]) globalThis[op] = (a) => mkHandle({ op, a: toExpr(a) });
	globalThis.concat = (...parts) => mkHandle({ op: "concat", parts: parts.map(toExpr) });
	globalThis.join = (list, sep) => mkHandle({ op: "join", list: toExpr(list), sep: sep === undefined ? "," : String(sep) });
	globalThis.ifElse = (cond, a, b) => mkHandle({ op: "if", cond: toExpr(cond), then: toExpr(a), else: toExpr(b) });
	globalThis.output = (v) => { outputExpr = toExpr(v); };
	const catalog = JSON.parse(globalThis.__catalog); delete globalThis.__catalog;
	globalThis.ALL_TOOLS = catalog.map((t) => ({ name: t.name, description: t.description }));
	globalThis.describeTool = (name) => { if (isH(name) || (typeof name === "string" && name.includes("\\uE000"))) fail("describeTool needs a literal tool name, not a plan value (it runs before the plan does; look tools up in a separate plan)"); return catalog.find((t) => t.name === name); };
	globalThis.__plan = () => JSON.stringify({ nodes: stack[0], output: outputExpr === undefined ? { lit: null } : outputExpr });
})();
`;

type WasmModule = NonNullable<Parameters<typeof QuickJS.create>[0]>["wasm"];
let wasm: Promise<WasmModule> | undefined;
const wasmModule = (): Promise<WasmModule> =>
	(wasm ??= (globalThis as unknown as { WebAssembly: { compile(b: Uint8Array): Promise<unknown> } }).WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"))) as Promise<WasmModule>);

/** Remove comments and the contents of string/template literals so the condition lint sees code only. */
function codeOnly(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").replace(/`(?:\\.|[^`\\])*`/g, '""').replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/'(?:\\.|[^'\\\n])*'/g, '""');
}
const CONDITIONS: RegExp[] = [/\bif\s*\(/, /\bwhile\s*\(/, /(^|[^=!<>&|])!(?!=)/, /&&/, /\|\|/, /\?(?![.?])/];
/** A handle is always truthy, so a JavaScript condition on one is silently wrong: refuse the construct itself. */
export function conditionLint(code: string): string | undefined {
	const c = codeOnly(code);
	return CONDITIONS.some((re) => re.test(c)) ? "plan code cannot branch with JavaScript (if, while, ?:, !, &&, ||): a value from a call is only a handle and is always truthy. Use not(x), and(a, b), or(a, b), ifElse(c, a, b), until(...), or call(..., { when: cond })." : undefined;
}

export type PlanResult = { ok: true; program: Program } | { ok: false; error: string };

/** Run the model's builder code and return the validated plan. Nothing is called. */
export async function buildPlan(code: string, catalog: readonly ToolSpec[], limits: { timeoutMs?: number; memoryBytes?: number; maxNodes?: number } = {}): Promise<PlanResult> {
	const lint = conditionLint(code);
	if (lint !== undefined) return { ok: false, error: lint };
	const deadline = Date.now() + (limits.timeoutMs ?? 5_000);
	const vm = await QuickJS.create({ wasm: await wasmModule(), memoryLimit: limits.memoryBytes ?? 32 * 1024 * 1024, interruptHandler: () => Date.now() > deadline });
	try {
		{
			using cat = vm.newString(JSON.stringify(discoverable(catalog).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))));
			vm.setProp(vm.global, "__catalog", cat);
		}
		vm.evalCode(PRELUDE, "builder-prelude.js").dispose();
		try { vm.evalCode(`(() => {\n${code}\n})();`, "plan.js").dispose(); }
		catch (e) { return { ok: false, error: `plan code error: ${e instanceof Error ? e.message : String(e)}` }; }
		const json = vm.dump(vm.evalCode("__plan()")) as string;
		const program = JSON.parse(json) as Program;
		const count = (nodes: Program["nodes"]): number => nodes.reduce((n, x) => n + 1 + ("body" in x ? count(x.body) : 0), 0);
		if (count(program.nodes) > (limits.maxNodes ?? 2000)) return { ok: false, error: `the plan has too many steps (limit ${limits.maxNodes ?? 2000})` };
		try { validate(program); } catch (e) { return { ok: false, error: `invalid plan: ${e instanceof Error ? e.message : String(e)}` }; }
		return { ok: true, program };
	} catch (e) {
		return { ok: false, error: `plan code error: ${e instanceof Error ? e.message : String(e)}` };
	} finally {
		try { vm.dispose(); } catch { /* gone */ }
	}
}
