/**
 * DC-48 — invariant ① is a CRASH under test and a CUT in the field.
 *
 * DECLARED REVERSAL of the wording DC-45 leaned on: *"a component that
 * forgets to fold CRASHES with a diagnostic, never silently truncates —
 * the crash is the contract, not a symptom."* Owner-lane ruling
 * 2026-09-04, after the second instance of that class in two days: DC-45
 * caught by a gate, DC-48 caught by the owner, on the first frame of an
 * ordinary command.
 *
 * In a gate the crash is exactly right and the reversal keeps every
 * tooth of it. In a human's hands it costs them the composer's contents
 * and the whole session, to save them a row one column too wide. So the
 * field cuts the row, says so once, and carries on — and the fact is
 * SAID, which is the half that makes it not a silent truncation.
 *
 * Both halves are gated here, in the same file, because either one alone
 * is a claim without its counterexample.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const H = 24;

/**
 * A REAL path to an over-wide row, not an invented one: a row committed
 * at a wide terminal, then the terminal narrows before the refold. Every
 * component folds against the width it was given, so nothing ordinary
 * reaches the check over-wide — which is exactly why DC-48 needed a
 * renderer defect to happen at all. This is the reachable equivalent,
 * and it is the resize family the owner already reports from.
 */
function makeBody(): { body: Body; writes: string[]; narrow: () => void } {
	let W = 200;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	body.raw(["x".repeat(180)]);
	vi.advanceTimersByTime(30);
	return {
		body,
		writes,
		narrow: () => {
			W = 40;
			body.render();
			vi.advanceTimersByTime(30);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	process.env.KISO_INVARIANTS = "throw";
});

describe("DC-48 — under test, the crash is still the contract", () => {
	it("KISO_INVARIANTS=throw: an over-wide row THROWS, with the width in the message", () => {
		process.env.KISO_INVARIANTS = "throw";
		const { narrow } = makeBody();
		expect(narrow).toThrow(/invariant ① violated: a line of visible width \d+ > 40/);
	});

	it("…and that is what this repository's suites run under", () => {
		// tests/setup-env.ts sets it for every in-process suite, and
		// isolated-cli.mjs sets it for every PTY child. A gate that lost
		// this would accept a cut row for the rest of time.
		expect(process.env.KISO_INVARIANTS).toBe("throw");
	});
});

describe("DC-48 — in the field, the row is cut and the fact is said", () => {
	it("unset: the frame survives, every row fits, and the over-wide row is CUT", () => {
		delete process.env.KISO_INVARIANTS;
		const { writes, narrow } = makeBody();
		expect(narrow).not.toThrow();
		const screen = new Screen(40, H);
		screen.feed(writes.join(""));
		const rows = screen.rows.map((r) => r.join("").replace(/\s+$/, ""));
		for (const row of rows) expect(row.length, JSON.stringify(row)).toBeLessThanOrEqual(40);
		expect(rows.join("\n"), "the cut row lost its content entirely").toContain("xxxxx");
	});

	it("unset: the notice says it happened — ONCE, however many rows are cut", () => {
		delete process.env.KISO_INVARIANTS;
		const { body, writes, narrow } = makeBody();
		narrow();
		body.raw(["y".repeat(180), "z".repeat(180)]);
		vi.advanceTimersByTime(30);
		// the notice is queued as a microtask, so it lands on a later frame
		return Promise.resolve().then(() => {
			body.render();
			vi.advanceTimersByTime(30);
			const said = writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
			const n = (said.match(/a row was cut to width/g) ?? []).length;
			expect(n, "the notice never appeared").toBeGreaterThanOrEqual(1);
			expect(n, "a row-by-row complaint — a resize storm would drown the transcript").toBe(1);
		});
	});
});
