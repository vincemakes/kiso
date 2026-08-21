#!/usr/bin/env node
/**
 * EX-0 — the Bound Experience verifier (external, reads durable-log
 * slices only). The EX axiom: an experience system cannot certify
 * itself, so this verifier never reads a "memory" — it reads the raw
 * durable-log slices under evidence/ and checks each experience's
 * predicates mechanically. An un-checkable binding is no binding.
 *
 * usage: verifier.mjs [experiences-dir] [evidence-dir]
 * exit 0 iff every experience BINDS (all predicates hold, support is
 * consistent, validity is well-formed).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const expDir = process.argv[2] || join(HERE, "experiences");
const evDir = process.argv[3] || join(HERE, "evidence");

function loadSlice(rel) {
	const p = join(evDir, rel.replace(/^evidence\//, ""));
	if (!existsSync(p)) return { error: `slice not found: ${rel}` };
	try {
		return { events: JSON.parse(readFileSync(p, "utf8")).events };
	} catch (e) {
		return { error: `slice unreadable: ${rel} (${e.message})` };
	}
}

function evalPredicate(pred, slice) {
	if (slice.error) return { ok: false, why: slice.error };
	const evs = slice.events || [];
	const cmp = (a, op, b) =>
		op === "==" ? a === b : op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : op === "<" ? a < b : null;
	switch (pred.kind) {
		case "event_count": {
			const n = evs.filter((e) => e.name === pred.name && (!pred.type || e.type === pred.type)).length;
			return { ok: cmp(n, pred.op, pred.value), why: `count(${pred.name}/${pred.type || "*"})=${n} ${pred.op} ${pred.value}` };
		}
		case "no_event_named": {
			const n = evs.filter((e) => e.name === pred.name).length;
			return { ok: n === 0, why: `count(${pred.name})=${n} (want 0)` };
		}
		case "ledger_attempts": {
			const atts = new Set(evs.filter((e) => e.phase === "start").map((e) => e.attempt));
			return { ok: cmp(atts.size, pred.op, pred.value), why: `distinct attempts=${atts.size} ${pred.op} ${pred.value}` };
		}
		case "ledger_ends": {
			const n = evs.filter((e) => e.phase === "end").length;
			return { ok: cmp(n, pred.op, pred.value), why: `end rows=${n} ${pred.op} ${pred.value}` };
		}
		case "final_status": {
			const row = evs.find((e) => e.kind === "status");
			return { ok: row && row.value === pred.value, why: `status=${row ? row.value : "MISSING"} (want ${pred.value})` };
		}
		default:
			return { ok: false, why: `unknown predicate kind '${pred.kind}' — un-checkable binding is no binding` };
	}
}

const VALID_STATUS = new Set(["corroborated", "provisional", "refuted", "superseded", "invalidated"]);

function verifyExperience(exp) {
	const errs = [];
	if (!exp.assertion || typeof exp.assertion !== "string") errs.push("missing assertion");
	if (!Array.isArray(exp.boundEvidence) || exp.boundEvidence.length === 0) errs.push("no boundEvidence (unbound = rejected)");
	if (!exp.scope || Object.keys(exp.scope).length === 0) errs.push("no scope (a model-specific behavior may not become a universal law)");
	if (!exp.validity || !VALID_STATUS.has(exp.validity.status)) errs.push("missing/invalid validity.status");
	if (!Array.isArray(exp.antiEvidence)) errs.push("antiEvidence must be present (may be empty, but the field is mandatory — a record with no counter-evidence is a bias incubator)");

	for (const b of exp.boundEvidence || []) {
		const r = evalPredicate(b.predicate || {}, loadSlice(b.slice || ""));
		if (!r.ok) errs.push(`binding FAILED [${b.source}]: ${r.why}`);
	}
	// support consistency: if the experience claims n-of-m, at least the
	// bound slices must not contradict it (we can only check the ones
	// provided; the claim's n must be >= the confirming slices).
	if (exp.support && exp.boundEvidence) {
		const confirming = exp.boundEvidence.length;
		if (typeof exp.support.n === "number" && exp.support.n < confirming) {
			errs.push(`support.n (${exp.support.n}) < confirming slices (${confirming}) — inconsistent`);
		}
	}
	return errs;
}

function main() {
	const files = readdirSync(expDir).filter((f) => f.endsWith(".json")).sort();
	let bad = 0;
	for (const f of files) {
		const exp = JSON.parse(readFileSync(join(expDir, f), "utf8"));
		const errs = verifyExperience(exp);
		if (errs.length === 0) {
			console.log(`[ex0] BOUND ${exp.id} — "${exp.assertion.slice(0, 70)}" (${exp.validity.status})`);
		} else {
			bad += 1;
			console.log(`[ex0] UNBOUND ${exp.id}:`);
			for (const e of errs) console.log(`         - ${e}`);
		}
	}
	console.log(`[ex0] ${bad === 0 ? "PASS" : "FAIL"} — ${files.length} experiences, ${bad} unbound`);
	process.exit(bad === 0 ? 0 : 1);
}

main();
