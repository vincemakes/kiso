/**
 * Graphite, the tasks round (owner, 2026-10-06) — the cells and the Body:
 *
 *   - a background delegation's card names its children (the roles on the
 *     head, `N in the background`, a row per child with its task id);
 *   - a notice that names a thing is ONE row, its outcome word marked in
 *     the success colour or gold (`metaNotice`), while a pipe keeps the
 *     notice's own text;
 *   - the frames before the bar is bound offer no key ladder.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cellComponent, visibleWidth, type BodyCell, type FrameCtx } from "../src/components.js";
import { Body, type InputState } from "../src/compositor.js";
import { palette, setGround } from "../src/lines.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	vi.useRealTimers();
});

const RESULT = "started 2 background children: t1 explorer (session c-1), t2 reviewer (session c-2). They read the workspace as it is while they run. You will be told when all of them have ended; task_stop stops one.";
const delegate = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): BodyCell =>
	({
		kind: "tool",
		name: "delegate",
		input: "",
		inputFull: JSON.stringify({ tasks: [{ role: "explorer", task: "map the auth flow" }, { role: "reviewer", task: "review the plan\nand say what is missing" }], background: true }),
		childRoles: [],
		state: "done",
		isError: false,
		resultText: RESULT,
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 100,
		done: true,
		expanded: false,
		turn: 0,
		reason: null,
		verdict: null,
		...over,
	}) as BodyCell;

describe("the background delegate card", () => {
	it("the roles on the head, `2 in the background`, a row per child with its task id", () => {
		setGround("light");
		const rows = cellComponent(delegate()).render(100, CTX).map((r) => plain(r).slice(2).trimEnd());
		expect(rows[1]).toMatch(/^DELEGATE explorer · reviewer +2 in the background · 0\.1s$/);
		expect(rows.slice(2, 4)).toEqual(["t1  explorer  map the auth flow", "t2  reviewer  review the plan"]);
		expect(rows).toHaveLength(5); // pad · head · two children · pad
	});

	it("the role in ink2, the task dim; off a known ground, the rows under the head opened by `└`", () => {
		setGround("light");
		const p = palette();
		expect(cellComponent(delegate()).render(100, CTX)[2]).toContain(`${p.ink2}explorer`);
		setGround("unknown");
		const flat = cellComponent(delegate()).render(100, CTX).map(plain);
		expect(flat[0]).toMatch(/^ {2}DELEGATE explorer · reviewer +2 in the background · 0\.1s$/);
		expect(flat[1]).toBe("  └ t1  explorer  map the auth flow");
	});

	it("a foreground delegation, or a refusal, is not this card", () => {
		setGround("light");
		const fg = plain(cellComponent(delegate({ resultText: "summary: both reported\nexplorer: …" })).render(100, CTX)[1]!);
		expect(fg).not.toContain("in the background");
		expect(plain(cellComponent(delegate({ isError: true, resultText: "delegate: background is not available here" })).render(100, CTX).join("\n"))).not.toContain("in the background");
	});

	it("every row fits, W 20..160, three grounds", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) for (const r of cellComponent(delegate()).render(W, CTX)) expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
		}
	});
});

describe("a notice that names a thing is one row", () => {
	const notice = (sentence: string, mark?: { text: string; tone: "ok" | "gold" | "fail" }): BodyCell => ({ kind: "notice", text: "✦ task t1 exited", done: true, label: "TASK", sentence, ...(mark !== undefined ? { mark } : {}), oneRow: true }) as BodyCell;

	it("cut with an ellipsis, never folded; the outcome word in the success colour or gold", () => {
		setGround("light");
		const p = palette();
		const long = `t1 exited 0 · ${"x".repeat(200)}`;
		const rows = cellComponent(notice(long, { text: "exited 0", tone: "ok" })).render(80, CTX);
		expect(rows).toHaveLength(1);
		expect(plain(rows[0]!)).toMatch(/^ {2}TASK {8}t1 exited 0 · x+…$/);
		expect(rows[0]).toContain(`${p.green}exited 0`);
		expect(cellComponent(notice("t1 ◌ outcome unknown", { text: "◌ outcome unknown", tone: "gold" })).render(80, CTX)[0]).toContain(`${p.gold}◌ outcome unknown`);
		// the rows of one notice stay together: one cell, no blank between
		const two = cellComponent({ ...notice("t1 answered \u00b7 explorer: map", { text: "answered", tone: "ok" }), also: [{ label: "", sentence: "t2 answered \u00b7 reviewer: plan", mark: { text: "answered", tone: "ok" } }] } as BodyCell).render(80, CTX).map(plain);
		expect(two).toEqual(["  TASK        t1 answered \u00b7 explorer: map", "              t2 answered \u00b7 reviewer: plan"]);
	});
});

describe("the Body", () => {
	const provider = (): InputState => ({ line: "", cursor: 0 });
	const run = (active: boolean, script: (b: Body) => void): string => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const body = new Body({ active: () => active, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
		body.bindInput(provider, "");
		if (active) body.enter();
		script(body);
		vi.advanceTimersByTime(100);
		return writes.join("");
	};

	it("metaNotice: a row per thing on the terminal; the notice's own text on a pipe", () => {
		const rows = [
			{ label: "TASK", sentence: "t1 answered · explorer: map the auth flow", mark: { text: "answered", tone: "ok" as const } },
			{ label: "", sentence: "t2 answered · reviewer: review the plan", mark: { text: "answered", tone: "ok" as const } },
		];
		const dock = plain(run(true, (b) => b.metaNotice("✦ task t1 exited · t2 exited", rows)));
		expect(dock).toContain("TASK        t1 answered · explorer: map the auth flow");
		expect(dock).toContain("            t2 answered · reviewer: review the plan");
		expect(dock).not.toContain("✦ task");
		expect(run(false, (b) => b.metaNotice("✦ task t1 exited · t2 exited", rows))).toBe("✦ task t1 exited · t2 exited\n");
	});

	it("before a bar is bound, the CLI's quiet status leaves the row with no key ladder", () => {
		// the CLI's boot (index.ts): an empty status AND an empty hint, set
		// before the dock enters, so the very first frame carries no ladder
		vi.useFakeTimers();
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
		body.bindInput(provider, "");
		body.setStatus("", "");
		body.enter();
		body.setStatus("", "");
		vi.advanceTimersByTime(100);
		const out = plain(writes.join(""));
		expect(out, "a frame was drawn").toContain("\u2500".repeat(20));
		expect(out).not.toContain("/ commands");
		expect(out).not.toContain("ctrl+r transcript");
	});
});
