/**
 * R13 — ONE SURFACE, at the compositor: what survives the retirements,
 * and what replaces them.
 *
 * The owner's ruling of 2026-09-03 retired four mechanisms at once — the
 * segment fold (R3b–R3i, W14), the W13 rollup and its `rolled` field,
 * TUI2-R1 (B)'s exploration row, and R4's standing activity slot with
 * R3i's stretch line. Each of those had a file of gates, and most of
 * those gates went with the mechanism. THESE DID NOT: their subjects are
 * properties of the transcript, not of the collapse, and they are
 * re-homed here so a retirement does not quietly take a live gate with
 * it (the DC-25/DC-29 lesson — a file is retired case by case, never
 * wholesale).
 *
 * Retired from, with the case each came from named:
 *
 *   r3b-segment-fold      "a LATER call never removes an earlier row"
 *   tui2-r1-rollup        "/LAST still reaches the full outputs"
 *   r3i-live-projection   "the running call keeps its row and its output"
 *   r3i-live-projection   "a turn that has only thought shows the THOUGHT"
 *   r3i-live-projection   "the model's prose is untouched by the projection"
 *
 * Then the round's own claims about commit behaviour, which is the half
 * of R13 that is the compositor's rather than the cell renderer's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const screen = (): string[] => {
		const sc = new Screen(W, H);
		sc.feed(writes.join(""));
		return sc.rows.map((r) => r.join("").replace(/\s+$/, "")).filter((l) => l !== "" && !l.startsWith("─") && !l.includes("/ commands"));
	};
	return { body, writes, screen, tick: () => vi.advanceTimersByTime(16) };
}

const call = (body: Body, name: string, id: string, input: Record<string, unknown>, out: string): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: out, isError: false });
};

describe("R13 — the transcript only grows, and nothing collapses into it", () => {
	it("a LATER call never removes an earlier row — the layout only grows", () => {
		// from r3b-segment-fold. Its subject was that no text boundary
		// takes a row back; the fold is what could have, and the fold is
		// gone, so the property is now true by construction and this is a
		// REGRESSION gate. It says so rather than claiming a new proof.
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("look");
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		body.textAppend("one.\n");
		body.textEnd();
		tick();
		expect(plain(writes.join(""))).not.toContain("✦ thought");
		call(body, "read_file", "r2", { path: "b.ts" }, "x");
		body.textAppend("two.\n");
		body.textEnd();
		tick();
		const after = plain(writes.join(""));
		expect(after).not.toContain("✦ thought");
		expect(after).toContain("read  a.ts");
		expect(after).toContain("read  b.ts");
	});

	it("EVERY settled call stands as its own card — three reads are three cards", () => {
		// the reversal itself, at the compositor. Three read-only calls in
		// a row are exactly what W13's rollup, TUI2-R1 (B)'s exploration
		// row and the segment fold each collapsed; all three are retired
		// and the screen carries all three calls.
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("explore");
		call(body, "read_file", "a", { path: "one.ts" }, "alpha");
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "gamma");
		call(body, "list_dir", "c", { path: "src" }, "delta");
		body.textAppend("done.");
		body.endTurn(0);
		tick();
		const rows = screen().map(plain).join("\n");
		expect(rows).toContain("one.ts");
		expect(rows).toContain("src");
		expect(rows, "an exploration row survived the retirement").not.toContain("explored");
		expect(rows, "a fold line survived the retirement").not.toContain("✦ thought");
		expect(rows, "a rollup row survived the retirement").not.toMatch(/read {2}3 files/);
	});

	it("nothing is HELD: a done call commits without waiting for its stretch to close", () => {
		// DECLARED REVERSAL of W14's quiet-turn hold, R3b/R3i's segment
		// hold and TUI2-R1.5 ①'s explore-run hold. They existed because a
		// fold might yet stand for the cell; with no fold, a call's
		// committed form is settled the instant the call is. Asserted
		// through the SCREEN mid-turn — the turn has not ended.
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("look");
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		tick();
		expect(screen().map(plain).join("\n"), "the finished call is not on the screen mid-turn").toContain("read  a.ts");
	});

	it("/last still reaches the full outputs — nothing on screen hides content", () => {
		// from tui2-r1-rollup, where the subject was that the rollup hid
		// ROWS and never content. The preview cap is what hides rows now,
		// and the same must hold of it.
		const { body, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("explore");
		call(body, "read_file", "a", { path: "one.ts" }, "alpha\nbeta");
		call(body, "list_dir", "c", { path: "src" }, "the whole listing\nsecond row");
		body.textAppend("done.");
		body.endTurn(0);
		tick();
		const last = body.lastTool();
		expect(last).not.toBeNull();
		expect(last!.name).toBe("list_dir");
		expect(last!.result.content).toBe("the whole listing\nsecond row");
		expect(last!.input).toEqual({ path: "src" });
	});
});

describe("R13 — the live region still shows the work in flight", () => {
	it("the running call keeps its row AND its output", () => {
		// from r3i-live-projection P3. Under R3i the running call's rows
		// were the act slot's; under R13 they are its own card's. The
		// property is the same one and it is the one DC-46 is about.
		const { body, screen, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("run it");
		body.toolStart("shell", "s", { command: "npm run check" });
		body.toolRunning("s");
		body.toolProgress("s", "vitest run\n114 passed\n");
		tick();
		const rows = screen().map(plain).join("\n");
		expect(rows).toContain("npm run check");
		expect(rows).toContain("114 passed");
	});

	it("a turn that has only THOUGHT shows the thought, not a line about it", () => {
		// from r3i-live-projection P2.
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("think about it");
		body.thinkingAppend("weighing the two shapes");
		tick();
		const rows = screen().map(plain).join("\n");
		expect(rows).toContain("weighing the two shapes");
		expect(rows).not.toContain("thought 0s");
	});

	it("an ANSWERED question reaches the screen with the human's own words", () => {
		// from r3i-commit-semantics ④, whose subject was that law 1.7's
		// words survive the fold. The fold is gone, so what this now gates
		// is the WIRING: the ask's own block (r3i-asked-block owns its
		// content) reaches the screen through the compositor intact.
		const { body, screen, tick } = makeBody();
		const ANSWERS = JSON.stringify({ answers: [{ q: "deploy target", choice: "staging" }, { q: "retry policy", custom: "give up after 3" }] });
		body.enter();
		body.userLine("set up the release");
		call(body, "read_file", "a", { path: "a.ts" }, "x");
		body.toolStart("ask_user", "q", { questions: [] });
		body.toolRunning("q");
		body.toolResult("q", { content: ANSWERS, isError: false });
		body.textAppend("Staging it is.\n");
		body.textEnd();
		body.endTurn(0);
		tick();
		const r = screen().map(plain).join("\n");
		expect(r).toContain("asked 2 questions (answered");
		expect(r).toContain("deploy target → staging");
		expect(r).toContain("retry policy → give up after 3 (typed)");
	});

	it("the model's prose is untouched by the projection", () => {
		// from r3i-live-projection P5.
		const { body, screen, tick } = makeBody();
		body.enter();
		body.userLine("explain");
		body.textAppend("The lockfile is missing the linux optional dep.\n");
		body.textEnd();
		tick();
		expect(screen().map(plain).join("\n")).toContain("The lockfile is missing the linux optional dep.");
	});
});

/**
 * DC-46 — the live region is bounded by the SCREEN, never by how much
 * has already been committed.
 *
 * The first fix for DC-46 capped the live region at
 * `H − chrome − #committedLines`, on the argument that a live region
 * inside the leftover room keeps `skip` a function of `#committedLines`
 * alone and therefore monotone. The argument was right about `skip` and
 * wrong about the quantity: **`#committedLines` is CUMULATIVE** — it is
 * re-derived over the whole line cache every frame and counts rows that
 * left for the terminal's scrollback long ago. So one screenful into any
 * session it exceeds `H`, the room clamps to its floor of one row, and
 * every running call from then on is a head row with its output gone.
 *
 * Measured at both 24 and 40 rows on a screen with eight blank rows
 * still on it. That is not "a short terminal with a lot of committed
 * work" — it is every session that runs longer than one screen, and it
 * breaks E2 and R7a D outright.
 *
 * The window's top is held by the `skip` clamp instead (`max(
 * #scrolledOff, fresh)`): rows that have reached the terminal's
 * scrollback are immutable, so the paint may not go back above them.
 * A live region that grows scrolls committed rows away through
 * `#emitScroll`, which is an APPEND and not an un-scroll.
 */
describe("DC-46 — a running call keeps its output however much has committed", () => {
	const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

	for (const H of [24, 40]) {
		it(`H=${H}: after a turn that commits more than a screenful, the live tail is still on screen`, () => {
			const { body, screen, tick } = makeBody({ W: 100, H });
			body.enter();
			body.userLine("look at the project");
			call(body, "list_dir", "l1", { path: "." }, lines(30, (i) => `src/m${i}.ts`));
			call(body, "search_text", "g1", { pattern: "TODO" }, lines(20, (i) => `src/x${i}.ts:${i}: // TODO`));
			body.textAppend("that is the directory.\n");
			body.textEnd();
			body.endTurn(1);
			tick();

			body.userLine("run the tests");
			body.toolStart("shell", "s1", { command: "npm test" });
			body.toolRunning("s1");
			let acc = "";
			for (let i = 1; i <= 12; i += 1) {
				acc += `> vitest run · file ${i}\n`;
				body.toolProgress("s1", acc);
			}
			tick();
			const rows = screen().map(plain);
			expect(rows.join("\n"), "the running call lost its row entirely").toContain("npm test");
			expect(rows.join("\n"), "the running call's live output is gone").toContain("vitest run · file 12");
		});
	}
});
