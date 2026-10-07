/**
 * Graphite, the tasks round (owner, 2026-10-06) — a background task on a
 * real pty: when it ends the TASK row says how and what ran; `/tasks` →
 * the task → show its output opens a sheet over the input, not lines in
 * the conversation; and what is typed while the sheet is up is typed.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const COMMAND = "for i in 1 2; do echo tick $i; sleep 1; done";

describe("the tasks round on a real pty", () => {
	it("the TASK row says how the task ended and what ran; its output is a sheet", () => {
		const { env } = isolatedEnv({
			KISO_MODE: "full-access",
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "tool_call_end", callId: "b1", name: "shell", input: { command: COMMAND, background: true } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "started it." }, { type: "stop", reason: "end_turn" }] },
				...spares(4),
			]),
		});
		const raw = ptyRun(["chat", "tasks-ui"], env as NodeJS.ProcessEnv, {
			// needles only the step they wait for can bring on screen: the TASK
			// row's outcome, the /tasks band's facts, the actions band's row,
			// and the output sheet's band
			feeds: [
				["/mode to switch", "go\r"],
				["exited 0", "/tasks\r"],
				["in this session", "\r"],
				["show its output", "\r"],
				["its last output", "exit\r"],
			],
		});
		const t = plain(raw);
		expect(t, "the TASK row").toMatch(/TASK {8}t1 exited 0 · for i in 1 2; do echo tick \$i; sleep 1; done/);
		expect(t, "the pipe's line never reaches the terminal").not.toContain("✦ task t1");
		expect(t, "the output sheet").toMatch(/─── t1 · its last output · exited 0 ─+/);
		expect(t).toMatch(/ {2}tick 1\s+tick 2/);
		expect(t, "the printed form").not.toContain("t1 — its last output");
		// the boot frame, before the bar is bound, offers no retired ladder
		expect(t, "the boot frame's key ladder").not.toContain("/ commands \u00b7 \u2191 history");
	}, 120_000);
});
