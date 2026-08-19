/**
 * TUI2-R2 slice ⑤ (second half) — CURSOR AUTHORITY, state by state.
 *
 * R1.5 proved the contract with an every-frame sweep and folded its five
 * named states into it, for a good reason: each named state cost its own
 * blocking PTY spawn, and six spawns in one file starve vitest's
 * reporter RPC. The sweep is strictly stronger as a gate — but "no frame
 * in this session was wrong" is not the same record as "the cursor is
 * right after a turn, after /context, while typing during a run, after
 * ctrl+r, and under an approval panel", and the round asked for the
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
import { fauxScript, ptyRun, spares, termAt } from "./helpers/pty.js";
import { VtScreen } from "./helpers/vt-screen.js";

const ROWS = 24;
const COLS = 100;

/** The cursor rests on an INPUT row: the composer's, its multi-line
 *  continuation, or a panel's own prompt — every one of them a place a
 *  keystroke legitimately lands. */
function expectParked(term: VtScreen, where: string): void {
	const grid = term.visible();
	const { row, col } = term.cursor;
	const line = grid[row] ?? "";
	expect(line, `${where}: cursor on row ${row} — ${JSON.stringify(line.slice(0, 70))}`).toMatch(/^│ (›|amend›|provider\/model:| )/);
	expect(col, `${where}: cursor at col ${col}, inside the lead`).toBeGreaterThanOrEqual(2);
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
	const script = fauxScript([
		{ events: [{ type: "text_delta", text: "Fixing it." }, edit, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "fixed it." }, { type: "stop", reason: "end_turn" }] },
		...spares(3),
	]);
	const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
	raw = ptyRun(["--mode", "default", "r2-cursor"], env as NodeJS.ProcessEnv, {
		feeds: [
			["▌ ", "go\r"],
			["needs approval", "1\r"],
			["fixed it.", "\x12"],
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
		expectParked(termAt(raw, "expanded", ROWS, COLS), "post-ctrl+r");
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
			if (!/^│ (›|amend›|provider\/model:| )/.test(line)) strays.push(`frame ${frames}: ${JSON.stringify(line.slice(0, 60))}`);
			pos = i + CLOSE.length;
		}
		expect(frames, "no frames in the stream").toBeGreaterThan(5);
		expect(strays, `frames whose cursor is not on an input row:\n${strays.join("\n")}`).toHaveLength(0);
	});
});
