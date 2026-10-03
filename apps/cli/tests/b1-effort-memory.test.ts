/**
 * B1 — a new session starts at the effort last picked for its profile
 * (kiso-doc plan-gpt-reasoning-summary-and-default-effort-2026-09-28.md).
 *
 * An explicit pick (`/model <profile> <effort>`, or the panel with a level)
 * is remembered per profile in preferences.json, beside `thinking`. At
 * startup the remembered effort goes through the picker's fallback: the
 * level itself when the model has it, else the endpoint's registry
 * default, else nothing (default/default, no reasoning key — today).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preferences, rememberEffort, resetPreferences, startingEffort, usePreferences } from "../src/preferences.js";

afterEach(() => resetPreferences());

const prefsFile = (content?: string): string => {
	const path = join(mkdtempSync(join(tmpdir(), "kiso-b1-prefs-")), "preferences.json");
	if (content !== undefined) writeFileSync(path, content);
	return path;
};

describe("remembering a pick, per profile", () => {
	it("a pick is kept beside the other choices, and read back by the next process", () => {
		const path = prefsFile(JSON.stringify({ thinking: "hidden" }));
		usePreferences(path);
		expect(rememberEffort("ds", "max")).toBe(true);
		expect(rememberEffort("sol", "high")).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ thinking: "hidden", effort: { ds: "max", sol: "high" } });
		resetPreferences();
		usePreferences(path);
		expect(preferences().effort).toEqual({ ds: "max", sol: "high" });
	});

	it("a later pick for the same profile replaces the earlier", () => {
		usePreferences(prefsFile());
		rememberEffort("ds", "max");
		rememberEffort("ds", "low");
		expect(preferences().effort).toEqual({ ds: "low" });
	});

	it("a malformed effort map is ignored, the rest of the file kept", () => {
		usePreferences(prefsFile(JSON.stringify({ thinking: "shown", effort: { ds: 3, ok: "high" } })));
		expect(preferences()).toEqual({ thinking: "shown", effort: { ok: "high" } });
		resetPreferences();
		usePreferences(prefsFile(JSON.stringify({ effort: "high" })));
		expect(preferences().effort).toBeUndefined();
	});
});

describe("startingEffort — the picker's fallback, at startup", () => {
	const ds = { kind: "openai-compat", model: "deepseek-v4-flash" } as const;
	const astra = { kind: "openai-responses", model: "gpt-6-astra" } as const;

	it("the remembered level, when the model has it", () => {
		expect(startingEffort(ds, "max")).toBe("max");
		expect(startingEffort(ds, "none")).toBe("none");
	});

	it("a level the model does not have: the endpoint's registry default", () => {
		expect(startingEffort(ds, "xhigh")).toBe("high");
	});

	it("no registry default for that endpoint: nothing", () => {
		expect(startingEffort(astra, "ultra")).toBeNull();
		expect(startingEffort(astra, "high")).toBe("high");
	});

	it("nothing remembered, or default remembered, or a model the registry does not know: nothing", () => {
		expect(startingEffort(ds, undefined)).toBeNull();
		expect(startingEffort(ds, "default")).toBeNull();
		expect(startingEffort({ kind: "openai-compat", model: "some-unlisted-model" }, "high")).toBeNull();
	});
});
