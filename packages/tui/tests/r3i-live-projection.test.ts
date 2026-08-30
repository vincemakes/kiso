/**
 * R3i phase 2 — THE LIVE PROJECTION.
 *
 * Written before the code, per the charter. This phase changes NOTHING
 * about what commits or when — it changes only how the open stretch is
 * DRAWN while it runs. The commit-semantics phase comes after an owner
 * ruling, and P4 below is the gate that keeps this phase honest about
 * that.
 *
 * The defect: today every completed call of an open turn holds a live
 * row of its own, so a 28-call turn spends 28 rows of a 30-row live
 * region — which is why overflow is the NORM on real turns, and why
 * the fold (which a spilled turn may not have) misses the turns that
 * need it most. Measured in the 0.16.7 dogfood: 23 tool rows + 17
 * thinking rows, zero fold lines.
 *
 * The projection: the open stretch is ONE line plus a bounded act
 * window. Completed cells render nothing — their counts ride the line.
 * The block's height stops depending on the call count, which is what
 * dissolves the overflow, and the line is the one the settle will keep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 90;
	const H = opts.H ?? 40;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const screen = (): string[] => {
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		return s.rows.map((r) => r.join("").replace(/\s+$/, ""));
	};
	/** the body rows — the live content, without the chrome */
	const body_ = (): string[] => screen().filter((l) => l !== "" && !l.startsWith("─") && !l.includes("/ commands") && !l.includes("working"));
	return { body, writes, screen, body_, tick: () => vi.advanceTimersByTime(30) };
}
const done = (b: Body, name: string, id: string, input: Record<string, unknown>): void => {
	b.toolStart(name, id, input);
	b.toolRunning(id);
	b.toolResult(id, { content: "x", isError: false });
};
const running = (b: Body, name: string, id: string, input: Record<string, unknown>): void => {
	b.toolStart(name, id, input);
	b.toolRunning(id);
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R3i P1 — the block's height stops depending on the call count", () => {
	it("three completed calls and twenty-three completed calls occupy the SAME live height", () => {
		const heights: number[] = [];
		for (const n of [3, 23]) {
			const { body, body_, tick } = makeBody({ H: 40 });
			body.enter();
			body.userLine("x");
			body.thinkingAppend("planning");
			for (let i = 0; i < n; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
			running(body, "shell", "s", { command: "npm run check" });
			tick();
			heights.push(body_().length);
		}
		expect(heights[0]).toBe(heights[1]);
	});

	it("...and that height is small — the wall of rows is gone", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		for (let i = 0; i < 23; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		running(body, "shell", "s", { command: "npm run check" });
		tick();
		// the user chip, the stretch line, and the act window
		expect(body_().length).toBeLessThanOrEqual(8);
	});

	it("the counts of the completed calls ride the LINE", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 6; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		running(body, "shell", "s", { command: "npm run check" });
		tick();
		const rows = body_().join("\n");
		// DECLARED SUPERSESSION (R4 — the tense is PER TERM): the six reads
		// are DONE and the shell is running, so the line says exactly
		// that, term by term, instead of putting the whole line in the
		// present and claiming six reads were still in flight.
		expect(rows).toContain("read 6 files · running 1 shell command");
		// ...and their own rows are gone
		expect(rows).not.toContain("f0.ts");
		expect(rows).not.toContain("f5.ts");
	});
});

describe("R3i P2 — the live line is present tense and carries no key", () => {
	it("a running stretch never wears the settled form", () => {
		const { body, body_, tick } = makeBody();
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		vi.advanceTimersByTime(4000);
		for (let i = 0; i < 2; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		running(body, "shell", "s", { command: "npm run check" });
		tick();
		const rows = body_().join("\n");
		const line = body_().find((l) => l.includes("reading 2 files")) ?? "";
		expect(line).not.toContain("thought"); // the past tense is the settle's
		expect(line).not.toContain("ctrl+r"); // and so is the key
		// (the call in flight keeps its OWN affordance — that row is not
		// the stretch line, and its work is reachable while it runs)
		expect(rows).toContain("npm run check");
	});

	it("a stretch that has only thought says so", () => {
		const { body, body_, tick } = makeBody();
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		vi.advanceTimersByTime(4000);
		tick();
		expect(body_().join("\n")).toContain("thinking 4s");
	});
});

describe("R3i P3 — the work in flight is still visible", () => {
	it("the running call keeps its row and its output", () => {
		const { body, body_, tick } = makeBody();
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 4; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		body.toolStart("shell", "s", { command: "npm run check" });
		body.toolRunning("s");
		body.toolProgress("s", "vitest run --project unit\n114 passed\n");
		tick();
		const rows = body_().join("\n");
		expect(rows).toContain("npm run check"); // what it is doing
		expect(rows).toContain("114 passed"); // and what it is saying
	});

	it("parallel running calls are capped, and the overflow is COUNTED", () => {
		const { body, body_, tick } = makeBody();
		body.enter();
		body.userLine("x");
		for (const id of ["a", "b", "c", "d", "e"]) running(body, "shell", id, { command: `npm run check -w ${id}` });
		tick();
		const rows = body_().join("\n");
		expect(rows).toContain("more running");
	});
});

describe("R3i P4 — this phase does not move a single commit", () => {
	it("nothing of an open turn commits, exactly as before", () => {
		const { body, writes, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		for (let i = 0; i < 6; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		tick();
		// The fold line is a COMMIT-TIME artifact — `#foldOrRollup` runs
		// only as a cell leaves the live region — so its absence is the
		// honest observable for "nothing of this turn has become ink".
		expect(body.liveCount()).toBeGreaterThan(0);
		expect(plain(writes.join(""))).not.toMatch(/✦[^\n]*ctrl\+r/);
	});

	it("the settle still produces the turn's fold, unchanged by this phase", () => {
		const { body, screen, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		vi.advanceTimersByTime(9000);
		for (let i = 0; i < 6; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		body.endTurn(9);
		tick();
		// R4a: the settled fold no longer prints a key — its WORDS are the
		// evidence it committed.
		expect(screen().join("\n")).toContain("thought 9s · read 6 files");
	});
});

describe("R3i P5 — cells that are not the stretch's render as themselves", () => {
	it("the model's prose is untouched by the projection", () => {
		const { body, body_, tick } = makeBody();
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) done(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		body.textAppend("Here is what I found.\n");
		tick();
		expect(body_().join("\n")).toContain("Here is what I found.");
	});
});
