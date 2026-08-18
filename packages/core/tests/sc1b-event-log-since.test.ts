/**
 * SC-1b slice ④ — `EventLog.since(seq)` is STRICTLY after.
 *
 * The doc says "incremental view for consumers that already saw `seq` and
 * before"; the base code filtered `e.seq >= seq` and therefore re-served
 * the very event the caller had just told it about. An incremental consumer
 * that polls `since(lastSeen)` in a loop sees the boundary event again on
 * every poll — one duplicate per poll, forever.
 *
 * SC-1 escalation 2 found ZERO call sites tree-wide, so this is a
 * contradiction fixed before it can bite, not an incident report: the code
 * moves to match the doc (the doc is the older, published promise), and
 * these pins keep the two from drifting apart again.
 */

import { describe, expect, it } from "vitest";
import { EventLog } from "../src/index.js";

function seeded(n: number): EventLog {
	const log = new EventLog();
	for (let i = 0; i < n; i++) log.append({ type: "user_input", content: `m${i}` });
	return log;
}

describe("SC-1b ④ since(seq) serves what comes AFTER seq", () => {
	it("since(0) omits seq 0 — the caller said it already saw it", () => {
		expect(seeded(3).since(0).map((e) => e.seq)).toEqual([1, 2]);
	});

	it("a caught-up caller gets nothing", () => {
		const log = seeded(3);
		expect(log.since(log.lastSeq)).toHaveLength(0);
	});

	it("a caller that has seen nothing passes -1 and gets the whole log", () => {
		expect(seeded(3).since(-1).map((e) => e.seq)).toEqual([0, 1, 2]);
	});

	it("polling delivers every event EXACTLY once — no duplicate at the seam", () => {
		const log = seeded(2);
		let seen = -1;
		const delivered: number[] = [];
		for (const ev of log.since(seen)) delivered.push(ev.seq);
		seen = log.lastSeq;

		log.append({ type: "user_input", content: "later" });
		for (const ev of log.since(seen)) delivered.push(ev.seq);

		expect(delivered).toEqual([0, 1, 2]);
		expect(new Set(delivered).size).toBe(delivered.length);
	});
});
