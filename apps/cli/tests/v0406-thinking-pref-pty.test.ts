/**
 * 0.40.6 — ctrl+t's thinking display is REMEMBERED.
 *
 * The owner, 2026-09-23, after the reference implementation's persisted
 * toggle: hide the thinking once and it stays hidden. The choice lands in
 * `<KISO_HOME>/preferences.json` (kiso-owned, 0600) — never in
 * config.json, the human's file — and the next session starts hidden: its
 * first thinking block is one italic line from its first character.
 *
 * REAL kiso chat under a pty, faux provider, one KISO_HOME for both runs.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const THOUGHT =
	"Weighing the two shapes for this. The first keeps every character on the screen and pays for it in rows; the second is quieter and leaves nothing behind, which reads as a fault even when the log still holds it.";
const turn = (answer: string): unknown => ({
	events: [
		{ type: "thinking", text: THOUGHT },
		{ type: "text_delta", text: answer },
		{ type: "stop", reason: "end_turn" },
	],
});
const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("0.40.6 — the thinking display survives a restart", () => {
	it("ctrl+t writes `hidden` to preferences.json; the next session starts hidden", () => {
		const { dirs, env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript([turn("the answer."), ...spares(4)]) });
		// the human's config, present before kiso runs (else the first run's
		// scaffold writes one, which is not what this asserts about)
		const configBefore = `${JSON.stringify({ models: {} }, null, 2)}\n`;
		writeFileSync(join(dirs.home, "config.json"), configBefore);
		// run 1: a thinking turn, then ctrl+t hides it — and the choice is written
		const one = strip(
			ptyRun(["pref-one"], env as NodeJS.ProcessEnv, {
				feeds: [["▌ ", "go\r"]],
				delays: [
					[6, "\x14"],
					[8, "exit\r"],
				],
			}),
		);
		expect(one, "shown by default: the first block's words reached the screen").toContain("leaves nothing behind");
		const prefs = join(dirs.home, "preferences.json");
		expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({ thinking: "hidden" });
		expect(statSync(prefs).mode & 0o777, "private").toBe(0o600);
		const configAfter = readFileSync(join(dirs.home, "config.json"), "utf8");
		expect(configAfter, "config.json is the human's file — untouched").toBe(configBefore);
		expect(configAfter).not.toContain("thinking");

		// run 2: a new process (the faux script starts over) and a new session,
		// which starts hidden — the block never streams its text
		const two = strip(
			ptyRun(["pref-two"], env as NodeJS.ProcessEnv, {
				feeds: [
					["▌ ", "go\r"],
					["the answer.", "exit\r"],
				],
			}),
		);
		expect(two, "the next session's block is one line").toMatch(/thinking · hidden · ctrl\+t/);
		expect(two, "and its words never reach the screen").not.toContain("leaves nothing behind");
		expect(two, "the prose is untouched").toContain("the answer.");
	}, 240_000);
});
