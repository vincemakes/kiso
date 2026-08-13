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
import { TRACE_SCHEMA_VERSION, validateTraceLine, type TraceLine } from "../src/trace/record.js";

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

	it("probe 4 (E1 I2): real trace records — header + lineage quartet + run_end — never move the derivation", () => {
		const events = loadEvents("dogfood-0143.jsonl");
		const base = deriveRecoveryPlan(events, events);
		// The E1 ledger's ACTUAL line vocabulary, in scope and byte-different:
		// a header line, one request record carrying the ADR-0051 §2 B2a
		// lineage quartet, and the run_end marker.
		const header: TraceLine = {
			schemaVersion: TRACE_SCHEMA_VERSION,
			kind: "header",
			sessionId: "tracey",
			kisoVersion: "1.2.0",
			createdAt: 1_753_400_000_000,
		};
		const request: TraceLine = {
			schemaVersion: TRACE_SCHEMA_VERSION,
			kind: "request",
			requestId: "9f3a7c11-6b3e-4f2a-9d0e-1c2b3a4d5e6f",
			runId: "run-1",
			requestIndex: 0,
			retryAttempt: 0,
			provider: "openai-compat",
			model: "m",
			adapterVersion: "1.2.0",
			systemPromptHash: "a".repeat(64),
			toolSchemaHash: "b".repeat(64),
			contextHash: "c".repeat(64),
			contextManifest: [{ role: "system", seqRange: null, estTokens: 1, freshness: "cache_read" }],
			segmentHashes: ["e".repeat(64)],
			stablePrefixFingerprint: "d".repeat(64),
			freshInput: 0,
			cacheRead: 0,
			cacheWrite: null,
			output: 0,
			// E2 — the canonical block formalizes the quartet (this fixture
			// mirrors the writer's current output; zero-usage → the "0 =
			// unknown" convention, consistent with the quartet)
			canonical: {
				input: 0,
				cacheRead: 0,
				cacheWrite: null,
				output: 0,
				reasoning: null,
				costUsd: 0,
				pricingTableId: "builtin",
				pricingTableVersion: 1,
			},
			latencyMs: 1,
			ttftMs: 0,
			toolCalls: [],
			outcome: "ok",
			lineageLink: { parentSessionId: "session-0142", parentRunId: "run-0142", parentInvocationSeq: 7, role: "user" },
			ts: 1_753_400_000_001,
		};
		const runEnd: TraceLine = {
			schemaVersion: TRACE_SCHEMA_VERSION,
			kind: "run_end",
			runId: "run-1",
			ts: 1_753_400_000_002,
			lastRequestIndex: 0,
		};
		const sidecar = [header, request, runEnd].map((l) => JSON.stringify(l)).join("\n");
		expect(sidecar).not.toBe(JSON.stringify(events));
		// every line validates — this IS the ledger shape the writer emits
		for (const line of sidecar.split("\n")) {
			expect(validateTraceLine(JSON.parse(line))).toBe(true);
		}
		// the derivation still sees only its two arguments: identical action
		expect(deriveRecoveryPlan(events, events)).toEqual(base);
		expect(deriveRecoveryPlan(events, events)).toEqual(deriveRecoveryPlan(events, events));
	});
});
