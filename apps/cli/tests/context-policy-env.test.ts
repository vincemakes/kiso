/**
 * E6 (g) — the CLI arming surface (contextPolicyFromEnv):
 *   - KISO_CONTEXT_WINDOW arms the policy at WINDOW − RESERVE — the
 *     window rides the config as windowTokens, the runtime owns the
 *     arithmetic (summarize.ts) — never a fixed low absolute (the
 *     e6probe's fixed 1300 fired 16-19× a session);
 *   - KISO_POLICY_SUMMARY_TRIGGER survives ONLY as the legacy absolute
 *     override when no window is set (bench back-compat);
 *   - KISO_POLICY_SUMMARY_KEEP / KEEP_TOKENS override the runtime
 *     defaults (keepRounds KEEP_RECENT_ROUNDS = 4, keepTokens
 *     KEEP_TOKENS_DEFAULT = 20,000) — the CLI emits them only when set;
 *   - KISO_POLICY_DROP switches the armed mode to the crux C arm;
 *   - no policy envs → unarmed (the OFF-by-default disposition).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { contextPolicyFromEnv } from "../src/index.js";

const SAVED = new Map<string, string | undefined>();
const ENVS = [
	"KISO_POLICY_SUMMARY_TRIGGER",
	"KISO_CONTEXT_WINDOW",
	"KISO_POLICY_MICROCOMPACT",
	"KISO_POLICY_DROP",
	"KISO_POLICY_SUMMARY_KEEP",
	"KISO_POLICY_SUMMARY_KEEP_TOKENS",
	"KISO_POLICY_SUMMARY_MAX_FAILURES",
	"KISO_POLICY_MICROCOMPACT_KEEP",
	"KISO_POLICY_MICROCOMPACT_MIN_TURNS",
];

beforeEach(() => {
	for (const n of ENVS) SAVED.set(n, process.env[n]);
	for (const n of ENVS) delete process.env[n];
});
afterEach(() => {
	for (const [n, v] of SAVED) {
		if (v === undefined) delete process.env[n];
		else process.env[n] = v;
	}
	SAVED.clear();
});

describe("E6 (g) — the CLI context-policy arming", () => {
	it("KISO_CONTEXT_WINDOW arms the window mode — the window rides the config, the runtime owns the arithmetic", () => {
		process.env.KISO_CONTEXT_WINDOW = "34000";
		expect(contextPolicyFromEnv()).toEqual({ summary: { windowTokens: 34000 } });
	});

	it("KISO_POLICY_SUMMARY_KEEP / KEEP_TOKENS override the runtime defaults (the decisive-experiment shape)", () => {
		process.env.KISO_CONTEXT_WINDOW = "34000";
		process.env.KISO_POLICY_SUMMARY_KEEP = "2";
		process.env.KISO_POLICY_SUMMARY_KEEP_TOKENS = "2000";
		expect(contextPolicyFromEnv()).toEqual({ summary: { windowTokens: 34000, keepRounds: 2, keepTokens: 2000 } });
	});

	it("KISO_POLICY_SUMMARY_MAX_FAILURES overrides the (h) circuit-breaker default", () => {
		process.env.KISO_CONTEXT_WINDOW = "34000";
		process.env.KISO_POLICY_SUMMARY_MAX_FAILURES = "1";
		expect(contextPolicyFromEnv()).toEqual({ summary: { windowTokens: 34000, maxFailures: 1 } });
	});

	it("KISO_POLICY_SUMMARY_TRIGGER survives ONLY as the legacy absolute override when no window is set", () => {
		process.env.KISO_POLICY_SUMMARY_TRIGGER = "1300";
		expect(contextPolicyFromEnv()).toEqual({ summary: { triggerTokens: 1300 } });
	});

	it("the window wins when both are set — the fixed absolute never arms the product", () => {
		process.env.KISO_CONTEXT_WINDOW = "34000";
		process.env.KISO_POLICY_SUMMARY_TRIGGER = "1300";
		expect(contextPolicyFromEnv()).toEqual({ summary: { windowTokens: 34000 } });
	});

	it("KISO_POLICY_DROP switches the armed mode to the crux C arm (bench-only)", () => {
		process.env.KISO_CONTEXT_WINDOW = "34000";
		process.env.KISO_POLICY_DROP = "1";
		expect(contextPolicyFromEnv()).toEqual({ drop: { windowTokens: 34000 } });
	});

	it("the microcompact env arms only the B arm", () => {
		process.env.KISO_POLICY_MICROCOMPACT = "100";
		process.env.KISO_POLICY_MICROCOMPACT_KEEP = "1";
		process.env.KISO_POLICY_MICROCOMPACT_MIN_TURNS = "3";
		expect(contextPolicyFromEnv()).toEqual({ microcompact: { thresholdTokens: 100, keepResults: 1, minTurns: 3 } });
	});

	it("no policy envs — unarmed (the OFF-by-default disposition)", () => {
		expect(contextPolicyFromEnv()).toBeUndefined();
	});

	it("invalid env values are ignored, not crashes (positiveIntEnv discipline)", () => {
		process.env.KISO_CONTEXT_WINDOW = "bogus";
		expect(contextPolicyFromEnv()).toBeUndefined();
	});
});
