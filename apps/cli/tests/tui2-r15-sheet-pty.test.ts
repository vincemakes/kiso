/**
 * TUI2-R1.5 slice ⑦(a) — VD-8: the keys sheet leaves no litter.
 *
 * The sheet already renders in the panel slot and any key already closes
 * it. What VD-8 is really about is what the open COSTS: on a screen that
 * is already full, adding the sheet's rows grows the model, the frame's
 * skip grows with it, and the difference is paid in real LFs — rows
 * scrolled permanently into the terminal's scrollback. Close the sheet
 * and they do not come back, because scrollback is not ours to rewrite.
 *
 * The measurement is the mechanism: a real LF is the ONLY way this
 * product moves a row into the scrollback (the #13 gate pins that), so
 * counting the LFs between the pre-open frame and the post-close frame
 * counts the litter exactly. Zero LFs, zero litter.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const ROWS = 24;
const COLS = 100;

/** A turn big enough to fill the screen before the sheet opens. */
function turns(): unknown[] {
	const events: unknown[] = [{ type: "text_delta", text: "Looking around." }];
	for (let i = 0; i < 6; i += 1) events.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
	events.push({ type: "stop", reason: "tool_use" });
	return [{ events }, { events: [{ type: "text_delta", text: "had a look." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)];
}

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, `f${i}.txt`), `alpha ${i}\nbeta ${i}\n`, "utf8");
	return dir;
}

/** The frame boundary at or after `from`. */
function frameEnd(raw: string, from: number): number {
	const i = raw.indexOf("\x1b[?2026l", from);
	return i < 0 ? raw.length : i + "\x1b[?2026l".length;
}

function screenAtIndex(raw: string, end: number): string[] {
	const t = new VtScreen(ROWS, COLS);
	t.write(Buffer.from(raw.slice(0, end), "utf8"));
	return t.visible();
}

describe("TUI2-R1.5 ⑦(a) — the sheet leaves no litter (VD-8)", () => {
	it("open then close: ZERO rows scroll away, and the screen returns to what it was", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(turns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-sheet-litter"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			// let the turn settle and fill the screen, THEN ? … then any key
			delays: [
				[4, "?"],
				[6, "x"],
				[7, "exit\r"],
			],
			timeout: 30,
			cwd: ws,
		});
		// the sheet really opened (its own row) and really closed
		expect(raw).toContain("expand cells");
		const openAt = raw.lastIndexOf("expand cells");
		expect(openAt).toBeGreaterThan(0);

		// the frame BEFORE the open: walk back to the previous boundary
		const CLOSE = "\x1b[?2026l";
		const preEnd = raw.lastIndexOf(CLOSE, openAt) + CLOSE.length;
		const before = screenAtIndex(raw, preEnd);
		// the frame AFTER the close: the sheet's rows are gone again
		const closedAt = raw.indexOf("expand cells", openAt) < 0 ? openAt : openAt;
		const postEnd = frameEnd(raw, frameEnd(raw, closedAt) + 1);
		const after = screenAtIndex(raw, postEnd);

		// THE LITTER MEASURE: a real LF is the only way this product moves a
		// row into the scrollback (the #13 gate). Between the frame before
		// the open and the frame after the close there must be none.
		const between = raw.slice(preEnd, postEnd);
		const lfs = (between.match(/\n/g) ?? []).length;
		expect(lfs, `${lfs} rows scrolled into the scrollback across the sheet's open/close`).toBe(0);

		// …and the screen itself is back: the body rows are unchanged
		const body = (g: string[]): string[] => g.slice(0, g.findIndex((l) => l.startsWith("╭"))).filter((l) => l.trim() !== "");
		expect(body(after)).toEqual(body(before));
	}, 240_000);
});
