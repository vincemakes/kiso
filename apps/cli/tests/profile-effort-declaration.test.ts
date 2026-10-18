/**
 * 0.51.0 — a profile may declare its route's effort levels.
 *
 * A gateway or a new model the registry has no row for resolved the default
 * and refused any chosen level ("unknown stays unknown"), so the effort
 * picker never appeared. A profile's `effort` is the user's own claim (as
 * `contextWindow` is) and replaces the registry's levels for that model at
 * that endpoint. Profiles come from the USER config only, so a repository
 * cannot declare one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clearDeclaredEfforts, lookupModelMetadata, resolveReasoning } from "@vincemakes/kiso-runtime/internal";
import { applyEffortDeclarations, parseConfig } from "../src/config.js";

const GATEWAY = "https://gateway.example.test/v1";
const profile = (extra: Record<string, unknown>) => ({ model: "m", models: { p: { kind: "openai-compat", model: "some-new-model", baseUrl: GATEWAY, apiKeyEnv: "K", ...extra } } });
const parse = (effort: unknown) => parseConfig(JSON.stringify(profile({ effort })), "test");

afterEach(() => clearDeclaredEfforts());

describe("the parser", () => {
	it("keeps levels, default and values through to the profile", () => {
		const got = parse({ levels: ["none", "low", "high"], default: "high", values: { none: "off" } }).models?.p?.effort;
		expect(got).toEqual({ levels: ["none", "low", "high"], default: "high", values: { none: "off" } });
	});

	it("refuses what cannot be right, naming the field", () => {
		const bad: [unknown, RegExp][] = [
			[{ levels: [] }, /levels/],
			[{ levels: ["low", "low"] }, /twice/],
			[{ levels: ["loud"] }, /not a level/],
			[{ levels: ["low"], default: "high" }, /default/],
			[{ levels: ["low"], values: { high: "x" } }, /values\.high/],
			[{ levels: ["none"], values: { none: "two words" } }, /short word/],
			[{ levels: ["low"], extra: 1 }, /unknown key/],
			["low", /expected an object/],
		];
		for (const [effort, why] of bad) expect(() => parse(effort), JSON.stringify(effort)).toThrow(why);
	});
});

describe("the registry's lookup", () => {
	it("a model the registry does not know: before the declaration only the default resolves; after, the declared levels and the route's spelling", () => {
		expect(resolveReasoning("some-new-model", { thinking: "default", effort: "high" }, GATEWAY).ok).toBe(false);
		applyEffortDeclarations(parse({ levels: ["none", "low", "high"], default: "high", values: { none: "off" } }));
		expect(resolveReasoning("some-new-model", { thinking: "default", effort: "high" }, GATEWAY)).toEqual({ ok: true, wire: { effort: "high" } });
		expect(resolveReasoning("some-new-model", { thinking: "default", effort: "none" }, GATEWAY)).toEqual({ ok: true, wire: { effort: "off" } });
		expect(resolveReasoning("some-new-model", { thinking: "default", effort: "max" }, GATEWAY).ok).toBe(false);
		expect(lookupModelMetadata("some-new-model", GATEWAY)?.capabilities.reasoning?.effort?.declared).toBe(true);
	});

	it("it is that (model, endpoint) only: another endpoint, another model, and the default/default request are untouched", () => {
		applyEffortDeclarations(parse({ levels: ["low"] }));
		expect(lookupModelMetadata("some-new-model", "https://elsewhere.example.test/v1")).toBeNull();
		expect(lookupModelMetadata("another-model", GATEWAY)).toBeNull();
		expect(resolveReasoning("some-new-model", { thinking: "default", effort: "default" }, GATEWAY)).toEqual({ ok: true, wire: {} });
	});

	it("over a registry row it replaces the levels and keeps the rest of the row", () => {
		const CC = "https://api.commandcode.ai/provider/v1";
		const before = lookupModelMetadata("z-ai/glm-5.3-flash", CC);
		expect(before?.capabilities.reasoning?.effort?.levels).toEqual(["low", "high", "max"]);
		applyEffortDeclarations(parseConfig(JSON.stringify({ models: { p: { kind: "openai-compat", model: "z-ai/glm-5.3-flash", baseUrl: CC, effort: { levels: ["low", "medium"] } } } }), "test"));
		const after = lookupModelMetadata("z-ai/glm-5.3-flash", CC);
		expect(after?.capabilities.reasoning?.effort?.levels).toEqual(["low", "medium"]);
		expect(after?.capabilities.reasoning?.source).toBe("declared in the profile");
		expect(after?.capabilitiesSource).toBe(before?.capabilitiesSource);
	});

	it("a profile with no declaration changes nothing", () => {
		applyEffortDeclarations(parseConfig(JSON.stringify(profile({})), "test"));
		expect(lookupModelMetadata("some-new-model", GATEWAY)).toBeNull();
	});
});
