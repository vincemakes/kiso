/**
 * B1 end to end, on a real PTY: an effort picked for a profile is
 * remembered, and the next NEW session of that profile starts at it — the
 * status row names it before anything is picked.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun, settledScreen } from "./helpers/pty.js";

describe("B1 — the effort last picked is where a new session starts", () => {
	it("/model ds max is remembered; a new ds session opens at max", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ models: { ds: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "MY_TEST_KEY" } } }), "utf8");
		env.MY_TEST_KEY = "sk-fake"; // available; no turn is sent, so no request is made

		const first = stripANSI(
			ptyRun(["chat", "b1-first", "--model", "ds"], env, {
				feeds: [
					// the main sync (tui/graphite): the boot row offers no key ladder
					// (the tasks round, §8.5) — the idle bar's `/mode to switch` is
					// the sign the session is ready
					["/mode to switch", "/model ds max\r"],
					["takes effect on the next turn", "exit\r"],
				],
			}),
		);
		expect(first).toContain("model → ds (deepseek-v4-flash · max)");
		expect(JSON.parse(readFileSync(join(dirs.home, "preferences.json"), "utf8")).effort).toEqual({ ds: "max" });

		// nothing is picked: the status row is read once the opening has
		// settled (the boot status paints after the first prompt)
		const raw = ptyRun(["chat", "b1-second", "--model", "ds"], env, { delays: [[2.5, "exit\r"]] });
		const screen = settledScreen(raw);
		const statusRow = screen.find((row) => row.includes("/mode to switch"));
		expect(statusRow, screen.join("\n")).toContain("deepseek-v4-flash · max");
	});
});
