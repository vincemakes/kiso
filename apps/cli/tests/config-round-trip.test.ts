/**
 * Every declared config field survives a parse (0.39.2).
 *
 * `contextWindow` on a model profile was DECLARED on the type, VALIDATED
 * at the top level, and CONSUMED by `resolveContextWindow` — which prefers
 * it over the global figure, with a comment explaining why — and the
 * parser's object literal never copied it. Measured on the owner's own
 * config the day it was found: 70 profiles declared a window, 0 survived.
 *
 * Nothing went red, and nothing could have. The type says the field MAY be
 * absent, so a parser that always drops it produces a value the type
 * accepts. Every consumer then reads `undefined` and takes its fallback,
 * which is a working program — just not the one the config asked for. The
 * cost was not the `ctx ?` on the status row: `contextWindowTokens` fell
 * through to the 200k default for every model the registry does not carry,
 * so a 1M-window model compacted at a fifth of its window, and the
 * documented workaround for exactly that had never done anything.
 *
 * THE ORACLE IS THE SOURCE, not a list kept beside it. The fields are read
 * out of `config.ts`'s own interface declarations, so a field added to a
 * type and forgotten in the parser fails HERE rather than in a user's
 * session months later. A new field with no sample value below fails too —
 * deliberately: the author who adds one is the person who knows what a
 * valid instance of it looks like.
 *
 * The same shape as the duration-label sweep: an inconsistency has no
 * natural oracle, so the oracle has to be a property of the whole surface.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { parseConfig } from "../src/config.js";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/config.ts", import.meta.url)), "utf8");

/** The field names declared on one interface, read from the source. */
function declaredFields(iface: string): string[] {
	const start = SOURCE.indexOf(`export interface ${iface} {`);
	expect(start, `interface ${iface} not found in config.ts`).toBeGreaterThan(-1);
	const body = SOURCE.slice(start, SOURCE.indexOf("\n}", start));
	return [...body.matchAll(/^\treadonly (\w+)\??:/gm)].map((m) => m[1]!);
}

/** A valid instance of each field. A declared field with no entry here is
 *  a FAILURE, not a skip. */
const PROFILE_SAMPLE: Record<string, unknown> = {
	kind: "openai-compat",
	model: "some-model",
	baseUrl: "https://example.invalid/v1",
	apiKeyEnv: "SOME_KEY",
	promptCaching: true,
	streamIdleMs: 30_000,
	contextWindow: 123_456,
	upstream: "https://upstream.invalid/v1",
	headers: { "x-gateway-session": "{session}" },
};

const CONFIG_SAMPLE: Record<string, unknown> = {
	model: "p",
	models: { p: PROFILE_SAMPLE },
	mode: "plan",
	dontAsk: true, // the modes round: the don't-ask switch, either config
	contextWindow: 654_321,
	autoCompact: { thresholdRatio: 0.5 },
	taskWake: false, // ADR-0058 (3c): false is the value a dropped field would hide
	projectTrust: "ask",
	theme: "dark",
	floor: "off", // 0.40.0, user-level only — "round-trip" is not a <cwd> source
	protectedPaths: ["/kiso-round-trip-absent/secret.md"], // user-level only, like floor; absent, so no home is read
	checks: { test: "npm test" },
	evaluators: ["/kiso-round-trip-absent/evaluate.sh"], // CS-1 (0.40.7)
};

describe("every declared config field survives a parse", () => {
	it("ModelProfile: each field reaches the parsed profile", () => {
		const fields = declaredFields("ModelProfile");
		expect(fields.length).toBeGreaterThan(3); // a read that finds almost nothing is a failed read
		const missingSample = fields.filter((f) => !(f in PROFILE_SAMPLE));
		expect(missingSample, `declared on ModelProfile with no sample value in this test: ${missingSample.join(", ")}`).toEqual([]);

		const parsed = parseConfig(JSON.stringify({ model: "p", models: { p: PROFILE_SAMPLE } }), "round-trip");
		const got = parsed.models?.p as Record<string, unknown> | undefined;
		expect(got, "the profile itself did not survive").toBeDefined();
		const dropped = fields.filter((f) => got![f] === undefined);
		expect(dropped, `declared, given a value, and DROPPED by the parser: ${dropped.join(", ")}`).toEqual([]);
		for (const f of fields) expect(got![f], `${f} changed in transit`).toEqual(PROFILE_SAMPLE[f]);
	});

	it("KisoConfig: each field reaches the parsed config", () => {
		const fields = declaredFields("KisoConfig");
		expect(fields.length).toBeGreaterThan(3);
		const missingSample = fields.filter((f) => !(f in CONFIG_SAMPLE));
		expect(missingSample, `declared on KisoConfig with no sample value in this test: ${missingSample.join(", ")}`).toEqual([]);

		const parsed = parseConfig(JSON.stringify(CONFIG_SAMPLE), "round-trip") as unknown as Record<string, unknown>;
		const dropped = fields.filter((f) => parsed[f] === undefined);
		expect(dropped, `declared, given a value, and DROPPED by the parser: ${dropped.join(", ")}`).toEqual([]);
	});

	it("the profile's window is a POSITIVE token count, and says so", () => {
		// The same validation the top-level key has had all along — the
		// field was unvalidated here only because it was unread here.
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1000000"]) {
			expect(() => parseConfig(JSON.stringify({ models: { p: { ...PROFILE_SAMPLE, contextWindow: bad } } }), "bad"), `contextWindow: ${String(bad)}`).toThrow(
				/contextWindow/,
			);
		}
	});

	it("an absent window stays absent — the fallback chain is not a default written into the profile", () => {
		const { contextWindow: _drop, ...noWindow } = PROFILE_SAMPLE;
		const parsed = parseConfig(JSON.stringify({ models: { p: noWindow } }), "round-trip");
		expect((parsed.models?.p as unknown as Record<string, unknown>).contextWindow).toBeUndefined();
	});
});

describe("the parsed window REACHES the running program", () => {
	// Surviving the parser is half the claim. `resolveContextWindow` is
	// called with the resolved profile at startup and the figure lands in
	// `configuredWindow`, which is what `knownContextWindow` reads and what
	// decides both the status row's denominator and the compaction
	// threshold. A test that stopped at the parser would have passed on the
	// day the field reached nothing.
	const profile = (extra: Record<string, unknown>) => ({
		kind: "openai-compat",
		model: "unregistered-model-nobody-publishes-a-window-for",
		apiKeyEnv: "ROUND_TRIP_KEY",
		baseUrl: "https://example.invalid/v1",
		...extra,
	});

	function statusRow(models: Record<string, unknown>): string {
		const { env, dirs } = isolatedEnv({ ROUND_TRIP_KEY: "not-a-real-key" });
		writeFileSync(`${dirs.home}/config.json`, JSON.stringify({ model: "p", models }, null, 2), "utf8");
		return runCli(["chat", "ctxprobe"], env, { input: "/status\nexit\n" }).stdout;
	}

	it("a profile that STATES a window gets a real percentage", () => {
		const out = statusRow({ p: profile({ contextWindow: 1_000_000 }) });
		expect(out).toMatch(/ctx ~\d+%/);
		expect(out).not.toContain("ctx ~?");
	});

	it("a profile that states NONE still says so — the fix does not invent a denominator", () => {
		// The registry carries no row for this model and nobody published a
		// window, so `ctx ?` is the honest answer and must survive.
		const out = statusRow({ p: profile({}) });
		expect(out).toContain("ctx ~?");
		expect(out).toContain("window unknown — compaction assumes 128K"); // CW-1 batch 2 (declared re-pin): the fallback is 128K, down from 200K
	});

	it("CW-1: a registered model at an unregistered endpoint gets the MODEL's window, said as inferred", () => {
		// the owner's op profile, 2026-09-23: deepseek-v4.1-flash through a
		// forwarder the registry has no row for read `ctx ?`
		const out = statusRow({ p: profile({ model: "deepseek-v4.1-flash" }) });
		expect(out).toMatch(/ctx ~\d+%/);
		expect(out).not.toContain("ctx ~?");
		expect(out).toContain("window 1M, inferred from the model (deepseek-flash) — not stated for this endpoint");
	});
});
