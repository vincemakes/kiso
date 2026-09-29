/**
 * 0.40.6, item 1 (the owner, 2026-09-23: "who told you to write ctx").
 *
 * 0.40.3 put the context window at the end of every /model row — `ctx 1M`,
 * `ctx 1,048,576 inferred`, `ctx ?`. On the owner's thirteen profiles at 100
 * columns the rows ran out of width and the note that matters was cut:
 * `unavailabl…`. The window moved to /status and /settings; the rows keep
 * what a chooser cannot infer — availability, and which one is live.
 *
 * The fixture is the owner's own shape: thirteen profiles, the same model
 * ids, hosts at least as long as the owner's (a fixture shorter than the
 * world hides exactly this defect), and no keys in the environment, so
 * every gateway row is unavailable as it was in the screenshot. REAL kiso
 * chat under a pty at 100 columns, faux provider; the picker opens and esc
 * closes it — nothing is sent.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

/** The screen's rows: a cursor move starts a new row as a newline does —
 *  the panel paints each row at its own position. */
const screenRows = (t: string): string[] =>
	t
		.replace(/\x1b\[\d*(;\d*)?[HfG]/g, "\n")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.split(/\r?\n|\r/);

const A = "https://api.gateway-aaaa.ai/provider/v1"; // ≥ the owner's longer gateway host
const B = "https://gateway-bbbb.ai/zen/go/v1"; // ≥ the owner's shorter one
const gw = (model: string, baseUrl: string, kind = "openai-compat") => ({ kind, model, apiKeyEnv: baseUrl === A ? "GW_A_KEY" : "GW_B_KEY", baseUrl });
const THIRTEEN = {
	model: "ds",
	models: {
		ds: { kind: "openai-compat", model: "deepseek-flash", apiKeyEnv: "DS_KEY", baseUrl: "https://api.deepseek.com" },
		chatgpt: { kind: "openai-responses", model: "gpt-6-astra", baseUrl: "https://chatgpt.com/backend-api" },
		sol: { kind: "openai-responses", model: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" },
		co: gw("deepseek/deepseek-v4.1-flash", A),
		"co/deepseek/deepseek-v4.1-flash": gw("deepseek/deepseek-v4.1-flash", A),
		"co/z-ai/glm-5.3-flash": gw("z-ai/glm-5.3-flash", A),
		"co/xai/grok-4.7": gw("xai/grok-4.7", A),
		"co/xiaomi/mimo-v2.6-flash": gw("xiaomi/mimo-v2.6-flash", A),
		op: gw("deepseek-v4.1-flash", B),
		"op/deepseek-v4.1-flash": gw("deepseek-v4.1-flash", B),
		"op/glm-5.3-flash": gw("glm-5.3-flash", B),
		"op/grok-4.7": gw("grok-4.7", B, "openai-responses"),
		"op/mimo-v2.6-flash": gw("mimo-v2.6-flash", B),
	},
};

describe("0.40.6 — /model rows carry availability, not the window", () => {
	it("the picker at 100 columns: no `ctx`, and `unavailable` whole on every gateway row", () => {
		const { dirs, env } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify(THIRTEEN)}\n`);
		const raw = ptyRun(["chat", "rows-a"], { ...env, DS_KEY: "fake" } as NodeJS.ProcessEnv, {
			cols: 100,
			feeds: [["/mode to switch", "/model\r"]],
			delays: [
				[2.6, "\x1b"],
				[3.6, "exit\r"],
			],
		});
		const rows = screenRows(raw).filter((l) => /(openai-compat|openai-responses)\/\S+ @/.test(l));
		expect(rows.length, "the picker painted its rows").toBeGreaterThanOrEqual(5);
		for (const r of rows) expect(r, "no window on a /model row").not.toMatch(/\bctx\b/);
		const gateway = rows.filter((r) => /@(api\.gateway-aaaa\.ai|gateway-bbbb\.ai)/.test(r));
		expect(gateway.length).toBeGreaterThan(0);
		for (const r of gateway) {
			expect(r, "the mark that matters is whole").toMatch(/\bunavailable\b/);
			expect(r).not.toContain("unavailabl…");
		}
	}, 240_000);

	it("the typed list (a pipe): every row names availability and effort, and no window", () => {
		const { dirs, env } = isolatedEnv({ DS_KEY: "fake" });
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify(THIRTEEN)}\n`);
		const out = runCli(["chat", "rows-b"], env, { input: "/model\nexit\n" }).stdout;
		const rows = out.split("\n").filter((l) => / → (openai-compat|openai-responses)\//.test(l));
		expect(rows, "all thirteen profiles are listed").toHaveLength(13);
		for (const r of rows) {
			expect(r).toMatch(/\((available|unavailable)\)/);
			expect(r).toContain("effort:");
			expect(r, "no window on a /model row").not.toMatch(/\bctx\b/);
		}
	}, 240_000);
});
