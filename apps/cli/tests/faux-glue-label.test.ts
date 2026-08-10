/**
 * P3 (0.1.42) — the "[faux mode]" label is RESERVED for the faux adapter.
 *
 * The bench T5 fresh2 evidence: a REAL provider 400 surfaced as
 * "[faux mode] the scripted model failed: 400 …" — a scripted-model label
 * wrapped around a real API error. The rule: the scripted-model label is
 * applied ONLY when the run is in faux mode (the keyless demo path); a
 * non-faux run's terminal error passes through untouched — the honest
 * "[<provider>] request failed:" label comes from the provider adapter
 * (its gate lives in the evals package).
 */

import { describe, expect, it } from "vitest";
import type { Event } from "@vincemakes/kiso-core";
import { FauxExhaustionError, failOnFauxExhaustion } from "../src/faux-glue.js";

// A terminal as a REAL provider produces it after P3: vendor-labeled.
const REAL_ERROR_TERMINAL: Event = {
	seq: 0,
	type: "terminal",
	outcome: {
		kind: "error",
		error: { code: "invalid_request", retryable: false, message: "[deepseek] request failed: bad key" },
	},
};

describe("P3 — the faux label is reserved for the faux adapter", () => {
	it("a NON-faux run's terminal error passes through untouched — no throw, no relabel", () => {
		expect(() => failOnFauxExhaustion(REAL_ERROR_TERMINAL, false, undefined)).not.toThrow();
	});

	it("a faux-mode terminal error is relabeled with the scripted-model prefix", () => {
		expect(() => failOnFauxExhaustion(REAL_ERROR_TERMINAL, true, undefined)).toThrow(FauxExhaustionError);
		try {
			failOnFauxExhaustion(REAL_ERROR_TERMINAL, true, undefined);
		} catch (err) {
			expect((err as Error).message).toMatch(/^\[faux mode\] the scripted model failed: /);
		}
	});

	it("the exhaustion signature gets the exhaustion message, never the failure label", () => {
		const exhausted: Event = {
			seq: 0,
			type: "terminal",
			outcome: {
				kind: "error",
				error: { code: "unknown", retryable: false, message: "provider stream ended without a stop event" },
			},
		};
		try {
			failOnFauxExhaustion(exhausted, true, undefined);
		} catch (err) {
			expect((err as Error).message).toContain("the scripted demo turns are exhausted");
		}
	});

	it("a completed terminal never throws in faux mode", () => {
		const done: Event = { seq: 0, type: "terminal", outcome: { kind: "completed" } };
		expect(() => failOnFauxExhaustion(done, true, undefined)).not.toThrow();
	});
});
