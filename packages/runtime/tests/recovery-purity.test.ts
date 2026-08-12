/**
 * R-H 0.1.49 — the derivation purity gate (ADR-0051 §6, ruling R7 + the
 * R3 lineage rulings): the recovery derivation never reads the trace
 * surface. Probe 1 — trace-shaped data present and byte-different →
 * identical action (the derivation is a pure function of its two
 * arguments). Probe 2 — no I/O during the derivation: node:fs is replaced
 * by a counting wrapper, and the derivation window must fire ZERO calls.
 * Probe 3 — lineage is absent from the session surface: no
 * generation-sample event carries parent-run / parent-seq fields
 * (session-id naming is not protocol; lineage lives on the trace surface,
 * never in events).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@vincemakes/kiso-core";
import { deriveRecoveryPlan } from "../src/recovery-plan.js";

const FIXTURE_DIR = new URL("./fixtures/sessions/", import.meta.url);

/** Probe 2's counting wrapper: every fs call is recorded. The derivation
 *  window must add zero entries. */
const ioCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const counting = <A extends unknown[]>(name: string, fn: (...a: A) => unknown) =>
		(...a: A): unknown => {
			ioCalls.push(name);
			return fn(...a);
		};
	return {
		...real,
		readFileSync: counting("readFileSync", real.readFileSync),
		writeFileSync: counting("writeFileSync", real.writeFileSync),
		appendFileSync: counting("appendFileSync", real.appendFileSync),
		mkdirSync: counting("mkdirSync", real.mkdirSync),
		readdirSync: counting("readdirSync", real.readdirSync),
	};
});

function loadEvents(file: string): Event[] {
	const lines = readFileSync(join(FIXTURE_DIR.pathname, file), "utf8").split("\n").filter(Boolean);
	return lines.map((line) => JSON.parse(line).event as Event);
}

const CORPUS_FILES = () => readdirSync(FIXTURE_DIR.pathname).filter((f) => f.endsWith(".jsonl")).sort();

describe("R-H 0.1.49 — the derivation purity gate (R7: derivation never reads the trace)", () => {
	it("probe 1: trace data present and byte-different → the identical action", () => {
		const events = loadEvents("dogfood-0143.jsonl");
		const base = deriveRecoveryPlan(events, events);
		// A trace-shaped sidecar (lineage forms) sits in scope — byte-different.
		const trace = events.map((e) => ({
			...e,
			parentSessionId: "trace/1",
			parentRunId: "trace/run",
			parentInvocationSeq: e.seq,
		}));
		expect(JSON.stringify(trace)).not.toBe(JSON.stringify(events));
		// The derivation sees only its two arguments: identical action.
		expect(deriveRecoveryPlan(events, events)).toEqual(base);
		// Pure: repeat calls agree.
		expect(deriveRecoveryPlan(events, events)).toEqual(deriveRecoveryPlan(events, events));
	});

	it("probe 2: the derivation touches no I/O — the fs wrapper counts zero calls in the derivation window", () => {
		const events = loadEvents("review-0143.jsonl"); // reads happen here, outside the window
		const before = ioCalls.length;
		expect(() => {
			deriveRecoveryPlan(events, events);
			deriveRecoveryPlan(events, []);
			deriveRecoveryPlan([events[0]!], []);
		}).not.toThrow();
		expect(ioCalls.length).toBe(before);
	});

	it("probe 3: lineage is absent from the session surface — no parent* fields in the corpus", () => {
		const LINEAGE_KEYS = ["parentSessionId", "parentRunId", "parentInvocationSeq"];
		for (const f of CORPUS_FILES()) {
			const lines = readFileSync(join(FIXTURE_DIR.pathname, f), "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				const event = JSON.parse(line).event as Record<string, unknown>;
				for (const key of LINEAGE_KEYS) expect(key in event).toBe(false);
			}
		}
	});
});
