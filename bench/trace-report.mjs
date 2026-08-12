#!/usr/bin/env node
/**
 * E1 (1.2.0) — slice 5, the per-request trace report.
 *
 * Reads the request-trace ledgers (sessions/traces/<sid>.jsonl, the E1
 * sidecar — format reference: docs/request-trace.md) and the session
 * event log, and renders the per-request table: usage quartet, est
 * vs actual, ttft/latency, tool calls, the R4b cache-break depth, and
 * outcome — plus session totals. The break derivation consumes the
 * runtime's analyze.js via the built dist (proposal §4 precedent:
 * scripts/api-surface.mjs resolves dist).
 *
 *   node bench/trace-report.mjs --home <KISO_HOME> [--session <sid>] [--json]
 *
 * Defaults: --home = $KISO_HOME (or ./kiso-home), all sessions. --json
 * emits the structured rows (the python gate asserts on this shape);
 * the default is the markdown table for the bench report.
 *
 * Zero exports, zero surface (R2 Case B): a bench tool that reads the
 * sidecar the runtime writes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveBreaks, cacheableHashes } from "../packages/runtime/dist/trace/analyze.js";
import { validateTraceLine } from "../packages/runtime/dist/trace/record.js";

function argValue(args, name, fallback) {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const home = argValue(args, "--home", process.env.KISO_HOME ?? join(process.cwd(), "kiso-home"));
const onlySession = argValue(args, "--session", null);
const asJson = args.includes("--json");

function readLedger(sessionId) {
	const path = join(home, "sessions", "traces", `${sessionId}.jsonl`);
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	const header = [];
	const requests = [];
	const runEnds = [];
	const crashes = [];
	let invalid = 0;
	for (const line of lines) {
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			invalid += 1;
			continue;
		}
		if (!validateTraceLine(obj)) {
			invalid += 1;
			continue;
		}
		if (obj.kind === "header") header.push(obj);
		else if (obj.kind === "request") requests.push(obj);
		else if (obj.kind === "run_end") runEnds.push(obj);
		else if (obj.kind === "crash") crashes.push(obj);
	}
	return { path, header, requests, runEnds, crashes, invalid };
}

function readEventLog(sessionId) {
	const path = join(home, "sessions", `${sessionId}.jsonl`);
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	let lastSeq = -1;
	let count = 0;
	for (const line of lines) {
		try {
			const seq = JSON.parse(line).event?.seq;
			if (typeof seq === "number") {
				count += 1;
				if (seq > lastSeq) lastSeq = seq;
			}
		} catch {
			// a torn line at the tail — the store repairs it on open
		}
	}
	return { path, lastSeq, count };
}

/** One row per request: the usage quartet, est vs actual, timing,
 *  tools, the R4b break depth, and the seq-range integrity check
 *  (manifest ranges must stay within the event log). */
function summarize(sessionId, ledger) {
	const log = readEventLog(sessionId);
	const requests = ledger.requests;
	const breaks = deriveBreaks(requests.map((r) => cacheableHashes(r.contextManifest, r.segmentHashes)));
	const rows = requests.map((r, i) => {
		const estTokens = r.contextManifest.reduce((acc, s) => acc + s.estTokens, 0);
		const actual = r.freshInput + r.cacheRead;
		const breakDepth = breaks[i] === null ? null : breaks[i].depth;
		const rangeOk =
			log === null ||
			r.contextManifest.every(
				(s) => s.seqRange === null || (log.lastSeq >= 0 && s.seqRange[1] <= log.lastSeq),
			);
		return {
			index: r.requestIndex,
			retryAttempt: r.retryAttempt,
			fresh: r.freshInput,
			cacheRead: r.cacheRead,
			cacheWrite: r.cacheWrite,
			output: r.output,
			estTokens,
			estVsActual: estTokens - actual,
			ttftMs: r.ttftMs,
			latencyMs: r.latencyMs,
			toolCalls: r.toolCalls,
			breakDepth,
			outcome: r.outcome,
			seqRangeOk: rangeOk,
		};
	});
	const sum = (f) => rows.reduce((acc, r) => acc + r[f], 0);
	return {
		sessionId,
		kisoVersion: ledger.header[0]?.kisoVersion ?? null,
		eventLog: log === null ? null : { lastSeq: log.lastSeq, count: log.count },
		rows,
		totals: {
			requests: rows.length,
			fresh: sum("fresh"),
			cacheRead: sum("cacheRead"),
			cacheWrite: rows.reduce((acc, r) => acc + (r.cacheWrite ?? 0), 0),
			output: sum("output"),
			breaks: rows.filter((r) => r.breakDepth !== null).length,
			avgLatencyMs: rows.length === 0 ? null : sum("latencyMs") / rows.length,
		},
		runEnds: ledger.runEnds.length,
		crashes: ledger.crashes.length,
		invalid: ledger.invalid,
	};
}

function markdown(report) {
	const out = [];
	out.push(`## ${report.sessionId} — request trace (${report.totals.requests} requests${report.kisoVersion ? `, kiso ${report.kisoVersion}` : ""})`);
	out.push("");
	out.push("| # | retry | fresh | cacheRead | cacheWrite | output | est | est−actual | ttft | latency | tools | break | outcome |");
	out.push("|---|-----:|-----:|----------:|-----------:|-------:|----:|-----------:|-----:|--------:|-------|-------|---------|");
	for (const r of report.rows) {
		out.push(
			`| ${r.index} | ${r.retryAttempt} | ${r.fresh} | ${r.cacheRead} | ${r.cacheWrite ?? "–"} | ${r.output} | ${r.estTokens} | ${r.estVsActual} | ${Math.round(r.ttftMs)} | ${Math.round(r.latencyMs)} | ${r.toolCalls.join(",") || "–"} | ${r.breakDepth ?? "–"} | ${r.outcome} |`,
		);
	}
	out.push("");
	out.push(
		`**totals:** ${report.totals.requests} requests · fresh ${report.totals.fresh} · cacheRead ${report.totals.cacheRead} · cacheWrite ${report.totals.cacheWrite} · output ${report.totals.output} · ${report.totals.breaks} cache-prefix breaks · avg latency ${report.totals.avgLatencyMs === null ? "–" : Math.round(report.totals.avgLatencyMs * 10) / 10}ms`,
	);
	out.push(`ledger integrity: ${report.runEnds} run_end · ${report.crashes} crash · ${report.invalid} invalid line${report.invalid === 1 ? "" : "s"}`);
	const rangeBad = report.rows.filter((r) => !r.seqRangeOk).length;
	if (rangeBad > 0) out.push(`⚠ ${rangeBad} request${rangeBad === 1 ? "" : "s"} with seqRange beyond the event log`);
	return out.join("\n");
}

const sessionIds = onlySession !== null ? [onlySession] : existsSync(join(home, "sessions", "traces"))
	? readdirSync(join(home, "sessions", "traces")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6))
	: [];

const reports = [];
for (const sid of sessionIds) {
	const ledger = readLedger(sid);
	if (ledger === null) continue;
	reports.push(summarize(sid, ledger));
}

if (asJson) {
	console.log(JSON.stringify(reports, null, 2));
} else if (reports.length === 0) {
	console.log(`trace-report: no ledgers under ${join(home, "sessions", "traces")}`);
	process.exit(1);
} else {
	for (const r of reports) console.log(markdown(r) + "\n");
}
