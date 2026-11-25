#!/usr/bin/env node
/**
 * ADR-0063 M0 — the real-log half of the parity check (spec rev 2.2 § 4,
 * test 6). Runs effective history and its projection-parity check over
 * session logs and prints COUNTS ONLY: logs read, evidence per kind and
 * status, parity mismatches, and occurrences of the P0 trajectory family.
 * It reads the logs, writes nothing, and never prints content — the logs
 * are the owner's work. A fixture source, never the population.
 *
 *   npm run build && node scripts/m0-effective-history.mjs <session.jsonl> [...]
 *
 * Expected: zero parity mismatches. Any mismatch is a finding, not a
 * tolerance; the per-log line names the log by its file name only.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveHistory } from "@vincemakes/kiso-core";
import { effectiveHistory, parityMismatches } from "../packages/runtime/dist/effective-history.js";

const paths = process.argv.slice(2);
if (paths.length === 0) {
	console.error("usage: node scripts/m0-effective-history.mjs <session.jsonl> [...]");
	process.exit(2);
}

const totals = { logs: 0, unreadable: 0, events: 0, evidence: {}, statuses: {}, covered: 0, mismatchedLogs: 0, p0Family: 0 };
const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);

/** The P0 family: a result naming an invocation that did not project while
 *  an earlier projected call shares its callId — the shape the pre-P0
 *  projection rendered and P0 drops. */
function p0Family(events) {
	const r = resolveHistory(events);
	const current = new Map();
	const currentCallIds = new Set();
	let n = 0;
	for (const e of events) {
		if (e.type === "tool_call_end") {
			const projects = r.status(e) === "effective";
			current.set(e.seq, projects);
			if (projects) currentCallIds.add(e.callId);
		} else if (e.type === "tool_result" && e.invocationSeq !== undefined && r.status(e) === "effective") {
			if (current.get(e.invocationSeq) !== true && currentCallIds.has(e.callId)) n += 1;
		}
	}
	return n;
}

for (const path of paths) {
	let events;
	try {
		events = readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l).event)
			.filter((e) => e !== undefined && typeof e.type === "string");
	} catch {
		totals.unreadable += 1;
		continue;
	}
	totals.logs += 1;
	totals.events += events.length;
	for (const e of effectiveHistory(events)) {
		bump(totals.evidence, e.kind);
		bump(totals.statuses, e.structuralStatus);
		if (e.provenance.coveredBy !== undefined) totals.covered += 1;
	}
	totals.p0Family += p0Family(events);
	const mismatches = parityMismatches(events);
	if (mismatches.length > 0) {
		totals.mismatchedLogs += 1;
		// role and count or index only — never content
		console.log(JSON.stringify({ log: basename(path), mismatches }));
	}
}
console.log(JSON.stringify(totals));
process.exit(totals.mismatchedLogs === 0 ? 0 : 1);
