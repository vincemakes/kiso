import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import type { KisoConfig } from "../src/config.js";
import { type SettingsInput, settingsRows } from "../src/settings.js";

/**
 * 0.40.6 — /settings: each value, the layer it came from, and how to change
 * it. The owner asked, 2026-09-23, whether kiso has a help for what can be
 * configured. The precedence is the documented one — flag > env > project
 * config > user config > default — and a value no layer explains was set
 * in this session.
 */

const base: SettingsInput = {
	user: null,
	project: null,
	env: {},
	mode: "default",
	model: { label: "faux", profile: null, switched: false },
	ground: "dark",
	floorOn: true,
	window: "200K (faux)",
	thinkingHidden: false,
	thinkingRemembered: false,
	version: "0.40.6",
};
const row = (i: SettingsInput, name: string): string => {
	const r = settingsRows(i).find((x) => x.startsWith(`${name} `));
	expect(r, `no ${name} row`).toBeDefined();
	return r!;
};
const cfg = (c: Partial<KisoConfig>): KisoConfig => c as KisoConfig;

describe("each value names its layer", () => {
	it("nothing set: every row says default (or detected, or running)", () => {
		expect(row(base, "mode")).toMatch(/default\n\s+from default/);
		expect(row(base, "model")).toContain("from default");
		expect(row(base, "theme")).toContain("from the terminal (detected)");
		expect(row(base, "floor")).toMatch(/^floor\s+on — irrecoverable deletes are refused/);
		expect(row(base, "auto-compact")).toMatch(/off\n\s+from default/);
		expect(row(base, "project trust")).toMatch(/ask\n\s+from default/);
		expect(row(base, "thinking")).toMatch(/shown\n\s+from default · change: ctrl\+t/);
		expect(row(base, "version")).toMatch(/0\.40\.6\n\s+from running/);
	});

	it("mode: flag > env > project > user > default; anything else was set in this session", () => {
		expect(row({ ...base, mode: "plan", modeFlag: "plan", env: { KISO_MODE: "plan" } }, "mode")).toContain("from --mode");
		expect(row({ ...base, mode: "plan", env: { KISO_MODE: "plan" }, user: cfg({ mode: "plan" }) }, "mode")).toContain("from env KISO_MODE");
		expect(row({ ...base, mode: "full-access", project: cfg({ mode: "full-access" }), user: cfg({ mode: "full-access" }) }, "mode")).toContain("from project config");
		expect(row({ ...base, mode: "full-access", user: cfg({ mode: "full-access" }) }, "mode")).toContain("from user config");
		expect(row({ ...base, mode: "accept-edits", user: cfg({ mode: "full-access" }) }, "mode")).toContain("from set in this session");
		// an old name is named, so the row teaches the new one
		expect(row({ ...base, mode: "full-access", user: cfg({ mode: "bypass" }) }, "mode")).toMatch(/full-access\n\s+from user config \(written "bypass"\)/);
		expect(row({ ...base, mode: "default", dontAsk: true, env: { KISO_MODE: "dontAsk" } }, "mode")).toContain('from env KISO_MODE (written "dontAsk")');
	});

	it("don't ask: its own key at each layer, or the old name dontAsk where it won the tier", () => {
		expect(row(base, "don't ask")).toMatch(/off\n\s+from default/);
		expect(row({ ...base, dontAsk: true, dontAskFlag: true }, "don't ask")).toMatch(/on — what would ask is refused\n\s+from --dont-ask/);
		expect(row({ ...base, dontAsk: true, env: { KISO_DONT_ASK: "1" } }, "don't ask")).toContain("from env KISO_DONT_ASK");
		expect(row({ ...base, dontAsk: true, project: cfg({ dontAsk: true }), user: cfg({ dontAsk: false }) }, "don't ask")).toContain("from project config");
		expect(row({ ...base, dontAsk: true, modeFlag: "dontAsk" }, "don't ask")).toContain('from --mode (written "dontAsk")');
		expect(row({ ...base, dontAsk: true, user: cfg({ mode: "dontAsk" }) }, "don't ask")).toContain('from user config (written "dontAsk")');
		// --mode bypass won the tier, so a user config's old dontAsk brings no switch
		expect(row({ ...base, mode: "full-access", modeFlag: "bypass", user: cfg({ mode: "dontAsk" }) }, "don't ask")).toMatch(/off\n\s+from default/);
		expect(row({ ...base, dontAsk: true }, "don't ask")).toContain("from set in this session");
	});

	it("model: a /model switch wins the attribution; then flag, project, user, the env route, default", () => {
		const m = (profile: string | null, switched = false) => ({ label: "x", profile, switched });
		expect(row({ ...base, model: m("ds", true), user: cfg({ model: "ds" }) }, "model")).toContain("from set in this session");
		expect(row({ ...base, model: m("ds"), modelFlag: "ds" }, "model")).toContain("from --model");
		expect(row({ ...base, model: m("ds"), project: cfg({ model: "ds" }) }, "model")).toContain("from project config");
		expect(row({ ...base, model: m("ds"), user: cfg({ model: "ds" }) }, "model")).toContain("from user config");
		expect(row({ ...base, model: m(null), env: { OPENAI_API_KEY: "k" } }, "model")).toContain("from env OPENAI_API_KEY");
	});

	it("theme, floor, trust, auto-compact and thinking read their own layers", () => {
		expect(row({ ...base, env: { KISO_THEME: "light" }, user: cfg({ theme: "dark" }) }, "theme")).toMatch(/light\n\s+from env KISO_THEME/);
		expect(row({ ...base, user: cfg({ theme: "dark" }) }, "theme")).toMatch(/dark\n\s+from user config/);
		expect(row({ ...base, floorOn: false, user: cfg({ floor: "off" }) }, "floor")).toMatch(/off\n\s+from user config/);
		expect(row({ ...base, project: cfg({ projectTrust: "never" }), user: cfg({ projectTrust: "ask" }) }, "project trust")).toMatch(/never\n\s+from project config/);
		expect(row({ ...base, user: cfg({ autoCompact: { thresholdRatio: 0.8 } }) }, "auto-compact")).toMatch(/at 0\.8 of the window, at a run's start\n\s+from user config/);
		expect(row({ ...base, env: { KISO_AUTO_COMPACT: "0.5" }, user: cfg({ autoCompact: { thresholdRatio: 0.8 } }) }, "auto-compact")).toMatch(/0\.5\n\s+from env KISO_AUTO_COMPACT/);
		expect(row({ ...base, thinkingHidden: true, thinkingRemembered: true }, "thinking")).toMatch(/hidden — one line per block\n\s+from ctrl\+t \(remembered\)/);
	});

	it("every row says how to change it", () => {
		for (const r of settingsRows(base)) expect(r).toMatch(/· change: \S/);
	});
});

describe("/settings in the built CLI (a pipe)", () => {
	it("the owner's shape: mode bypass from the user config, the window, thinking, the version", () => {
		const { dirs, env } = isolatedEnv({ DS_KEY: "fake" });
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({ model: "ds", mode: "bypass", models: { ds: { kind: "openai-compat", model: "deepseek-flash", apiKeyEnv: "DS_KEY", baseUrl: "https://api.deepseek.com" } } }),
		);
		const out = runCli(["chat", "settings-e2e"], env, { input: "/settings\nexit\n" }).stdout;
		const version = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;
		expect(out).toMatch(/model\s+deepseek-flash@api\.deepseek\.com · profile ds\n\s+from user config/);
		expect(out).toMatch(/mode\s+full-access\n\s+from user config \(written "bypass"\)/);
		expect(out).toMatch(/don't ask\s+off\n\s+from default/);
		expect(out).toMatch(/window\s+1M, the registry's for this endpoint/);
		expect(out).toMatch(/thinking\s+shown\n\s+from default/);
		expect(out).toMatch(new RegExp(`version\\s+${version.replace(/\./g, "\\.")}\\n\\s+from running`));
	});
});

describe("the don't-ask switch in the built CLI (a pipe)", () => {
	it("the old names resolve as they did: a user config's dontAsk under --mode bypass is full-access, asking", () => {
		const { dirs, env } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ mode: "dontAsk" }));
		const out = runCli(["--mode", "bypass", "chat", "old-names"], env, { input: "/settings\nexit\n" }).stdout;
		expect(out).toMatch(/mode\s+full-access\n\s+from --mode \(written "bypass"\)/);
		expect(out).toMatch(/don't ask\s+off\n\s+from default/);
	});

	it("--dont-ask and KISO_DONT_ASK turn it on under any tier; /dont-ask flips it, and bare /mode prints it only when on", () => {
		const { env } = isolatedEnv();
		const flag = runCli(["--mode", "full-access", "--dont-ask", "chat", "flag-on"], env, { input: "/settings\nexit\n" }).stdout;
		expect(flag).toMatch(/mode\s+full-access\n\s+from --mode/);
		expect(flag).toMatch(/don't ask\s+on — what would ask is refused\n\s+from --dont-ask/);
		const fromEnv = runCli(["chat", "env-on"], { ...env, KISO_DONT_ASK: "1" }, { input: "/mode\n/dont-ask off\n/mode\nexit\n" }).stdout;
		expect(fromEnv).toContain("mode default\ndon't ask on\ntiers: default accept-edits plan full-access");
		expect(fromEnv).toContain("don't ask → off");
		expect(fromEnv).toContain("mode default\ntiers: default accept-edits plan full-access");
		const bad = runCli(["chat", "bad-arg"], env, { input: "/dont-ask maybe\nexit\n" }).stdout;
		expect(bad).toContain("usage: /dont-ask [on|off]");
	});
});
