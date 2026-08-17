/**
 * TUI2-R1.5 slice ③ — VD-3: the timers start when the work starts.
 *
 * The walkthrough's frame s2-01 read "working 30s" while the shell it
 * was timing had been running about a second and a half; turn summaries
 * carried 13s and 36s that were mostly the human reading the screen.
 * Both numbers were the SESSION's age, not the work's.
 *
 * The gate is the shape a human actually produces: sit at the composer
 * for a while, then run something short. Whatever the status row says
 * while that tool runs must be about the tool.
 *
 * FINDING R1.5-1 — this gate does NOT go red on base. Both cases pass
 * before the round's change as well as after. The walkthrough's frame
 * s2-01 is a RIG artifact: rig.py waits on the needle "approve" while
 * the panel's own wording is "needs approval", so the wait burned its
 * full 25s timeout, then 4s of quiet, and only then blindly answered.
 * Measured on this machine, that run really had been open 31 seconds,
 * 29 of them waiting for a human at the approval panel — the status row
 * was telling the truth. The gate is kept as a standing regression
 * gate: the property it pins is the one VD-3 asked for, and nothing
 * else in the suite pins it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, settledScreen, spares } from "./helpers/pty.js";

/** Every `working Ns` the run ever painted. */
function workingSeconds(raw: string): number[] {
	return [...raw.matchAll(/working (\d+)s/g)].map((m) => Number(m[1]));
}

/** The turn recap's wall seconds — the `▞ Ns · …` row. */
function recapSeconds(grid: string[]): number | null {
	for (const line of grid) {
		const m = /▞ (\d+)s · /.exec(line);
		if (m !== null) return Number(m[1]);
	}
	return null;
}

describe("TUI2-R1.5 ③ — the timers are about the work (VD-3)", () => {
	it("IDLE FIRST, then a short tool: the working seconds are the tool's, not the session's", () => {
		const ws = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		writeFileSync(join(ws, "quick.sh"), "sleep 1; echo done\n", "utf8");
		const script = fauxScript([
			{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "sh quick.sh" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ran it." }, { type: "stop", reason: "end_turn" }] },
			...spares(),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		// 7 seconds of doing nothing at the composer, THEN the turn.
		const raw = ptyRun(["--mode", "bypass", "r15-timer"], env as NodeJS.ProcessEnv, {
			feeds: [["ran it.", "exit\r"]],
			delays: [[7, "go\r"]],
			timeout: 40,
			cwd: ws,
		});
		const seen = workingSeconds(raw);
		expect(seen.length, "the run never painted a working row").toBeGreaterThan(0);
		// the tool takes ~1s; the session is ~8s old by then. Anything at or
		// above 4 is the session's age leaking into the work's clock.
		expect(Math.max(...seen), `working seconds seen: ${seen.join(",")}`).toBeLessThan(4);
	}, 240_000);

	it("the turn recap counts the TURN's wall, not the session's age", () => {
		const ws = mkdtempSync(join(tmpdir(), "kiso-ws-"));
		writeFileSync(join(ws, "quick.sh"), "sleep 1; echo done\n", "utf8");
		const script = fauxScript([
			{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "sh quick.sh" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ran it." }, { type: "stop", reason: "end_turn" }] },
			...spares(),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-recap"], env as NodeJS.ProcessEnv, {
			feeds: [["ran it.", "exit\r"]],
			delays: [[7, "go\r"]],
			timeout: 40,
			cwd: ws,
		});
		const secs = recapSeconds(settledScreen(raw));
		expect(secs, "no recap row on the settled screen").not.toBeNull();
		expect(secs!, `recap seconds: ${secs}`).toBeLessThan(4);
	}, 240_000);
});
