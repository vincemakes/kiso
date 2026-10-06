import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preferences, resetPreferences, setPreference, usePreferences } from "../src/preferences.js";

/** Mode bits are POSIX: Windows guards these files with ACLs, and Node reports 0666 there. */
const POSIX_MODES = process.platform !== "win32";

/**
 * 0.40.6 — the choices kiso remembers, in a kiso-owned file. Every path
 * here is under a mkdtemp root; nothing names the home directory.
 */
const file = (): string => join(mkdtempSync(join(tmpdir(), "kiso-prefs-")), "preferences.json");
afterEach(() => resetPreferences());

describe("preferences.json", () => {
	it("nothing is read or kept until startup names the file", () => {
		expect(preferences()).toEqual({});
		expect(setPreference("thinking", "hidden")).toBe(false);
	});

	it("a choice is kept privately, and read back by the next process", () => {
		const f = file();
		usePreferences(f);
		expect(setPreference("thinking", "hidden")).toBe(true);
		if (POSIX_MODES) expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ thinking: "hidden" });
		resetPreferences();
		usePreferences(f);
		expect(preferences().thinking).toBe("hidden");
	});

	it("a missing, corrupt or unknown value reads as nothing — never a guess", () => {
		const f = file();
		usePreferences(f);
		expect(preferences()).toEqual({});
		writeFileSync(f, "{ not json");
		usePreferences(f);
		expect(preferences()).toEqual({});
		writeFileSync(f, JSON.stringify({ thinking: "sometimes" }));
		usePreferences(f);
		expect(preferences()).toEqual({});
	});
});
