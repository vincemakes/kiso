/**
 * TUI2-R2 slice ⑤ (second half) — CURSOR AUTHORITY, state by state.
 *
 * R1.5 proved the contract with an every-frame sweep and folded its five
 * named states into it, for a good reason: each named state cost its own
 * blocking PTY spawn, and six spawns in one file starve vitest's
 * reporter RPC. The sweep is strictly stronger as a gate — but "no frame
 * in this session was wrong" is not the same record as "the cursor is
 * right after a turn, after /context, while typing during a run, after
 * ctrl+o, and under an approval panel", and the round asked for the
 * second one.
 *
 * So: ONE spawn, five NAMED assertions harvested from it. The session
 * exercises every state; each case slices the byte stream at the frame
 * boundary where that state was on screen and asserts the cursor there.
 * Same cost as the sweep, and the record says which states were proven.
 *
 * The mechanism under test is the round's own: the compositor's single
 * frame-tail park (#parkCursor), one owner instead of the two
 * hand-rolled tails the draw paths used to carry.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, frameEndAfter, ptyRun, spares, termAt } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const ROWS = 24;
const COLS = 100;

/** A row that is nothing but the dashed rule — the composer's rails,
 *  and every panel's. */
const isRail = (row: string): boolean => /^\u2500+$/.test(row.trimEnd());

/**
 * The cursor rests on an INPUT row: the composer's, its multi-line
 * continuation, or a panel's own prompt — every one of them a place a
 * keystroke legitimately lands.
 *
 * DECLARED SUPERSESSION (R2): this used to identify the input row by
 * `^│ ` plus one of four lead glyphs. Both halves are gone — law 1.1
 * retired the box (so there is no left wall) and the owner's composer
 * ruling retired the idle chevron (the cursor sits at column one). The
 * identification is STRUCTURAL now, which is what it always should have
 * been: an input row is a non-rail row BETWEEN the composer's two
 * rails. That is the CHROME_ROWS=4 contract itself — rail, input, rail,
 * status — so the case now pins the geometry rather than a glyph that
 * happened to sit in it.
 */
function expectParked(term: VtScreen, where: string): void {
	const grid = term.visible();
	const { row, col } = term.cursor;
	const line = grid[row] ?? "";
	const why = `${where}: cursor on row ${row} — ${JSON.stringify(line.slice(0, 70))}`;
	expect(betweenRails(grid, row), why).toBe(true);
	// R2: the column floor was 2 — one cell of wall plus one of chevron,
	// neither of which exists. Column one (index 0) is now where an empty
	// composer legitimately parks, so the floor is vacuous and the claim
	// that is NOT is the ceiling: the cursor never lands past the
	// terminal's last column (invariant ①'s companion on the cursor).
	expect(col, `${where}: cursor at col ${col}, past the width`).toBeLessThan(COLS);
}

/** The row is not a rail, and there is a rail above it and a rail below
 *  it — the composer's two, with only input rows in between. */
function betweenRails(grid: readonly string[], row: number): boolean {
	if (isRail(grid[row] ?? "")) return false;
	let above = -1;
	for (let r = row - 1; r >= 0; r -= 1) {
		if (isRail(grid[r] ?? "")) {
			above = r;
			break;
		}
	}
	let below = -1;
	for (let r = row + 1; r < grid.length; r += 1) {
		if (isRail(grid[r] ?? "")) {
			below = r;
			break;
		}
	}
	return above >= 0 && below >= 0;
}

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-r2-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "parser.ts"), "export function parseExpr(t: Token) {\n  // OLD\n  return t;\n}\n", "utf8");
	return dir;
}

let raw = "";

const CLOSE = "\x1b[?2026l";

/** Walk the DEC-2026 frame boundaries and return the emulator at the
 *  FIRST frame whose screen matches. The compositor brackets every frame
 *  in synchronized output, so each boundary is a moment a real terminal
 *  actually displayed — and the cursor is placed by a frame's last
 *  bytes, so a frame boundary is the only honest place to read it. */
function firstFrameWith(pattern: string): VtScreen {
	const re = new RegExp(pattern);
	let pos = 0;
	for (;;) {
		const i = raw.indexOf(CLOSE, pos);
		if (i < 0) throw new Error(`no frame matched ${pattern}`);
		const term = new VtScreen(ROWS, COLS);
		term.write(Buffer.from(raw.slice(0, i + CLOSE.length), "utf8"));
		if (re.test(term.visible().join("\n"))) return term;
		pos = i + CLOSE.length;
	}
}

beforeAll(() => {
	const ws = workspace();
	const edit = {
		type: "tool_call_end",
		callId: "e1",
		name: "edit_file",
		input: { path: "src/parser.ts", search: "// OLD", replace: "if (t == null) throw new Error('null token');", expectedRevision: "rev:fb218fcdf7981cd6" },
	};
	// R13 — the fixture gains a READ, because ctrl+o needs something that
	// HIDES rows to have a target at all. Before this round a settled
	// non-shell call rendered no body (VD-5), so every one of them was
	// expandable; now a call whose whole output is already on screen hides
	// nothing and carries no affordance — which is the rule
	// tui2-r1-suffix has always stated ("a cell that hides NOTHING carries
	// NO suffix"), reaching further than it used to. A read never previews
	// (E1), so it is always the one with something behind the key.
	const read = { type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "src/parser.ts" } };
	const script = fauxScript([
		{ events: [{ type: "text_delta", text: "Fixing it." }, edit, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "reading it." }, read, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "fixed it." }, { type: "stop", reason: "end_turn" }] },
		...spares(3),
	]);
	const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
	raw = ptyRun(["--mode", "default", "r2-cursor"], env as NodeJS.ProcessEnv, {
		feeds: [
			["▌ ", "go\r"],
			["needs approval", "1\r"],
			["fixed it.", "\x0f"],
		],
		delays: [[5, "/context\r"], [7, "exit\r"]],
		cwd: ws,
	});
}, 300_000);

describe("TUI2-R2 ⑤ — the cursor parks at the active input, in every named state", () => {
	it("APPROVAL PANEL: on the panel's own prompt row, never inside its block", () => {
		const term = termAt(raw, "↑↓ move · ⏎ or click confirms · 1-4 instant · esc", ROWS, COLS);
		expect(term.visible().join("\n")).toContain("needs approval");
		expectParked(term, "approval-panel");
		expect(term.visible()[term.cursor.row] ?? "").not.toMatch(/needs approval|args \(full\)/);
	});

	it("TYPED DURING A RUN: the keystroke lands where the cursor says it will", () => {
		// the FIRST frame that shows the running status, not the last: the
		// last paint of "working" is on the teardown path, where the chrome
		// rows are deliberately cleared and there is no composer to park in
		// (a measurement artefact, not a claim the product makes).
		expectParked(firstFrameWith("▸|working"), "typed-during-run");
	});

	it("POST-TURN: after the turn settles, the cursor is back in the composer", () => {
		expectParked(termAt(raw, "fixed it.", ROWS, COLS), "post-turn");
	});

	it("POST-/CONTEXT: a slash command that prints rows does not leave the cursor in them", () => {
		expectParked(termAt(raw, "ctx", ROWS, COLS), "post-/context");
	});

	it("POST-CTRL+R: the expand key's own frame parks like any other", () => {
		// AMENDED (R13): anchored on the FIRST occurrence, not the last.
		// `termAt` takes `lastIndexOf`, and the appended block grew with
		// D1's constant spacing until its last "expanded" fell inside the
		// EXIT teardown — a partial final frame with the chrome already
		// torn down, which is not a frame this case has ever been about.
		// The subject is the expand key's OWN frame: the first one.
		//
		// NEEDLE MOVED (DC-50 / R14, 2026-09-05): the word "expanded" was
		// the appended block's head row. There is no block — the key
		// REPRINTS — so the anchor is the erase, which is the first byte of
		// the frame this case is about. The subject is unchanged: whatever
		// the expand key does, its frame parks the cursor at the input like
		// every other frame.
		const expAt = raw.indexOf("\x1b[2J\x1b[H\x1b[3J");
		expect(expAt, "the expansion never happened").toBeGreaterThan(0);
		const term = new VtScreen(ROWS, COLS);
		term.write(Buffer.from(raw.slice(0, frameEndAfter(raw, expAt + "\x1b[2J\x1b[H\x1b[3J".length)), "utf8"));
		expectParked(term, "post-ctrl+o");
	});

	it("EVERY FRAME of the same session ends on an input row (the R1.5 sweep, carried)", () => {
		let pos = 0;
		let frames = 0;
		const strays: string[] = [];
		for (;;) {
			const i = raw.indexOf(CLOSE, pos);
			if (i < 0) break;
			frames += 1;
			const term = new VtScreen(ROWS, COLS);
			term.write(Buffer.from(raw.slice(0, i + CLOSE.length), "utf8"));
			const line = term.visible()[term.cursor.row] ?? "";
			if (!betweenRails(term.visible(), term.cursor.row)) strays.push(`frame ${frames}: ${JSON.stringify(line.slice(0, 60))}`);
			pos = i + CLOSE.length;
		}
		expect(frames, "no frames in the stream").toBeGreaterThan(5);
		expect(strays, `frames whose cursor is not on an input row:\n${strays.join("\n")}`).toHaveLength(0);
	});
});
