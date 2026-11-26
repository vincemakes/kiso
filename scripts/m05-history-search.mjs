#!/usr/bin/env node
/**
 * ADR-0063 M0.5 — the real-log half of the retrieval check (M0.5 spec § 4,
 * test 7). For every effective evidence of every log: the seq lookup must
 * return it, and so must a query for a word of its own content, alone and
 * together with its seq. Slow on purpose (every query rescans the log):
 * about three minutes over the owner's ~100 logs. Prints COUNTS ONLY —
 * logs, evidence checked, misses per check — never content: the logs are
 * the owner's work. A fixture source, never the population.
 *
 *   npm run build && node scripts/m05-history-search.mjs <session.jsonl> [...]
 *
 * Local only, on purpose: it reads ONLY the paths given on argv (never a
 * default directory), prints counts and log basenames only, and never runs
 * in CI or from `npm run check` — no CI machine holds the owner's logs, and
 * none should.
 *
 * Expected: zero misses. Any miss is a finding, not a tolerance; the
 * per-log line names the log by its file name only.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { effectiveHistory } from "../packages/runtime/dist/effective-history.js";
import { searchHistory } from "../packages/runtime/dist/history-search.js";

const paths = process.argv.slice(2);
if (paths.length === 0) {
	console.error("usage: node scripts/m05-history-search.mjs <session.jsonl> [...]");
	process.exit(2);
}

const ALL = 1e9;
const totals = { logs: 0, unreadable: 0, events: 0, checked: 0, covered: 0, noWord: 0, missSeq: 0, missWordAtSeq: 0, missWord: 0 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A word of the content that a query can carry: no quote, no whitespace. */
const wordOf = (content) => content.split(/\s+/).find((w) => w.length >= 3 && !w.includes('"'));

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
	const misses = { seq: 0, wordAtSeq: 0, word: 0 };
	const evidence = effectiveHistory(events).filter((e) => e.structuralStatus === "effective");
	for (const e of evidence) {
		totals.checked += 1;
		if (e.provenance.coveredBy !== undefined) totals.covered += 1;
		if (!searchHistory(events, { seq: e.seq, limit: ALL }).hits.some((h) => same(h, e))) misses.seq += 1;
		const word = wordOf(e.content);
		if (word === undefined) {
			totals.noWord += 1;
			continue;
		}
		if (!searchHistory(events, { seq: e.seq, query: word, limit: ALL }).hits.some((h) => same(h, e))) misses.wordAtSeq += 1;
		if (!searchHistory(events, { query: word, limit: ALL }).hits.some((h) => same(h, e))) misses.word += 1;
	}
	totals.missSeq += misses.seq;
	totals.missWordAtSeq += misses.wordAtSeq;
	totals.missWord += misses.word;
	if (misses.seq + misses.wordAtSeq + misses.word > 0) console.log(JSON.stringify({ log: basename(path), misses }));
}
console.log(JSON.stringify(totals));
process.exit(totals.missSeq + totals.missWordAtSeq + totals.missWord === 0 ? 0 : 1);
