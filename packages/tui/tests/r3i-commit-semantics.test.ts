/**
 * R3i phase 3 — THE COMMIT SEMANTICS. The hazard zone.
 *
 * design.md §8 names this change and forbids it riding in a visual
 * round: "Folding at every text boundary changes *what commits and
 * when*, which is the machinery every scrollback gate watches." So the
 * gates come first, and they are about the machinery, not the pixels.
 *
 * Two owner rulings are implemented here, each superseding a standing
 * one:
 *
 * ① THE FOLD RETURNS TO THE SEGMENT (supersedes R3d). R3d moved it to
 *    the turn, which put every one of a turn's counts on one line ABOVE
 *    all of its prose. The shape the owner asked for — and photographed
 *    — is one summary per stretch of work, standing with the prose that
 *    stretch led to. R3d's stated reason for leaving the segment was
 *    R3b's disease, a chatty model turning every call into its own
 *    `✦ thought 2s · 1 read` row; the cures are the two rules R3b never
 *    had — a fold must absorb at least two rows, and a stretch of
 *    exactly one call names its TARGET rather than its count.
 *
 * ② TROUBLE FOLDS, NAMED (supersedes the R3b trouble rule and R3g's
 *    interrupt hold). Law 1.3 governs marks versus words and never
 *    granted a failure a permanent row; law 1.7 says "Work folds, words
 *    do not". So the work folds and the outcome WORDS ride the line.
 *    Without pressing a key the human sees that trouble happened, on
 *    which call, and what happened; behind the key is the stderr, which
 *    is detail, not outcome. The cost R3b accepted — "a turn that reads
 *    twenty files and hits one denial keeps all twenty rows" — was
 *    priced as rare, and the 0.16.7 dogfood measured it at 2 failures
 *    in 28 calls, with zero folds as the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 90;
	const H = opts.H ?? 40;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const rows = (): string[] => {
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		return s.rows.map((r) => r.join("").replace(/\s+$/, "")).filter((l) => l !== "" && !l.startsWith("─") && !l.includes("/ commands"));
	};
	return { body, writes, rows, tick: () => vi.advanceTimersByTime(30) };
}
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const call = (b: Body, name: string, id: string, input: Record<string, unknown>, isError = false): void => {
	b.toolStart(name, id, input);
	b.toolRunning(id);
	b.toolResult(id, { content: "x", isError });
};
const isFold = (l: string): boolean => /^✦ /.test(l.trimStart());

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R3i ① — one summary per stretch, standing with its prose", () => {
	it("a two-stretch turn commits chip → fold → prose → fold → prose", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("look at this project");
		body.thinkingAppend("planning");
		vi.advanceTimersByTime(8000);
		call(body, "read_file", "a", { path: "a.ts" });
		call(body, "read_file", "b", { path: "b.ts" });
		body.textAppend("I'll read a few core files first.\n");
		body.textEnd();
		body.thinkingAppend("now the layout");
		vi.advanceTimersByTime(10000);
		call(body, "list_dir", "c", { path: "src" });
		call(body, "shell", "d", { command: "npm run check" });
		body.textAppend("Here is the map.\n");
		body.textEnd();
		body.endTurn(18);
		tick();
		const r = rows();
		const chip = r.findIndex((l) => l.includes("look at this project"));
		const fold1 = r.findIndex(isFold);
		const prose1 = r.findIndex((l) => l.includes("I'll read a few core files"));
		const fold2 = r.findIndex((l, i) => i > prose1 && isFold(l));
		const prose2 = r.findIndex((l) => l.includes("Here is the map."));
		expect(chip).toBe(0);
		expect(fold1).toBe(chip + 1);
		expect(prose1).toBeGreaterThan(fold1);
		expect(fold2).toBeGreaterThan(prose1);
		expect(prose2).toBeGreaterThan(fold2);
	});

	it("each fold's counts are ITS stretch's, never the turn's", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		call(body, "read_file", "b", { path: "b.ts" });
		body.textAppend("mid.\n");
		body.textEnd();
		call(body, "list_dir", "c", { path: "src" });
		call(body, "shell", "d", { command: "npm run check" });
		body.textAppend("end.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		const folds = rows().filter(isFold);
		expect(folds).toHaveLength(2);
		expect(folds[0]).toContain("read 2 files");
		expect(folds[0]).not.toContain("shell");
		expect(folds[1]).toContain("listed 1 directory");
		expect(folds[1]).toContain("ran 1 shell command");
		expect(folds[1]).not.toContain("read");
	});

	it("the seconds are the SEGMENT's thinking, not the turn's", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		body.thinkingAppend("first");
		vi.advanceTimersByTime(8000);
		call(body, "read_file", "a", { path: "a.ts" });
		body.textAppend("mid.\n");
		body.textEnd();
		body.thinkingAppend("second");
		vi.advanceTimersByTime(10000);
		call(body, "read_file", "b", { path: "b.ts" });
		call(body, "read_file", "c", { path: "c.ts" });
		body.textAppend("end.\n");
		body.textEnd();
		body.endTurn(18);
		tick();
		const folds = rows().filter(isFold);
		expect(folds[0]).toContain("thought 8s");
		expect(folds[1]).toContain("thought 10s");
	});

	it("a stretch of ONE call and no thinking keeps the call's own row", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("run it");
		call(body, "shell", "s", { command: "npm run check" });
		body.textAppend("green.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		const r = rows();
		expect(r.some(isFold)).toBe(false);
		expect(r.some((l) => l.includes("npm run check"))).toBe(true);
	});

	it("thinking + ONE call folds, and NAMES the target — R3d's defect answered", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		vi.advanceTimersByTime(2000);
		call(body, "read_file", "a", { path: "editor.ts" });
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(2);
		tick();
		const fold = rows().find(isFold) ?? "";
		expect(fold).toContain("read editor.ts");
		expect(fold).not.toContain("1 file"); // the count would say less than the two rows it replaces
	});
});

describe("R3i ② — trouble folds, and the line names it", () => {
	it("a failure does not stop the fold — it is named on it", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 6; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, i === 2);
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		// FIVE, not six: the call that failed read nothing, so it is not
		// counted as work done — it is counted in the clause. A line that
		// said `read 6 files · 1 failed` would be claiming, in one
		// breath, that six files were read and that one of them was not.
		const fold = rows().find(isFold) ?? "";
		expect(fold).toContain("read 5 files");
		expect(fold).toContain("1 failed");
		expect(fold).toContain("f2.ts"); // WHICH call
	});

	it("a denial is named as denied, an interrupt as interrupted", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		body.toolStart("edit_file", "e", { path: ".env" });
		body.toolVerdict("e", "denied");
		body.toolResult("e", { content: "no", isError: false });
		body.textAppend("ok.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		expect(rows().find(isFold) ?? "").toContain("1 denied: .env");
	});

	it("an interrupted stretch folds too, and says so", () => {
		const { body, rows, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		body.toolStart("shell", "s", { command: "sleep 100" });
		body.toolRunning("s"); // esc — no result ever comes
		body.endTurn(0);
		tick();
		expect(rows().find(isFold) ?? "").toContain("1 interrupted");
	});
});

describe("R3i ③ — the hold, and what the key answers", () => {
	it("no cell of an OPEN stretch commits; the CLOSED one's fold does", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		call(body, "read_file", "b", { path: "b.ts" });
		tick();
		expect(plain(writes.join(""))).not.toMatch(/✦[^\n]*ctrl\+r/); // still open: nothing folded
		body.textAppend("mid.\n");
		body.textEnd();
		tick();
		expect(plain(writes.join(""))).toMatch(/✦[^\n]*ctrl\+r/); // the text closed it, and it committed
	});

	it("each fold's key opens exactly ITS stretch, and the header says so", () => {
		const { body, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		call(body, "read_file", "b", { path: "b.ts" });
		body.textAppend("mid.\n");
		body.textEnd();
		call(body, "shell", "s", { command: "npm run check" });
		call(body, "list_dir", "l", { path: "src" });
		body.textAppend("end.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		// newest first: the second stretch
		const first = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(first).toContain("npm run check");
		expect(first).not.toContain("a.ts"); // the OTHER stretch's work is not in this block
		const second = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(second).toContain("a.ts");
		expect(second).not.toContain("npm run check");
	});
});
