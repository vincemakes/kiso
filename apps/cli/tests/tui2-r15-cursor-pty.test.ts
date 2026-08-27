/**
 * TUI2-R1.5 slice ⑩ — VD-12: the cursor parks where the next keystroke
 * lands.
 *
 * The walkthrough found the resting cursor over the status line's
 * "de▮ault" (s1-06/09), at the end of the streamed text (s2-04), and
 * inside the approval panel's rule row (s1-05). A terminal cursor is not
 * decoration: it is the product's claim about where typing will appear,
 * and a claim that is wrong in three of the surfaces is worse than no
 * claim at all.
 *
 * The contract asserted here: after every settle the cursor rests at the
 * ACTIVE INPUT position — the composer's, or, while a panel owns the
 * keys, the panel's own prompt row (the dim `› ` — MOVED, the TUI2-R3v2
 * panel-selection supersession class: `1-3> ` was a prompt for input the
 * list phase does not ask for), which is where the user's
 * next keystroke really goes.
 *
 * The emulator reads the cursor the same way a terminal does, from the
 * CUP/CUU/CHA stream, so these assertions are about the bytes the
 * product actually emits.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, settledTerm, spares, termAt } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const ROWS = 24;
const COLS = 100;

/** A row that is nothing but the dashed rule — the composer's rails. */
const isRail = (row: string): boolean => /^\u2500+$/.test(row.trimEnd());

/** An input row: a non-rail row with a rail above it and a rail below
 *  it. That is the CHROME_ROWS=4 contract itself — rail, input, rail,
 *  status — so it holds for the composer, for its multi-line
 *  continuation rows, and for a panel's own prompt row. */
function betweenRails(grid: readonly string[], row: number): boolean {
	if (isRail(grid[row] ?? "")) return false;
	let above = false;
	for (let r = row - 1; r >= 0; r -= 1) {
		if (isRail(grid[r] ?? "")) {
			above = true;
			break;
		}
	}
	let below = false;
	for (let r = row + 1; r < grid.length; r += 1) {
		if (isRail(grid[r] ?? "")) {
			below = true;
			break;
		}
	}
	return above && below;
}

/**
 * The composer's input row is H−2 (0-based H−3 in the grid: rail, input,
 * rail, status). The cursor must be ON it, never on another row.
 *
 * DECLARED SUPERSESSION (R2): the row used to be found by `│ ›` — one
 * cell of box wall plus the chevron. Law 1.1 retired the box and the
 * owner's ruling retired the chevron, so the row is identified
 * STRUCTURALLY: the non-rail row between the composer's two rails. The
 * column floor went with the lead — column one is where an empty
 * composer legitimately parks — and what replaces it is the ceiling,
 * which is the claim that can still be false.
 */
function expectParkedInComposer(term: VtScreen, where: string): void {
	const grid = term.visible();
	const { row, col } = term.cursor;
	expect(betweenRails(grid, row), `${where}: cursor on row ${row} (${JSON.stringify(grid[row] ?? "")}), not an input row`).toBe(true);
	expect(col, `${where}: cursor at col ${col}, past the width`).toBeLessThan(COLS);
}

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "parser.ts"), "export function parseExpr(t: Token) {\n  // OLD\n  return t;\n}\n", "utf8");
	writeFileSync(join(dir, "steps.sh"), 'for i in 1 2 3 4 5 6; do echo "step $i of six"; sleep 0.4; done\n', "utf8");
	return dir;
}

describe("TUI2-R1.5 ⑩ — the cursor parks in the composer (VD-12)", () => {
	// NOTE: the four single-state cases (post-turn, post-/context,
	// typed-during-run, post-ctrl+r) were folded into the every-frame gate
	// below, which strictly subsumes them — it walks EVERY frame of a
	// session that exercises all four. Each one cost its own blocking
	// execFileSync PTY spawn, and six spawns in one file starve vitest's
	// reporter RPC (the "Timeout calling onTaskUpdate" unhandled error the
	// round hit at 193 files). Same coverage, a third of the wall time.
	it("EVERY FRAME of a mixed session ends with the cursor on an input row", () => {
		// The strongest form of the contract, and the one that catches a
		// regression anywhere: not "these five states", but every frame the
		// product emits during a session that exercises a tool run, an
		// approval, a slash command and the expand key. The compositor
		// brackets each frame in DEC 2026, so the boundaries are in the
		// stream and each one is a moment a terminal actually displays.
		const ws = workspace();
		const edit = {
			type: "tool_call_end",
			callId: "e1",
			name: "edit_file",
			input: { path: "src/parser.ts", search: "// OLD", replace: "if (t == null) throw new Error('null token');", expectedRevision: "rev:fb218fcdf7981cd6" },
		};
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Fixing it." }, edit, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "fixed it." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r15-cur-all"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["needs approval", "1\r"],
				["fixed it.", "\x12"],
			],
			delays: [[5, "/context\r"], [7, "exit\r"]],
			cwd: ws,
		});
		const CLOSE = "\x1b[?2026l";
		let pos = 0;
		let frames = 0;
		const strays: string[] = [];
		for (;;) {
			const i = raw.indexOf(CLOSE, pos);
			if (i < 0) break;
			const term = new VtScreen(ROWS, COLS);
			term.write(Buffer.from(raw.slice(0, i + CLOSE.length), "utf8"));
			frames += 1;
			const line = term.visible()[term.cursor.row] ?? "";
			// an input row is the composer's, its multi-line continuation, or
			// a panel's own prompt — every one of them is a place a keystroke
			// legitimately lands, and every one of them sits between the
			// composer's two rails (R2: see betweenRails)
			if (!betweenRails(term.visible(), term.cursor.row)) strays.push(`frame ${frames}: ${JSON.stringify(line.slice(0, 60))}`);
			pos = i + CLOSE.length;
		}
		expect(frames, "no frames in the stream").toBeGreaterThan(5);
		expect(strays, `frames whose cursor is not on an input row:\n${strays.join("\n")}`).toHaveLength(0);
	}, 240_000);

	it("APPROVAL PANEL: the cursor rests on the panel's own prompt row, never inside its header", () => {
		const ws = workspace();
		const edit = {
			type: "tool_call_end",
			callId: "e1",
			name: "edit_file",
			input: { path: "src/parser.ts", search: "// OLD", replace: "if (t == null) throw new Error('null token');", expectedRevision: "rev:fb218fcdf7981cd6" },
		};
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Fixing it." }, edit, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "fixed it." }, { type: "stop", reason: "end_turn" }] },
			...spares(),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r15-cur-panel"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			delays: [[3, "1\r"], [6, "exit\r"]],
			cwd: ws,
		});
		const term = termAt(raw, "↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		const grid = term.visible();
		// the panel is really up — the assertion below is about that state
		expect(grid.join("\n")).toContain("needs approval");
		expectParkedInComposer(term, "approval-panel");
		// and specifically NOT inside the panel's block
		const { row } = term.cursor;
		expect(grid[row] ?? "", "the cursor is inside the panel block").not.toMatch(/needs approval|args \(full\)/);
	}, 240_000);
});
