/**
 * TUI2-R3v2 slice ① — the zero-typing approval, on a real PTY.
 *
 * The unit gates prove the reducer; this proves the CLAIM. A human who
 * reads the panel and presses one key has approved — no digit, no
 * chaser, nothing typed. And the option that grants a DURABLE rule lands
 * a real file on disk, which is the only way to tell a rule apart from a
 * one-time allow.
 *
 * The keystrokes ride the WALL CLOCK, not a needle: the panel's status
 * text is written before its rows are, so an answer fed on a needle can
 * dismiss the panel before it has finished painting (the R1.5 lesson,
 * inherited whole).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, spares } from "./helpers/pty.js";

const SHELL = {
	type: "tool_call_end",
	callId: "s1",
	name: "shell",
	input: { command: "echo approved-by-selection" },
};

function script(): string {
	return fauxScript([
		{ events: [{ type: "text_delta", text: "Running one command." }, SHELL, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
		...spares(),
	]);
}

describe("TUI2-R3v2 ① — the selection panel on a real PTY", () => {
	it("a BARE enter approves — the bar opens on Yes and one key runs it", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-enter"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2, "\r"]], // ← the whole product claim: ONE bare enter
		});
		// the panel painted the v4 list before the answer landed
		const grid = screenAt(raw, "1-4 instant");
		const joined = grid.join("\n");
		expect(joined).toContain("Yes, run it");
		expect(joined).toContain("Show me safer ways to do this");
		expect(joined).toContain("↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		// …and the bare enter ran it
		expect(raw).toContain("approved-by-selection");
	}, 240_000);

	it("↓ then enter takes option 2 — the DURABLE rule file lands on disk", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-rule"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2, "\x1b[B"], [2.4, "\r"]],
		});
		expect(raw).toContain("approved-by-selection");
		const rule = join(dirs.extensions as string, "dont-ask-again.mjs");
		expect(existsSync(rule)).toBe(true);
		// the granularity the copy promises: the TOOL NAME, nothing narrower
		expect(readFileSync(rule, "utf8")).toContain('["shell"]');
	}, 240_000);

	it("the digit is instant — 1 approves with no enter after it", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script(), KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-digit"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2, "1"]], // no \r
		});
		expect(raw).toContain("approved-by-selection");
	}, 240_000);
});
