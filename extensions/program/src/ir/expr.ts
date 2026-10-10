import type { Expr, Json } from "./types.js";

export type Lookup = (name: string) => { found: true; value: Json } | { found: false };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Evaluate a pure expression. Throws Error with a plain message on a type error or a missing reference. */
export function evaluate(e: Expr, look: Lookup, item?: Json): Json {
	if ("lit" in e) return e.lit;
	if ("ref" in e) {
		let v: Json;
		if (e.ref === "$") {
			if (item === undefined) throw new Error("`$` is only available inside a filter");
			v = item;
		} else {
			const r = look(e.ref);
			if (!r.found) throw new Error(`unknown reference "${e.ref}"`);
			v = r.value;
		}
		for (const p of e.path ?? []) {
			if (v === null || typeof v !== "object") throw new Error(`cannot read "${String(p)}" of ${v === null ? "null" : typeof v} at ${e.ref}`);
			if (typeof p === "number") { if (!Array.isArray(v)) throw new Error(`index ${p} on a non-list at ${e.ref}`); v = v[p] ?? null; }
			else { if (Array.isArray(v) || !own(v, p)) { v = null; continue; } v = (v as Record<string, Json>)[p]!; }
		}
		return v;
	}
	if ("arr" in e) return e.arr.map((x) => evaluate(x, look, item));
	if ("obj" in e) { const o: Record<string, Json> = {}; for (const [k, x] of Object.entries(e.obj)) o[k] = evaluate(x, look, item); return o; }
	const ev = (x: Expr): Json => evaluate(x, look, item);
	const list = (x: Expr): Json[] => { const v = ev(x); if (!Array.isArray(v)) throw new Error("expected a list"); return v; };
	switch (e.op) {
		case "not": return !truthy(ev(e.a));
		case "len": { const v = ev(e.a); return Array.isArray(v) || typeof v === "string" ? v.length : 0; }
		case "isEmpty": { const v = ev(e.a); return v === null || (Array.isArray(v) || typeof v === "string" ? v.length === 0 : typeof v === "object" ? Object.keys(v).length === 0 : false); }
		case "eq": return JSON.stringify(ev(e.a)) === JSON.stringify(ev(e.b));
		case "neq": return JSON.stringify(ev(e.a)) !== JSON.stringify(ev(e.b));
		case "gt": return num(ev(e.a)) > num(ev(e.b));
		case "gte": return num(ev(e.a)) >= num(ev(e.b));
		case "lt": return num(ev(e.a)) < num(ev(e.b));
		case "lte": return num(ev(e.a)) <= num(ev(e.b));
		case "and": return truthy(ev(e.a)) && truthy(ev(e.b));
		case "or": return truthy(ev(e.a)) || truthy(ev(e.b));
		case "add": return num(ev(e.a)) + num(ev(e.b));
		case "concat": return e.parts.map((p) => { const v = ev(p); return typeof v === "string" ? v : JSON.stringify(v); }).join("");
		case "join": return list(e.list).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(e.sep);
		case "pluck": return list(e.list).map((v) => (v !== null && typeof v === "object" && !Array.isArray(v) && own(v, e.key) ? (v as Record<string, Json>)[e.key]! : null));
		case "filter": return list(e.list).filter((v) => truthy(evaluate(e.where, look, v)));
		case "sum": return list(e.list).reduce<number>((s, v) => s + num(v), 0);
		case "if": return truthy(ev(e.cond)) ? ev(e.then) : ev(e.else);
	}
}

const truthy = (v: Json): boolean => !(v === null || v === false || v === 0 || v === "");
const num = (v: Json): number => { if (typeof v !== "number") throw new Error(`expected a number, got ${v === null ? "null" : typeof v}`); return v; };

/** The reference names an expression mentions (the dependencies of a node). */
export function refsOf(e: Expr, out: Set<string> = new Set()): Set<string> {
	if ("lit" in e) return out;
	if ("ref" in e) { if (e.ref !== "$") out.add(e.ref); return out; }
	if ("arr" in e) { e.arr.forEach((x) => refsOf(x, out)); return out; }
	if ("obj" in e) { Object.values(e.obj).forEach((x) => refsOf(x, out)); return out; }
	switch (e.op) {
		case "not": case "len": case "isEmpty": refsOf(e.a, out); break;
		case "eq": case "neq": case "gt": case "gte": case "lt": case "lte": case "and": case "or": case "add": refsOf(e.a, out); refsOf(e.b, out); break;
		case "concat": e.parts.forEach((x) => refsOf(x, out)); break;
		case "join": case "pluck": case "sum": refsOf(e.list, out); break;
		case "filter": refsOf(e.list, out); refsOf(e.where, out); break;
		case "if": refsOf(e.cond, out); refsOf(e.then, out); refsOf(e.else, out); break;
	}
	return out;
}
