/**
 * R-H 0.1.49 — the generation gate (ADR-0051 §3, ruling R4a): every format
 * generation the contract promises (D pre-invocationSeq, E invocationSeq,
 * F) is represented by REAL logs written by REAL published bins, and every
 * sample must load → validate → project → deriveRecoveryPlan under the
 * CURRENT code. The fixture table below is the contract's table of
 * contents: it must equal the files on disk AND the rows of PROVENANCE.md
 * exactly — an unprovenanced fixture, or a provenance row without a
 * fixture, is a drift red.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKisoEvent, projectMessages, type Event } from "@vincemakes/kiso-core";
import { deriveRecoveryPlan } from "../src/recovery-plan.js";

const FIXTURE_DIR = new URL("./fixtures/sessions/", import.meta.url);

/** The contract's fixture table — the ≥4-generation corpus (R4a):
 *  three real generations (D/E/F) × real+produced samples, provenance in
 *  PROVENANCE.md. */
const CORPUS = [
	"dogfood-0143.jsonl", // gen E — real, the R-E poisoned trio #1
	"dogfood-0143b.jsonl", // gen E — real, the R-E poisoned trio #2
	"review-0143.jsonl", // gen E — real, the R-E poisoned trio #3
	"gen-d-0142-faux.jsonl", // gen D — published bin 0.1.42, faux mode
	"gen-d-0142-real.jsonl", // gen D — real dogfood transcript (0.1.42)
	"gen-e-0146-faux.jsonl", // gen E — published bin 0.1.46, faux mode
	"gen-e-0146-marker.jsonl", // gen E — 8 real microcompacted boundaries
	"gen-f-0148-faux.jsonl", // gen F — published bin 0.1.48, faux mode
	"gen-f-0148-marker.jsonl", // gen F — 8 real microcompacted boundaries
] as const;

/** The driver's scope rule (recovery-plan.ts): the open run is the tail
 *  after the last boundary; an EMPTY scope means the whole prefix is the
 *  open run. Every sample is a CLOSED session (last record = terminal),
 *  so both calls — the boundary scope and the full prefix — derive
 *  TERMINAL (the terminal is present in the open run); the driver then
 *  opens a NEW run. The pin is deterministic for every generation. */
const BOUNDARY_TYPES = new Set([
	"stop",
	"user_input",
	"terminal",
	"microcompacted",
	"compacted",
	"summarized",
	"model_output_abandoned",
]);

function openScope(events: readonly Event[]): Event[] {
	let last = -1;
	for (let i = 0; i < events.length; i++) {
		if (BOUNDARY_TYPES.has(events[i]!.type)) last = i;
	}
	return last === -1 ? [...events] : events.slice(last + 1);
}

function loadEvents(file: string): Event[] {
	const lines = readFileSync(join(FIXTURE_DIR.pathname, file), "utf8").split("\n").filter(Boolean);
	return lines.map((line) => JSON.parse(line).event as Event);
}

describe("R-H 0.1.49 — the generation gate (R4a: real logs, every promised generation)", () => {
	for (const file of CORPUS) {
		it(`${file}: load → validate → project → deriveRecoveryPlan — all green`, () => {
			const events = loadEvents(file);
			expect(events.length).toBeGreaterThan(0);
			for (const e of events) expect(isKisoEvent(e)).toBe(true); // validate
			const projected = projectMessages(events); // project
			expect(projected.length).toBeGreaterThan(0);
			// derive — the driver's two honest scope calls:
			expect(deriveRecoveryPlan(events, openScope(events)).kind).toBe("TERMINAL");
			expect(deriveRecoveryPlan(events, events).kind).toBe("TERMINAL");
		});
	}

	it("the fixture table equals the files on disk — an orphan fixture is a drift red", () => {
		const onDisk = readdirSync(FIXTURE_DIR.pathname).filter((f) => f.endsWith(".jsonl")).sort();
		expect(onDisk).toEqual([...CORPUS].sort());
	});

	it("every fixture has a PROVENANCE.md row and every row names a fixture", () => {
		const provenance = readFileSync(join(FIXTURE_DIR.pathname, "PROVENANCE.md"), "utf8");
		for (const f of CORPUS) expect(provenance).toContain(`| \`${f}\``);
		// Order-independent: the manifest's row order is not the contract's
		// table order — membership is.
		const rows = [...provenance.matchAll(/^\| `([^`]+\.jsonl)`/gm)].map((m) => m[1]!).sort();
		expect(rows).toEqual([...CORPUS].sort());
	});
});
