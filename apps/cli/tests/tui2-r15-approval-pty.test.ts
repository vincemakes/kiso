/**
 * TUI2-R1.5 slice ② — VD-2 on the real approval surface.
 *
 * The unit proves editFileDiff now locates the way the tool locates.
 * This proves the thing the human actually sees: the approval panel for
 * the walkthrough's own edit — "// OLD" indented inside "  // OLD" in a
 * four-line src/parser.ts — shows the one changed line, and does NOT
 * show the function signature as deleted.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, spares } from "./helpers/pty.js";

/** The walkthrough's own workspace fixture. */
function parserWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "parser.ts"), "export function parseExpr(t: Token) {\n  // OLD\n  return t;\n}\n", "utf8");
	return dir;
}

const EDIT = {
	type: "tool_call_end",
	callId: "e1",
	name: "edit_file",
	input: { path: "src/parser.ts", search: "// OLD", replace: "if (t == null) throw new Error('null token');", expectedRevision: "rev:fb218fcdf7981cd6" },
};

describe("TUI2-R1.5 ② — the edit approval diff on a real PTY", () => {
	it("the MID-LINE edit shows a one-line ± window, not the whole file deleted", () => {
		const ws = parserWorkspace();
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Fixing the null check." }, EDIT, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "fixed it." }, { type: "stop", reason: "end_turn" }] },
			...spares(),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r15-diff"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["fixed it.", "exit\r"],
			],
			// the answer waits on the WALL CLOCK: the panel's status text is
			// written before its rows are, so an answer fed on that needle
			// dismisses the panel before it has finished painting.
			delays: [[2, "1\r"]],
			cwd: ws,
		});
		// the panel frame, read at its last fully-painted affordance row
		const grid = screenAt(raw, "↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		const joined = grid.join("\n");
		// the ONE changed line, both sides
		expect(joined).toContain("-   // OLD");
		expect(joined).toContain("+   if (t == null) throw new Error('null token');");
		// the signature and the closing brace are CONTEXT — never deletions
		// (the panel's diff rows carry the block gutter: "│ -   <text>")
		expect(grid.some((l) => /^│ -\s*export function parseExpr/.test(l))).toBe(false);
		expect(grid.some((l) => /^│ -\s*return t;/.test(l))).toBe(false);
		// …and the whole file is not the old side: exactly one "-" row
		expect(grid.filter((l) => /^│ -/.test(l))).toHaveLength(1);
		expect(grid.filter((l) => /^│ \+/.test(l))).toHaveLength(1);
	}, 240_000);

	it("a search that is NOT in the file gets the honest note, never a fabricated diff", () => {
		const ws = parserWorkspace();
		const miss = { ...EDIT, input: { path: "src/parser.ts", search: "// NOT THERE AT ALL", replace: "x", expectedRevision: "rev:fb218fcdf7981cd6" } };
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Trying an edit." }, miss, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "that missed." }, { type: "stop", reason: "end_turn" }] },
			...spares(),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r15-diff-miss"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["that missed.", "exit\r"],
			],
			delays: [[2, "1\r"]],
			cwd: ws,
		});
		const joined = screenAt(raw, "↑↓ move · ⏎ or click confirms · 1-4 instant · esc").join("\n");
		expect(joined).toContain("pattern not found in src/parser.ts");
		// nothing invented: the file's own lines are not drawn as removals
		expect(joined).not.toContain("-export function parseExpr");
	}, 240_000);
});
