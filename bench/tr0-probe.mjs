#!/usr/bin/env node
/**
 * TR-0 — the three-loss probe (design round; zero product diff).
 *
 * Scans every durable session log under bench/runs/ and counts the
 * three loss classes the TR-0 design separates:
 *
 *   1. INGRESS LOSS   — shell overflow: bytes dropped before the log
 *                       (the only TRUE loss; finding PH-F24)
 *   2. PROJECTION CLEARING — microcompacted boundaries (data durable,
 *                       model view cleared; recoverable by design)
 *   3. SUMMARY REPLACEMENT — summarized events (same: durable, view
 *                       compressed)
 *
 * TR-1's priority follows these numbers, not intuition.
 *
 *   node bench/tr0-probe.mjs [runsDir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? join(new URL(".", import.meta.url).pathname, "runs");

function* sessionLogs(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) yield* sessionLogs(p);
		else if (name.endsWith(".jsonl") && dir.includes("sessions") && !dir.includes("traces")) yield p;
	}
}

const CAP_RE = /capped at \d+ chars — (\d+) more chars dropped/g;

let files = 0;
let runs = 0;
let overflowNotes = 0;
let droppedBytes = 0;
let microcompacted = 0;
let summarized = 0;
let toolResults = 0;

for (const f of sessionLogs(root)) {
	files += 1;
	let text;
	try {
		text = readFileSync(f, "utf8");
	} catch {
		continue;
	}
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const ev = rec.event ?? rec;
		if (ev.type === "user_input") runs += 1;
		if (ev.type === "microcompacted") microcompacted += 1;
		if (ev.type === "summarized") summarized += 1;
		if (ev.type === "tool_result") {
			toolResults += 1;
			const content = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content ?? "");
			for (const m of content.matchAll(CAP_RE)) {
				overflowNotes += 1;
				droppedBytes += Number(m[1]);
			}
		}
	}
}

console.log(JSON.stringify({
	corpus: root,
	sessionLogs: files,
	userTurns: runs,
	toolResults,
	ingressLoss: { overflowNotes, droppedBytes, perToolResultRate: toolResults > 0 ? overflowNotes / toolResults : null },
	projectionClearing: { microcompacted },
	summaryReplacement: { summarized },
}, null, 1));
