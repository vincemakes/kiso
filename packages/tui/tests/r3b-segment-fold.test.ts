/**
 * R3b — the SEGMENT fold.
 *
 * design.md §8 named this and forbade it in a visual round: "folding at
 * every text boundary changes what commits and when, which is the
 * machinery every scrollback gate watches". The owner ruled it a round
 * of its own, and ruled the two questions that decide its shape: a
 * segment folds the MOMENT text arrives (not at the turn's end), and
 * each fold reports its OWN segment (not a running total).
 *
 * A segment is a maximal run of thinking/tool cells with no text
 * between them. It CLOSES at a text block or at the turn's end, and on
 * closing it collapses to one line that names its own key.
 *
 * What these gates hold, in order of what would hurt most if it broke:
 *   - the work is never UNREACHABLE — the fold names ctrl+r and ctrl+r
 *     answers with the run's own rows;
 *   - the fold is emitted ONCE per segment, and never for a segment
 *     that already spilled past the hold into the scrollback;
 *   - counts are per-segment, so the second fold does not repeat the
 *     first's work;
 *   - a one-cell segment does not fold, because one row into one row is
 *     pure loss.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16), setSize: (w: number, h: number) => { W = w; H = h; } };
}
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const call = (body: Body, name: string, id: string, input: Record<string, unknown>, out: string): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: out, isError: false });
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** a turn: think, read ×3, speak, edit + shell, speak. Two segments. */
function twoSegments(body: Body): void {
	body.userLine("fix the parser");
	body.thinkingAppend("let me look first");
	body.thinkingEnd();
	for (let i = 0; i < 3; i += 1) call(body, "read_file", `r${i}`, { path: `src/f${i}.ts` }, "a\nb");
	body.textAppend("Found it.\n");
	body.textEnd();
	call(body, "edit_file", "e1", { path: "src/f0.ts", search: "a", replace: "b" }, "+1 -1");
	call(body, "shell", "s1", { command: "npm test" }, "exit 0");
	body.textAppend("Fixed.\n");
	body.textEnd();
	body.endTurn(23);
}

describe("R3b — a segment folds at the text boundary", () => {
	it("each segment collapses to ONE line, and the text between them survives", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect((frame.match(/✦ thought/g) ?? []).length).toBe(2);
		expect(frame).toContain("Found it.");
		expect(frame).toContain("Fixed.");
	});

	it("the counts are the SEGMENT's, not a running total (owner ruling)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		// the first says what the first did…
		expect(frame).toContain("3 reads");
		// …and the second does NOT repeat it
		expect(frame).toContain("1 edit · 1 shell");
		expect(frame).not.toContain("3 reads · 1 edit");
	});

	it("the thinking row folds WITH its segment — it is the segment's first cell", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		expect(plain(writes.join(""))).not.toContain("let me look first");
	});

	it("ZERO terms are dropped (owner ruling) — a term earns its place by having a count", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("no reads");
		expect(frame).not.toContain("no edits");
	});
});

describe("R3b — the work is never unreachable", () => {
	it("the fold NAMES ctrl+r, and ctrl+r answers with the run's own rows", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		expect(plain(writes.join(""))).toContain("· ctrl+r");
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = plain((r as { lines: string[] }).lines.join("\n"));
		// the NEWEST segment first — the pointer walks back the way every
		// other expand in this product walks
		expect(lines).toContain("expanded · 1 edit · 1 shell");
		expect(lines).toContain("edit  src/f0.ts");
		expect(lines).toContain("shell npm test");
	});

	it("a second press reaches the segment before it", () => {
		const { body, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		body.expandNext();
		const lines = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(lines).toContain("expanded · 3 reads");
		expect(lines).toContain("read 3 files"); // W13's own projection, reused
	});

	it("the expansion is APPENDED, never a rewrite (ADR-0046)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const before = writes.join("");
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		// the committed bytes are untouched — the expansion is new content
		expect(writes.join("")).toBe(before);
	});
});

describe("R3b — the fold's boundaries", () => {
	it("a ONE-CELL segment does not fold — one row into one row is pure loss", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("build");
		call(body, "shell", "s1", { command: "make build" }, "exit 0");
		body.textAppend("Built.\n");
		body.textEnd();
		body.endTurn(3);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("✦ thought");
		expect(frame).toContain("shell make build"); // the row keeps its subject
	});

	it("the fold is emitted ONCE per segment, however many cells it holds", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("many");
		for (let i = 0; i < 9; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(1);
		tick();
		expect((plain(writes.join("")).match(/✦ thought/g) ?? []).length).toBe(1);
	});

	it("a QUIET turn still folds exactly as W14 made it — the segment never closes until the settle", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("quiet");
		body.thinkingAppend("thinking");
		for (let i = 0; i < 5; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
		body.endTurn(19);
		tick();
		const frame = plain(writes.join(""));
		// W14's own number — the CLI's measure, not the segment's clock —
		// and A9's chip, which only a quiet turn carries
		expect(frame).toContain("thought 19s · 5 reads");
		expect(frame).toContain("quiet");
	});

	it("a turn with text does NOT repeat the user's words on the fold — the chip cell already committed", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect((frame.match(/fix the parser/g) ?? []).length).toBe(1);
	});
});

describe("R3b — trouble never folds", () => {
	it("a segment holding a DENIED call keeps every row — a refusal is not routine work", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("try to write");
		call(body, "read_file", "r0", { path: "a.ts" }, "x");
		body.toolStart("write_file", "w1", { path: "out.ts", content: "hi" });
		body.toolResult("w1", { content: "denied", isError: true, reason: "plan mode: read-only" });
		call(body, "read_file", "r1", { path: "b.ts" }, "x");
		body.textAppend("could not write.\n");
		body.textEnd();
		body.endTurn(4);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("✦ thought"); // the segment did NOT fold
		expect(frame).toContain("plan mode: read-only"); // and the reason is ON SCREEN
	});

	it("a segment holding a FAILED call keeps every row too", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("run it");
		call(body, "read_file", "r0", { path: "a.ts" }, "x");
		body.toolStart("shell", "s1", { command: "npm test" });
		body.toolRunning("s1");
		body.toolResult("s1", { content: "exit 1 · 4 failures", isError: true });
		call(body, "read_file", "r1", { path: "b.ts" }, "x");
		body.textAppend("it failed.\n");
		body.textEnd();
		body.endTurn(4);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("✦ thought");
		expect(frame).toContain("exit 1");
	});

	it("the SAME segment without the trouble folds — so the rule is the trouble, not the shape", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("run it");
		call(body, "read_file", "r0", { path: "a.ts" }, "x");
		call(body, "shell", "s1", { command: "npm test" }, "exit 0");
		call(body, "read_file", "r1", { path: "b.ts" }, "x");
		body.textAppend("it passed.\n");
		body.textEnd();
		body.endTurn(4);
		tick();
		expect(plain(writes.join(""))).toContain("✦ thought");
	});
});
