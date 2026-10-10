/**
 * One engine, two schedules. "sequential" is the REFERENCE: instances run one at a time in
 * program order. "parallel" runs an instance as soon as (a) the instances it refers to (or
 * names in `after`) are done, (b) nothing EARLIER in program order that it could conflict with
 * is still pending or running, and (c) no earlier container that could still add calls has
 * to expand. A conflict is decided from effects a TRUSTED host declared (unknown = conflicts
 * with everything non-pure). Both schedules share every other line: evaluation, failure
 * propagation, container semantics. The parallel one is correct iff it is observationally equal
 * to the sequential one.
 *
 * Failure semantics (the same in both): a call that fails is "failed"; an instance that refers
 * to, or is `after`, a failed or skipped instance is "skipped"; everything independent still
 * runs; a `when` that is false makes the instance "done" with value null. A `map` is done with
 * null for an element whose body failed.
 */
import { evaluate, refsOf, type Lookup } from "./expr.js";
import type { Effect, Expr, Json, Node, Program, RunOptions, RunResult, Status } from "./types.js";

interface Scope { vars: Map<string, Json>; insts: Map<string, Inst>; parent?: Scope }
interface Inst {
	pos: number[]; node: Node; scope: Scope; parent?: Inst; status: Status; value?: Json; error?: string;
	deps?: Inst[]; args?: Json;
	/** containers: all calls this instance can ever add are already instances */
	expanded: boolean;
	elems?: { scope: Scope; kids: Inst[] }[];
	loop?: { iter: number; state: Json; scope: Scope; kids: Inst[] };
}

const MAX_UNTIL = 50;

/** Static checks: unique ids per scope; every reference names something EARLIER and visible. */
export function validate(program: Program): void {
	const check = (nodes: Node[], visible: Set<string>): void => {
		const here = new Set<string>(visible);
		const own = new Set<string>();
		const needs = (e: Expr | undefined, id: string, extra: string[] = []): void => {
			if (e === undefined) return;
			for (const r of refsOf(e)) if (!here.has(r) && !extra.includes(r)) throw new Error(`node "${id}" refers to "${r}", which is not defined before it`);
		};
		for (const n of nodes) {
			if (own.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
			for (const a of n.after ?? []) if (!here.has(a)) throw new Error(`node "${n.id}" is after "${a}", which is not defined before it`);
			needs(n.when, n.id);
			if (n.kind === "call") needs(n.args, n.id);
			else if (n.kind === "let") needs(n.value, n.id);
			else if (n.kind === "map") {
				needs(n.over, n.id);
				check(n.body, new Set([...here, n.as]));
				const inner = new Set<string>([...here, n.as, ...n.body.map((b) => b.id)]);
				for (const r of refsOf(n.yield)) if (!inner.has(r)) throw new Error(`yield of "${n.id}" refers to "${r}", which is not visible`);
			} else {
				if (!(n.max >= 1 && n.max <= MAX_UNTIL)) throw new Error(`until "${n.id}": max must be 1..${MAX_UNTIL}`);
				needs(n.init, n.id);
				check(n.body, new Set([...here, n.as]));
				const inner = new Set<string>([...here, n.as, ...n.body.map((b) => b.id)]);
				for (const e of [n.next, n.done]) for (const r of refsOf(e)) if (!inner.has(r)) throw new Error(`until "${n.id}" refers to "${r}", which is not visible`);
			}
			own.add(n.id); here.add(n.id);
		}
	};
	check(program.nodes, new Set());
	const out = new Set<string>(program.nodes.map((n) => n.id));
	for (const r of refsOf(program.output)) if (!out.has(r)) throw new Error(`output refers to "${r}", which is not a top-level node`);
}

const cmp = (a: number[], b: number[]): number => {
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return a.length - b.length;
};
const isAncestor = (a: Inst, b: Inst): boolean => { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; };

export function conflicts(a: Effect, b: Effect): boolean {
	if (a.kind === "pure" || b.kind === "pure") return false;
	if (a.kind === "unknown" || b.kind === "unknown") return true;
	if (a.kind === "read" && b.kind === "read") return false;
	if (a.keys === "*" || b.keys === "*") return true;
	return a.keys.some((k) => (b.keys as string[]).includes(k));
}

export async function run(program: Program, opts: RunOptions): Promise<RunResult> {
	validate(program);
	const maxConc = opts.mode === "sequential" ? 1 : (opts.maxConcurrency ?? 8);
	const maxCalls = opts.maxCalls ?? 10_000;
	const all: Inst[] = [];
	const root: Scope = { vars: new Map(), insts: new Map() };
	const make = (node: Node, pos: number[], scope: Scope, parent?: Inst): Inst => {
		const inst: Inst = { pos, node, scope, status: "pending", expanded: false, ...(parent ? { parent } : {}) };
		scope.insts.set(node.id, inst);
		all.push(inst);
		return inst;
	};
	program.nodes.forEach((n, i) => make(n, [i], root));

	const find = (scope: Scope, name: string): { inst: Inst } | { value: Json } | undefined => {
		for (let s: Scope | undefined = scope; s; s = s.parent) {
			if (s.insts.has(name)) return { inst: s.insts.get(name)! };
			if (s.vars.has(name)) return { value: s.vars.get(name)! };
		}
		return undefined;
	};
	const lookupIn = (scope: Scope): Lookup => (name) => {
		const f = find(scope, name);
		if (f === undefined) return { found: false };
		if ("value" in f) return { found: true, value: f.value };
		return { found: true, value: f.inst.value ?? null };
	};
	const terminal = (i: Inst): boolean => i.status === "done" || i.status === "failed" || i.status === "skipped";
	const exprsOf = (n: Node): Expr[] => {
		const es: Expr[] = [];
		if (n.when) es.push(n.when);
		if (n.kind === "call") es.push(n.args); else if (n.kind === "let") es.push(n.value); else if (n.kind === "map") es.push(n.over); else es.push(n.init);
		return es;
	};
	const depsOf = (inst: Inst): Inst[] => {
		if (inst.deps) return inst.deps;
		const names = new Set<string>(inst.node.after ?? []);
		for (const e of exprsOf(inst.node)) refsOf(e, names);
		const deps: Inst[] = [];
		for (const nm of names) { const f = find(inst.scope, nm); if (f && "inst" in f && f.inst !== inst) deps.push(f.inst); }
		inst.deps = deps;
		return deps;
	};

	/**
	 * The arguments of a call that is not ready yet, as far as they are known: fields whose inputs are all
	 * finished are evaluated; the others are ABSENT. A host's effect declaration must treat an absent field it
	 * needs as unknown (the conservative answer): that is what lets `put {k: "b3", v: <not yet>}` be recognised
	 * as touching only b3 instead of blocking everything behind it.
	 */
	const partialArgs = (inst: Inst): Json | undefined => {
		if (inst.args !== undefined) return inst.args;
		const ex = inst.node.kind === "call" ? inst.node.args : undefined;
		if (!ex || !("obj" in ex)) return undefined;
		const o: Record<string, Json> = {};
		for (const [k, fe] of Object.entries(ex.obj)) {
			const names = new Set<string>(); refsOf(fe, names);
			const ready = [...names].every((nm) => { const f = find(inst.scope, nm); return f === undefined || "value" in f || f.inst.status === "done"; });
			if (!ready) continue;
			try { o[k] = evaluate(fe, lookupIn(inst.scope)); } catch { /* unknown stays absent */ }
		}
		return o;
	};

	let inFlight = 0, maxInFlight = 0, made = 0;
	const started: { tool: string; args: Json }[] = [];
	let wake: (() => void) | null = null;
	const poke = (): void => { const w = wake; wake = null; w?.(); };

	const fail = (inst: Inst, msg: string): void => { inst.status = "failed"; inst.error = msg; };
	const safe = <T>(inst: Inst, f: () => T): T | undefined => { try { return f(); } catch (e) { fail(inst, e instanceof Error ? e.message : String(e)); return undefined; } };

	const spawnBody = (parent: Inst, body: Node[], scope: Scope, prefix: number[]): Inst[] => body.map((b, j) => make(b, [...prefix, j], scope, parent));

	/** one scheduling pass; true if anything changed */
	const pass = (): boolean => {
		let changed = false;
		const live = all.filter((i) => i.status === "pending" || i.status === "running").sort((a, b) => cmp(a.pos, b.pos));
		for (const inst of live) {
			if (inst.status === "running" && inst.node.kind !== "map" && inst.node.kind !== "until") continue;
			// anything that creates instances ends the pass: the next pass must see them, or a later
			// instance in THIS pass would miss an earlier-in-order conflicting call that now exists
			if (inst.status === "running") { if (advanceContainer(inst)) return true; continue; }
			// pending
			const deps = depsOf(inst);
			if (!deps.every(terminal)) continue;
			if (deps.some((d) => d.status === "failed" || d.status === "skipped")) { inst.status = "skipped"; changed = true; continue; }
			if (opts.mode === "sequential" && live.some((e) => e !== inst && cmp(e.pos, inst.pos) < 0 && !isAncestor(e, inst) && !terminal(e))) continue;
			if (inst.node.when) {
				const w = safe(inst, () => evaluate(inst.node.when!, lookupIn(inst.scope)));
				if (inst.status === "failed") { changed = true; continue; }
				if (w === null || w === false || w === 0 || w === "") { inst.status = "done"; inst.value = null; inst.expanded = true; changed = true; continue; }
			}
			const n = inst.node;
			if (n.kind === "let") {
				const v = safe(inst, () => evaluate(n.value, lookupIn(inst.scope)));
				if (inst.status !== "failed") { inst.value = v!; inst.status = "done"; }
				changed = true; continue;
			}
			if (n.kind === "call") {
				if (inFlight >= maxConc) continue;
				if (inst.args === undefined) { const a = safe(inst, () => evaluate(n.args, lookupIn(inst.scope))); if (inst.status === "failed") { changed = true; continue; } inst.args = a!; }
				if (opts.mode === "parallel") {
					const mine = opts.effects(n.tool, inst.args);
					let blocked = false;
					if (mine.kind !== "pure") {
						for (const e of live) {
							if (e === inst || cmp(e.pos, inst.pos) >= 0 || isAncestor(e, inst) || terminal(e)) continue;
							if (e.node.kind === "map" || e.node.kind === "until") { if (!e.expanded) { blocked = true; break; } continue; }
							if (e.node.kind === "call" && conflicts(opts.effects(e.node.tool, partialArgs(e)), mine)) { blocked = true; break; }
						}
					}
					if (blocked) continue;
				}
				if (made >= maxCalls) { fail(inst, `call budget exhausted (${maxCalls})`); changed = true; continue; }
				made += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
				inst.status = "running"; started.push({ tool: n.tool, args: inst.args });
				void opts.call(n.tool, inst.args).then(
					(r) => { if (r.ok) { inst.value = r.value ?? null; inst.status = "done"; } else fail(inst, r.error ?? "error"); },
					(e: unknown) => fail(inst, e instanceof Error ? e.message : String(e)),
				).finally(() => { inFlight -= 1; poke(); });
				changed = true; continue;
			}
			if (n.kind === "map") {
				const over = safe(inst, () => evaluate(n.over, lookupIn(inst.scope)));
				if (inst.status === "failed") { changed = true; continue; }
				if (!Array.isArray(over)) { fail(inst, "map: `over` is not a list"); changed = true; continue; }
				inst.status = "running"; inst.expanded = true;
				inst.elems = over.map((item, e) => {
					const scope: Scope = { vars: new Map([[n.as, item]]), insts: new Map(), parent: inst.scope };
					return { scope, kids: spawnBody(inst, n.body, scope, [...inst.pos, e]) };
				});
				return true;
			}
			// until
			const init = safe(inst, () => evaluate(n.init, lookupIn(inst.scope)));
			if (inst.status === "failed") { changed = true; continue; }
			inst.status = "running";
			inst.loop = { iter: 0, state: init!, scope: undefined as unknown as Scope, kids: [] };
			startIteration(inst);
			return true;
		}
		return changed;
	};

	function startIteration(inst: Inst): void {
		const n = inst.node as Extract<Node, { kind: "until" }>;
		const L = inst.loop!;
		const scope: Scope = { vars: new Map([[n.as, L.state]]), insts: new Map(), parent: inst.scope };
		L.scope = scope; L.kids = spawnBody(inst, n.body, scope, [...inst.pos, L.iter]);
	}

	function advanceContainer(inst: Inst): boolean {
		const n = inst.node;
		if (n.kind === "map") {
			const els = inst.elems!;
			if (!els.every((e) => e.kids.every(terminal))) return false;
			const out: Json[] = [];
			for (const e of els) {
				if (e.kids.some((k) => k.status === "failed" || k.status === "skipped")) { out.push(null); continue; }
				try { out.push(evaluate(n.yield, lookupIn(e.scope))); } catch { out.push(null); }
			}
			inst.value = out; inst.status = "done"; return true;
		}
		const u = n as Extract<Node, { kind: "until" }>;
		const L = inst.loop!;
		if (!L.kids.every(terminal)) return false;
		if (L.kids.some((k) => k.status === "failed" || k.status === "skipped")) { fail(inst, `until "${u.id}": an iteration failed`); inst.expanded = true; return true; }
		let next: Json, done: Json;
		try { next = evaluate(u.next, lookupIn(L.scope)); done = evaluate(u.done, lookupIn(L.scope)); } catch (e) { fail(inst, e instanceof Error ? e.message : String(e)); inst.expanded = true; return true; }
		L.state = next; L.iter += 1;
		const stop = !(done === null || done === false || done === 0 || done === "");
		if (stop || L.iter >= u.max) { inst.value = L.state; inst.status = "done"; inst.expanded = true; return true; }
		startIteration(inst);
		return true;
	}

	for (;;) {
		while (pass()) { /* drain everything that can move now */ }
		if (all.every(terminal)) break;
		if (inFlight === 0 && !all.some((i) => i.status === "running")) {
			// nothing runs and nothing moved: every pending instance is blocked on something that cannot finish
			for (const i of all) if (i.status === "pending") { i.status = "failed"; i.error = "deadlock: blocked on an instance that cannot finish"; }
			break;
		}
		await new Promise<void>((r) => { wake = r; });
	}

	const nodes: RunResult["nodes"] = {};
	for (const i of all) nodes[i.pos.join(".")] = { id: i.node.id, status: i.status, ...(i.value !== undefined ? { value: i.value } : {}) };
	const failedNodes = all.filter((i) => i.status === "failed").sort((a, b) => cmp(a.pos, b.pos)); // program order, not creation order
	let output: Json | undefined; let error: string | undefined;
	if (failedNodes.length > 0) error = `failed: ${failedNodes.map((i) => `${i.pos.join(".")}:${i.node.id}`).join(", ")}`;
	try {
		const bad = [...refsOf(program.output)].map((r) => root.insts.get(r)!).find((i) => i.status === "failed" || i.status === "skipped");
		if (bad) throw new Error(`output depends on ${bad.status} node "${bad.node.id}"`);
		output = evaluate(program.output, lookupIn(root));
	} catch (e) { error = `${error ? `${error}; ` : ""}${e instanceof Error ? e.message : String(e)}`; }
	const errors = failedNodes.map((i) => ({ id: i.node.id, ...(i.node.kind === "call" ? { tool: i.node.tool } : {}), ...(i.args !== undefined ? { args: i.args } : {}), error: i.error ?? "failed" }));
	return { ok: error === undefined, ...(output !== undefined ? { output } : {}), ...(error !== undefined ? { error } : {}), nodes, errors, started, maxInFlight };
}
