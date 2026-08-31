/**
 * R5 — the transcript viewer, in a REAL terminal.
 *
 * The unit gates prove the projection and the compositor's arithmetic.
 * This one proves the thing that decides whether the surface may ship at
 * all: that a viewer which owns the whole live region on the PRIMARY
 * screen leaves the terminal's scrollback exactly as it found it.
 *
 * The measurement is the mechanism, borrowed verbatim from the sheet's
 * own VD-8 gate: a real LF is the ONLY way this product moves a row into
 * the scrollback (the #13 gate pins that), so counting the LFs across
 * the open/close counts the litter exactly.
 *
 * If this gate ever goes red, the viewer does not ship — no amount of
 * the rest of it being good buys back a scrollback kiso cannot rewrite.
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

/** Two stretches with prose between them, so the session has real folds
 *  AND enough rows to fill the screen before the viewer opens. */
function turns(): unknown[] {
	const first: unknown[] = [{ type: "text_delta", text: "Looking around." }];
	for (let i = 0; i < 6; i += 1) first.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
	first.push({ type: "stop", reason: "tool_use" });
	const second: unknown[] = [{ type: "text_delta", text: "and again." }];
	for (let i = 6; i < 10; i += 1) second.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
	second.push({ type: "stop", reason: "tool_use" });
	return [{ events: first }, { events: second }, { events: [{ type: "text_delta", text: "had a look." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)];
}

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-r5-"));
	for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.txt`), `alpha ${i}\nbeta ${i}\n`, "utf8");
	return dir;
}

const frameEnd = (raw: string, from: number): number => {
	const i = raw.indexOf("\x1b[?2026l", from);
	return i < 0 ? raw.length : i + "\x1b[?2026l".length;
};
const screenAtIndex = (raw: string, end: number): string[] => {
	const t = new VtScreen(ROWS, COLS);
	t.write(Buffer.from(raw.slice(0, end), "utf8"));
	return t.visible();
};

describe("R5 — the transcript viewer leaves the scrollback alone (the blocker)", () => {
	it("ctrl+o, move, expand, esc: ZERO rows scroll away and the screen comes back", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(turns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r5-viewer-litter"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			delays: [
				[5, "\x0f"], // ctrl+o — open
				[6, "\x1b[A"], // ↑ — move the cursor
				[7, "\r"], // ⏎ — expand in place
				[8, "\x1b"], // esc — close
				[9, "exit\r"],
			],
			timeout: 40,
			cwd: ws,
		});

		// it really opened: the band names itself and carries its keys
		expect(raw).toContain("transcript ·");
		expect(raw).toContain("esc closes");
		const openAt = raw.lastIndexOf("transcript ·");
		expect(openAt).toBeGreaterThan(0);

		const CLOSE = "\x1b[?2026l";
		const preEnd = raw.lastIndexOf(CLOSE, openAt) + CLOSE.length;
		const before = screenAtIndex(raw, preEnd);
		// The frame after the CLOSE, found by CONTENT rather than by
		// counting: walk frame boundaries forward until the band is no
		// longer on the screen. Counting frames guessed at the renderer's
		// cadence and landed mid-transition (12 rows against 11) — the
		// question this gate asks is "is the band gone and the body back",
		// so the search should ask exactly that.
		let postEnd = frameEnd(raw, openAt);
		for (let i = 0; i < 40; i += 1) {
			const g = screenAtIndex(raw, postEnd);
			if (!g.some((l) => l.includes("transcript ·"))) break;
			const next = frameEnd(raw, postEnd + 1);
			if (next === postEnd) break;
			postEnd = next;
		}
		const after = screenAtIndex(raw, postEnd);
		expect(after.some((l) => l.includes("transcript ·")), "the viewer never closed").toBe(false);

		const between = raw.slice(preEnd, postEnd);
		const lfs = (between.match(/\n/g) ?? []).length;
		expect(lfs, `${lfs} rows scrolled into the scrollback across the viewer's open/close`).toBe(0);

		// ...and the body is back, row for row
		// ...and NOT ONE ROW WAS LOST. Stated as a suffix rather than an
		// equality, and the reason is worth recording: the pre-open sample
		// is a frame boundary mid-stream, where the diff renderer has not
		// necessarily repainted the banner rows; the CLOSE takes the full
		// redraw path and legitimately restores more than that sample had
		// painted. Demanding equality would fail on the restore being MORE
		// complete than the sample, which is the opposite of litter.
		const body = (g: string[]): string[] => g.slice(0, g.findIndex((l) => l.startsWith("─"))).filter((l) => l.trim() !== "");
		const [b4, af] = [body(before), body(after)];
		expect(af.slice(af.length - b4.length), `rows lost across the viewer's open/close`).toEqual(b4);
	}, 240_000);

	it("the PIPE never renders it — no compositor, no viewer, no stray key", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(turns()), KISO_MODE: "bypass" });
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		const CLI = join(__dirname, "..", "dist", "index.js");
		const out = execFileSync("node", [CLI, "chat", "r5-viewer-pipe"], {
			env: env as NodeJS.ProcessEnv,
			input: "go\n\x0f\nexit\n",
			encoding: "utf8",
			cwd: ws,
			timeout: 120_000,
		});
		expect(out).not.toContain("transcript ·");
		expect(out).not.toContain("esc closes");
	}, 240_000);
});
