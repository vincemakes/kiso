/**
 * DF-0311-F1 — a new model binding starts with NO meter.
 *
 * The 0.31.1 post-release dogfood, reproduced by the owner minutes later:
 * after `/model chatgpt` the status row read `gpt-6-astra · medium · CH 92%`.
 * The model label was the new binding (OR-7 repaints the row at once); the
 * meter was the LAST TURN's, measured on the model before it. The two never
 * belonged to one request — and beside a model whose cache is unobservable
 * (OR-10) the row claimed a measurement that model never had.
 *
 * The rule is the one the boot row already follows ("an unmeasured cache is
 * not a 0% cache"): a binding that has not run yet paints no meter. The
 * first turn on it paints the first figure.
 *
 * REAL kiso chat under a pty, faux provider with a usage event that carries a
 * cache figure, so the row has a CH to lose. Keys ride needles that are
 * contiguous on the wire (the R1.5 lesson).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, spares } from "./helpers/pty.js";

const statusRowOf = (screen: string[]): string => screen.find((row) => row.includes("/mode to switch")) ?? "";

describe("DF-0311-F1 — /model repaints the row with no meter", () => {
	it("the turn before the switch painted CH; the frame that carries the switch's notice carries the new model and NO CH", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{
					events: [
						{ type: "text_delta", text: "one." },
						// 900 of 1,000 input tokens from the cache: CH 90% on the row
						{ type: "usage", inputTokens: 1000, outputTokens: 5, cacheRead: 900, cacheWrite: null, known: true },
						{ type: "stop", reason: "end_turn" },
					],
				},
				...spares(4),
			]),
			MY_TEST_KEY: "sk-fake", // the profile is available; a non-top-level env keeps the session faux
		});
		writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ models: { ds: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "MY_TEST_KEY" } } })}\n`);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-df0311-"));
		const raw = ptyRun(["chat", "df0311-f1"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				// the switch is keyed on the METER's own bytes, not the recap's: keyed
				// on `took ` it raced the idle repaint that carries the figure, and
				// the "before" frame sometimes showed a row the switch had already
				// cleared — a green that proved nothing either way
				["CH 90%", "/model ds max\r"],
				["takes effect on the next turn", "exit\r"],
			],
			timeout: 60,
		});

		// before the switch: the meter the faux usage produced reached the row
		// (the feed that sent the switch fired on exactly these bytes)
		expect(raw, "the turn painted no meter to lose").toContain("CH 90%");

		// the switch's own frame: the new binding, and no meter at all
		const after = statusRowOf(screenAt(raw, "takes effect on the next turn"));
		expect(after, "the row did not repaint with the new model").toContain("deepseek-v4-flash · max");
		expect(after, "the previous model's meter survived the switch").not.toContain("CH");
	}, 120_000);
});
