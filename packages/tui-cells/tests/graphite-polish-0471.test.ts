/**
 * 0.47.1 — the polish round (owner, 2026-10-07): the agent's dogfood of
 * 0.47.0 found four cosmetic rough edges (findings 0470-F1 to F4). This
 * file holds the cards' half; the meta-row half is in kiso-tui.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { setGround } from "../src/render.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
/** A painted card row's content after the edge cell and column 1. */
const inner = (r: string): string => plain(r).slice(2).trimEnd();
const tool = (over: Partial<Extract<BodyCell, { kind: "tool" }>> & { command?: string } = {}): Extract<BodyCell, { kind: "tool" }> => {
	const command = over.command ?? "npm test";
	return {
		kind: "tool",
		state: "done",
		isError: false,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 1_000,
		done: true,
		reason: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
		childRoles: [],
		name: "shell",
		input: JSON.stringify({ command }).slice(0, 60),
		inputFull: JSON.stringify({ command }),
		resultText: "",
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
};
const running = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}) => tool({ state: "running", doneAt: null, done: false, startedAt: 9_000, ...over });
const render = (c: BodyCell, W = 80): string[] => cellComponent(c).render(W, CTX);

describe("0470-F1: a cut note counts output lines, the unit it names", () => {
	// the dogfood's screen at 80 columns: one line of output, six rows
	const ONE = "started background task t1. Output: " + "/a-long-path".repeat(30) + " (read it with read_file).";

	it("one line longer than the window: the note says what is hidden — the start of that line", () => {
		setGround("light");
		const rows = render(tool({ resultText: ONE })).map(inner);
		expect(rows[2]).toMatch(/^… the start of this line +ctrl\+o expands$/);
		expect(rows.join("\n")).not.toContain("1 earlier line");
	});

	it("whole lines above a line cut in its middle: both are said", () => {
		setGround("light");
		const text = ["one", "two", "three", ONE].join("\n");
		const rows = render(tool({ resultText: text })).map(inner);
		expect(rows[2]).toMatch(/^… 3 earlier lines and the start of this one +ctrl\+o expands$/);
	});

	it("wrapped lines hidden whole are counted once each, not per row", () => {
		setGround("light");
		const wide = "w".repeat(150); // two rows at 80 columns
		const text = [wide, wide, wide, "a", "b", "c", "d", "e"].join("\n");
		const rows = render(tool({ resultText: text })).map(inner);
		expect(rows[2]).toMatch(/^… 3 earlier lines +ctrl\+o expands$/);
		expect(rows.slice(3, 8)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("lines that do not wrap read exactly as before", () => {
		setGround("light");
		const text = Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n");
		expect(render(tool({ resultText: text })).map(inner)[2]).toMatch(/^… 85 earlier lines +ctrl\+o expands$/);
	});

	it("a head preview counts the lines below it, and says when the last shown line goes on", () => {
		setGround("light");
		const wide = "w".repeat(400); // six rows at 80 columns
		const rows = render(tool({ name: "search_text", input: JSON.stringify({ pattern: "w" }), inputFull: JSON.stringify({ pattern: "w" }), resultText: [wide, "x", "y"].join("\n") })).map(inner);
		const note = rows.find((r) => r.startsWith("…"))!;
		expect(note).toMatch(/^… 2 more lines and the rest of this one +ctrl\+o expands$/);
	});

	it("narrower, the part's clause gives way first: the count keeps its word beside the key", () => {
		setGround("light");
		// 30 lines that wrap to two rows each at 60 columns: the tail opens on
		// line 27's second row
		const text = Array.from({ length: 30 }, (_, i) => `shell line ${String(i).padStart(2, "0")} ` + "x".repeat(52)).join("\n");
		expect(render(tool({ resultText: text }), 120).map(inner)[2]).toMatch(/^… 25 earlier lines +ctrl\+o expands$/); // nothing wraps
		expect(render(tool({ resultText: text }), 60).map(inner)[2]).toMatch(/^… 27 earlier lines +ctrl\+o expands$/);
	});

	it("a running shell's window counts the same way, and the settle moves nothing", () => {
		setGround("light");
		const live = render(running({ resultText: ONE })).map(inner);
		expect(live[2]).toBe("… the start of this line");
		const settled = render(tool({ resultText: ONE })).map(inner);
		expect(live.slice(3)).toEqual(settled.slice(3));
	});
});

describe("0470-F4: a refusal is said once", () => {
	const refused = (over: Partial<Extract<BodyCell, { kind: "tool" }>>) =>
		tool({ name: "write_file", input: JSON.stringify({ path: "hello.txt" }), inputFull: JSON.stringify({ path: "hello.txt", content: "hi" }), isError: true, ...over });

	it("the person refused and gave no words: `denied by you`, and no body repeating it", () => {
		setGround("light");
		// the runtime's own reason when the person gives none, and the result
		// the model was handed — the dogfood's card said both
		const rows = render(refused({ reason: "denied by user", resultText: "[Permission denied] denied by user", verdict: { decision: "denied" } })).map(plain);
		const all = rows.join("\n");
		expect(all).toMatch(/denied by you/);
		expect(all).not.toContain("denied by user");
		expect(all).not.toContain("[Permission denied]");
	});

	it("the person's own words stay the head's reason, and the body still carries them", () => {
		setGround("light");
		const all = render(refused({ reason: "not now", resultText: "[Permission denied] not now", verdict: { decision: "denied" } })).map(plain).join("\n");
		expect(all).toContain("denied by you · not now");
		expect(all).toContain("[Permission denied] not now");
	});

	it("a policy's refusal reads as before: its reason on the head, the result in the body", () => {
		setGround("light");
		const all = render(refused({ reason: "dontAsk: shell needs a human's approval", resultText: "[Permission denied] dontAsk: shell needs a human's approval", verdict: { decision: "denied", decidedBy: "mode:default" } })).map(plain).join("\n");
		expect(all).toContain("denied · dontAsk: shell needs a human's approval");
		expect(all).toContain("[Permission denied]");
	});

	it("on a narrow row the head gives its reason way — the body is why a reason is never lost", () => {
		setGround("light");
		const reason = "destructive command — refused by safe-test";
		const rows = render(refused({ reason, resultText: `[Permission denied] ${reason}`, verdict: { decision: "denied", decidedBy: "safe-test" } }), 40).map(plain);
		expect(rows.join("\n").replace(/\s+/g, " ")).toContain("refused by safe-test");
	});

	it("a result that says more than the refusal is still the body", () => {
		setGround("light");
		const all = render(refused({ reason: "not now", resultText: "[Permission denied] not now\nthe hook said: wait for the review", verdict: { decision: "denied" } })).map(plain).join("\n");
		expect(all).toContain("the hook said: wait for the review");
	});
});
