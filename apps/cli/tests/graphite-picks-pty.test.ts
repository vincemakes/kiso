/**
 * Graphite P3 — the pick panels on a real pty (owner, 2026-10-04).
 *
 * The unit file (packages/tui/tests/graphite-picks.test.ts) pins the band's
 * shape; this one pins the CLI's wiring through the real binary: /model
 * FILTERS and switches to the match, a profile with no credential says so on
 * its row, /settings switches don't ask for this session through /dont-ask's
 * own path (and writes no config), and the Graphite bar stays under the
 * panel the whole time — the pre-Graphite status row never appears.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const CONFIG = {
	model: "ds",
	models: {
		ds: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "P3_KEY", baseUrl: "http://127.0.0.1:9" },
		glm: { kind: "openai-compat", model: "z-ai/glm-5.3-flash", apiKeyEnv: "P3_KEY", baseUrl: "http://127.0.0.1:9" },
		gone: { kind: "openai-compat", model: "grok-4.7", apiKeyEnv: "P3_UNSET_KEY", baseUrl: "http://127.0.0.1:9" },
	},
};

describe("Graphite P3 — /model on a real pty", () => {
	it("typing filters, ⏎ switches to the match, and the bar stays under the panel", () => {
		const { dirs, env } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify(CONFIG)}\n`);
		const raw = ptyRun(["chat", "p3-model"], { ...env, P3_KEY: "fake" } as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "/model\r"],
				["filter, or type provider/model", "glm"],
				["1 of 3 match", "\r"],
				["takes effect on the next turn", "exit\r"],
			],
		});
		const t = plain(raw);
		expect(t, "the band counts the profiles").toContain("model · 3 profiles");
		expect(t, "the session's own profile says so on its row").toMatch(/deepseek-v4-flash +127\.0\.0\.1:9 +current/);
		expect(t, "a profile with no credential says why in two words").toMatch(/grok-4\.7 +127\.0\.0\.1:9 +no key/);
		expect(t, "the selected row opens into its profile, protocol and key").toContain("profile ds · openai-compat · P3_KEY");
		expect(t, "the filter narrowed the list").toContain("model · 1 of 3 match");
		expect(t, "and ⏎ took the match").toContain("model → glm (z-ai/glm-5.3-flash");
		// from the panel's first frame on: the bar, never the pre-Graphite
		// status row with its key ladder (the boot frame before the bar is
		// bound has one, which is not this round's), and no `1-9>` lead
		const open = t.slice(t.indexOf("model · 3 profiles"));
		expect(open).toContain("/mode to switch");
		expect(open).not.toContain("/ commands · ↑ history");
		expect(open).not.toMatch(/1-\d> /);
	}, 120_000);
});

describe("Graphite P3 — /settings on a real pty", () => {
	it("don't ask walks off → on with ←→ and ⏎ applies it through /dont-ask's path — for this session only", () => {
		const { dirs, env } = isolatedEnv();
		const config = join(dirs.home, "config.json");
		writeFileSync(config, `${JSON.stringify(CONFIG)}\n`);
		const raw = ptyRun(["chat", "p3-settings"], { ...env, P3_KEY: "fake" } as NodeJS.ProcessEnv, {
			feeds: [
				["/mode to switch", "/settings\r"],
				["opens /model", "\x1b[B\x1b[B"],
				["←→ don't ask", "\x1b[C"],
				// the level in force is marked in colour (the warn tint: this pty
				// answers no ground query) — `on` lit means the walk landed
				["\x1b[1m\x1b[33mon\x1b[0m", "\r"],
				["DON'T ASK", "exit\r"],
			],
		});
		const t = plain(raw);
		expect(t, "the band counts the settings").toMatch(/settings · \d+/);
		expect(t, "the session's own four come first").toMatch(/model +deepseek-v4-flash[\s\S]*mode +default[\s\S]*don't ask +off[\s\S]*thinking +shown/);
		expect(t, "the switch's row").toMatch(/DON'T ASK +off → on/);
		expect(readFileSync(config, "utf8"), "kiso never writes the person's config").toBe(`${JSON.stringify(CONFIG)}\n`);
	}, 120_000);
});
