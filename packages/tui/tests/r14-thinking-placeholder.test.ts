/**
 * 0.24.2 ② — the live region's `thinking…` placeholder.
 *
 * Between the human pressing enter and the model's first byte, and
 * again between a card committing and the next thing arriving, the live
 * region is EMPTY: the composer sits under a blank stretch and the only
 * sign anything is happening is the status row. The owner read that as
 * the product having stopped.
 *
 * So: when a turn is in flight, and the live projection has drawn
 * nothing, and no card is running, the live region carries one row —
 * `  thinking…`, dim italic, column 2, no glyph. Whatever arrives
 * replaces it IN PLACE: a thinking paragraph is the same column and the
 * same font, so the eye sees a word change and not a jump.
 *
 * IT IS NEVER COMMITTED. It is not a cell, it never reaches the
 * scrollback, and `/last` and the pipe have never heard of it. That is
 * the whole of why it is allowed to be a guess about the future: a row
 * that never becomes history cannot make history wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";
import { VtScrollback } from "./vt-scrollback.js";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const W = 80;
const H = 24;

function makeBody(active = true) {
	const writes: string[] = [];
	const body = new Body({ active: () => active, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const screen = (): string[] => {
		const sc = new Screen(W, H);
		sc.feed(writes.join(""));
		return sc.rows.map((r) => plain(r.join("")).replace(/\s+$/, ""));
	};
	return { body, writes, screen, tick: () => vi.advanceTimersByTime(30) };
}

const has = (rows: readonly string[]): boolean => rows.some((r) => r.trim() === "thinking…");

describe("0.24.2 ② — the placeholder says the turn is alive", () => {
	it("after the human's line, before anything comes back", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("what is in here");
		tick();
		expect(has(screen()), "the live region is silent while the turn is in flight").toBe(true);
	});

	it("…at column 2, dim italic, with no glyph", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("go");
		tick();
		const raw = writes.join("");
		expect(raw, "the placeholder is not dim+italic").toMatch(/\x1b\[2m\x1b\[3m\s*thinking…|\x1b\[2m {2}\x1b\[3mthinking…/);
		const row = screen0(writes).find((r) => r.trim() === "thinking…")!;
		expect(row.match(/^ */)![0].length, "not at column 2").toBe(2);
	});

	it("a card RUNNING replaces it — two things never claim the same moment", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("go");
		tick();
		expect(has(screen())).toBe(true);
		body.toolStart("shell", "s1", { command: "npm test" });
		body.toolRunning("s1");
		tick();
		expect(has(screen()), "the placeholder outlived the card that replaced it").toBe(false);
	});

	it("…and comes BACK between a committed card and the next thing", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("go");
		body.toolStart("read_file", "r1", { path: "a.ts" });
		body.toolRunning("r1");
		body.toolResult("r1", { content: "l0", isError: false });
		tick();
		expect(has(screen()), "the gap after a settle is silent again").toBe(true);
	});

	it("the turn ENDS and it is gone", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("go");
		tick();
		expect(has(screen())).toBe(true);
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		expect(has(screen()), "the placeholder survived the turn").toBe(false);
	});

	it("IT IS NEVER COMMITTED — not on the screen's history, not in the scrollback", () => {
		const out: string[] = [];
		const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => out.push(s) });
		body.enter();
		body.userLine("go");
		vi.advanceTimersByTime(30);
		for (let i = 0; i < 6; i += 1) {
			body.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
			body.toolRunning(`r${i}`);
			body.toolResult(`r${i}`, { content: "l0\nl1", isError: false });
			vi.advanceTimersByTime(30);
		}
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(0);
		vi.advanceTimersByTime(30);
		const vt = new VtScrollback(H, W);
		vt.feed(out.join(""));
		const everything = [...vt.scrollback, ...Array.from({ length: H }, (_, i) => vt.line(i + 1))].map(plain);
		expect(everything.filter((r) => r.includes("thinking…")), "the placeholder reached the transcript").toEqual([]);
	});

	it("a PIPE never sees it", () => {
		const { body, writes, tick } = makeBody(false);
		body.enter();
		body.userLine("go");
		tick();
		expect(writes.join("")).not.toContain("thinking…");
	});
});

function screen0(writes: readonly string[]): string[] {
	const sc = new Screen(W, H);
	sc.feed(writes.join(""));
	return sc.rows.map((r) => plain(r.join("")).replace(/\s+$/, ""));
}
