/**
 * R3h — a term that counts OBJECTS counts distinct objects.
 *
 * Found by an independent review (fable, 2026-08-29) hours after R3g
 * shipped: `turn.reads` incremented per CALL, so a turn that read one
 * file twice folded as `read 2 files`. Law 1.3 does not become optional
 * because the falsehood is small, and the fold line is the one row a
 * human is meant to trust when the rows are gone.
 *
 * The rule and its boundary: a term whose noun is a THING (files,
 * directories) counts distinct things; a term whose noun is an ACT
 * (searches, shell commands) counts calls, because two searches for the
 * same pattern really are two searches.
 *
 * The same defect stood in `exploreCounts`, whose head said "6 files"
 * over an expansion — `exploreRows`, the very next function — showing
 * four, one of them `a.ts ×3`. The head and the body are two views of
 * ONE run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "\n");
function makeBody(W = 100) {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 40, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(20) };
}
const call = (body: Body, name: string, id: string, input: Record<string, unknown>): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: "x", isError: false });
};
const foldLine = (writes: string[]): string =>
	plain(writes.join(""))
		.split("\n")
		.find((l) => l.includes("thought")) ?? "(no fold line)";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R3h — objects are counted once", () => {
	it("reading ONE file twice is one file", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "same.ts" });
		call(body, "read_file", "b", { path: "same.ts" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("read 1 file");
		expect(foldLine(writes)).not.toContain("read 2 files");
	});

	it("reading TWO files is two files — the rule narrows, it does not disable", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "one.ts" });
		call(body, "read_file", "b", { path: "two.ts" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("read 2 files");
	});

	it("editing one file twice is one file", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "r", { path: "a.ts" });
		call(body, "edit_file", "a", { path: "same.ts" });
		call(body, "edit_file", "b", { path: "same.ts" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("edited 1 file");
	});

	it("listing one directory twice is one directory", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "list_dir", "a", { path: "src" });
		call(body, "list_dir", "b", { path: "src" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("listed 1 directory");
	});

	it("ACTS still count calls — two searches for one pattern are two searches", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "search_text", "a", { pattern: "foo", path: "src" });
		call(body, "search_text", "b", { pattern: "foo", path: "src" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("ran 2 searches");
	});

	it("...and so do two runs of the same shell command", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "shell", "a", { command: "npm test" });
		call(body, "shell", "b", { command: "npm test" });
		body.endTurn(3);
		tick();
		expect(foldLine(writes)).toContain("ran 2 shell commands");
	});

	it("the exploration row's head agrees with the list it opens", () => {
		// three explore calls make a run; a.ts read twice is ONE file in
		// the head, exactly as `exploreRows` shows it as `a.ts ×2`.
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("x");
		call(body, "read_file", "a", { path: "a.ts" });
		call(body, "read_file", "b", { path: "a.ts" });
		call(body, "list_dir", "c", { path: "src" });
		call(body, "search_text", "d", { pattern: "q", path: "src" });
		body.textAppend("done.");
		body.endTurn(0);
		tick();
		const frame = plain(writes.join(""));
		if (frame.includes("explored")) expect(frame).toContain("explored 1 file");
	});
});
