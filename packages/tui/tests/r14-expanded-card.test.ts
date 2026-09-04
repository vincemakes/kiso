/**
 * 0.24.2 ③ — the appended expansion is a CARD, and `✦` is not its mark.
 *
 * The owner pressed `ctrl+o` and got:
 *
 *     ✦ expanded · shell curl … · 2 turns back
 *     --- shell input ---
 *     …
 *
 * Three things wrong with it, all shape. It is bare ground in a page
 * where every other piece of machine work is a card, so it does not read
 * as the same kind of thing. It wears `✦`, which is the turn recap's
 * mark — one symbol, two meanings (§4.1). And it lands after the recap,
 * so the reader has a block with no visible tie to the call it came
 * from.
 *
 * This round is the SHAPE only: the block becomes a card whose head row
 * names the call, so the tie is the head row and the mark is not needed.
 * Expanding IN PLACE is DC-50 and waits for route B.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { setGround } from "@vincemakes/kiso-tui-cells/render";
import { visibleWidth } from "@vincemakes/kiso-tui-cells/width";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	setGround("light");
});
afterEach(() => {
	vi.useRealTimers();
	setGround("unknown");
});

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const W = 80;

function expandOf(overLong = 40): { lines: string[]; plainRows: string[] } {
	const body = new Body({ active: () => true, height: () => 24, width: () => W, editCol: () => 1, write: () => {} });
	body.enter();
	body.userLine("go");
	body.toolStart("shell", "s1", { command: "curl -sS https://example.com/a/very/long/path" });
	body.toolRunning("s1");
	body.toolResult("s1", { content: Array.from({ length: overLong }, (_, i) => `out ${i + 1}`).join("\n"), isError: false });
	body.textAppend("done.\n");
	body.textEnd();
	body.endTurn(0);
	vi.advanceTimersByTime(30);
	const r = body.expandNext();
	expect(r.kind, "the press did nothing").toBe("appended");
	const lines = (r as { lines: string[] }).lines;
	return { lines, plainRows: lines.map(plain) };
}

describe("0.24.2 ③ — the expansion is a card", () => {
	it("no `✦` — the recap's mark means one thing (§4.1)", () => {
		expect(expandOf().lines.join("\n")).not.toContain("✦");
	});

	it("pad · head · blank · body · blank · outcome · pad, every row washed and full width", () => {
		const { lines, plainRows } = expandOf();
		expect(plainRows[0]!.trim(), "no pad above").toBe("");
		expect(plainRows[1]!, "the head row does not name the call").toMatch(/shell curl .*expanded · 0 turns back/);
		expect(plainRows[2]!.trim(), "no blank under the head").toBe("");
		expect(plainRows.at(-1)!.trim(), "no pad below").toBe("");
		expect(plainRows.at(-2)!.trim(), "no outcome row").toMatch(/exit 0|lines/);
		expect(plainRows.at(-3)!.trim(), "no blank above the outcome").toBe("");
		for (const row of lines) expect(visibleWidth(row), JSON.stringify(plain(row))).toBe(W);
	});

	it("the body is the WHOLE result — an expansion that capped would be no expansion", () => {
		const { plainRows } = expandOf(40);
		const said = plainRows.join("\n");
		for (const n of [1, 20, 40]) expect(said, `line ${n} is missing`).toContain(`out ${n}`);
		expect(said, "the expansion carried a cut note").not.toContain("ctrl+o expands");
	});

	it("the head row's target is BOLD and its metadata is washDim", () => {
		const { lines } = expandOf();
		expect(lines[1], "the target is not bold").toContain("\x1b[1m");
		expect(lines[1], "the metadata is not washDim").toMatch(/\x1b\[38;5;(241|247)m/);
	});

	it("with no ground it does not paint, and it is still the same rows", () => {
		setGround("unknown");
		const { lines, plainRows } = expandOf();
		expect(lines.join(""), "reverse video is not a fallback for a card").not.toContain("\x1b[7m");
		expect(plainRows.filter((r) => r.trim() === ""), "an unpainted pad is §1.3's empty mark").toEqual([]);
		expect(plainRows.join("\n")).toMatch(/shell curl/);
		expect(plainRows.join("\n")).toContain("out 40");
	});
});
