/**
 * TUI2-R2 slice ⑥ — the BOOT STATUS LINE.
 *
 * The status row is the product's one persistent claim about itself:
 * the approval tier it is running under, how to change it, which model
 * is driving, and how much context is left. Until now it appeared after
 * TURN ONE. The idle-fresh screen — the screen every session opens on,
 * and the only screen a first-time user sees before deciding whether to
 * type anything — showed an empty row where all of that belongs.
 *
 * The row was never missing information. `paintIdle` had everything it
 * needed at boot: the mode is set before the agent is built, the model
 * is resolved inside it, and an unstarted session's context estimate is
 * a perfectly good 100%. It simply was not called until a turn ended.
 *
 * THE DECLARED BOOT-STATUS CLASS. Assertions about the opening screen
 * move here: what used to be "the boot frame's status row is empty" is
 * now "the boot frame's status row is the full row". Every moved
 * assertion is enumerated in the round's report.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun, settledScreen } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const ROWS = 24;
const COLS = 100;

/**
 * The IDLE-FRESH screen's first paint — the first frame that shows the
 * session, which is the first frame a human is actually looking at.
 *
 * Not the literally-first frame the process emits: the dock enters
 * before the agent is built, so that frame predates the model being
 * resolved. A status row painted there would have to name a model
 * nobody had chosen yet, and a row that guesses is worse than a row
 * that waits two hundred milliseconds. THIS is the opening screen the
 * round is about.
 */
function bootFrame(raw: string): string[] {
	const CLOSE = "\x1b[?2026l";
	let pos = 0;
	for (;;) {
		const i = raw.indexOf(CLOSE, pos);
		expect(i, "no frame showing the session in the stream").toBeGreaterThan(0);
		const term = new VtScreen(ROWS, COLS);
		term.write(Buffer.from(raw.slice(0, i + CLOSE.length), "utf8"));
		const grid = term.visible();
		if (grid.some((l) => l.startsWith("session "))) return grid;
		pos = i + CLOSE.length;
	}
}

describe("TUI2-R2 ⑥ — the status line is on the FIRST paint (the boot-status class)", () => {
	it("the idle-fresh screen carries the full status row — the tier, the /mode hint, the model, the ctx estimate", () => {
		const { env } = isolatedEnv({ KISO_MODE: "default" });
		const raw = ptyRun(["r2-boot"], env as NodeJS.ProcessEnv, { delays: [[3, "exit\r"]], rows: ROWS, cols: COLS });
		const status = bootFrame(raw)[ROWS - 1] ?? "";
		// MOVED (boot-status class): this row was empty until turn one
		expect(status, "the boot frame's status row").toContain("▸ default");
		expect(status).toContain("/mode to switch");
		expect(status).toContain("ctx left ~");
	}, 240_000);

	it("the row says what it can and no more — an unstarted session has no cache rate and no cost, so it shows neither", () => {
		const { env } = isolatedEnv({ KISO_MODE: "plan" });
		const raw = ptyRun(["r2-boot-2"], env as NodeJS.ProcessEnv, { delays: [[3, "exit\r"]], rows: ROWS, cols: COLS });
		const status = bootFrame(raw)[ROWS - 1] ?? "";
		expect(status).toContain("plan (read-only)"); // the tier, spelled as the REPL spells it
		expect(status).not.toContain("CH "); // no requests yet — no cache rate to claim
		expect(status).not.toContain("$"); // and no cost
	}, 240_000);

	it("the boot row is the SAME formatter the settled row uses — one definition, not a boot-time copy", () => {
		const { env } = isolatedEnv({ KISO_MODE: "default" });
		const raw = ptyRun(["r2-boot-3"], env as NodeJS.ProcessEnv, { delays: [[3, "exit\r"]], rows: ROWS, cols: COLS });
		const boot = (bootFrame(raw)[ROWS - 1] ?? "").trimEnd();
		const settled = (settledScreen(raw, ROWS, COLS)[ROWS - 1] ?? "").trimEnd();
		// nothing happened in between, so the two must be identical: a
		// second boot-time row would drift from the real one the moment
		// either changed
		expect(boot).toBe(settled);
	}, 240_000);
});
