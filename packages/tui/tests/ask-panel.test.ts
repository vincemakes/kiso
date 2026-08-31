/**
 * KC3.5 T-Q1 — the ask panel, unit.
 *
 * Two halves, because the ask has two halves: a PURE reducer (a key and
 * a state give the next state, and the result when the walk ends) and
 * the editor's raw-byte routing over it — the same feed() contract the
 * PTY delivers. The frames are asserted through the rows.
 *
 * The W21 contract the ask inherits by riding the same slot is pinned
 * here too: the buffer stashes on open and returns on close (answer AND
 * decline), and the panel owns the keys — the slash menu, the history
 * walk and the @ picker never open under it.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { askAnswers, askBlockRows, askCommitCustom, askDeclineAll, askKey, askLeadPlain, askStart, askView, type AskResult, type AskRuntime, type AskSpec } from "../src/ask-panel.js";
import type { PanelVerdict } from "../src/approval-panel.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (rows: string[]): string => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

const ONE: AskSpec = {
	questions: [
		{
			question: "which bundler?",
			header: "bundler",
			options: [
				{ label: "vite", description: "fast dev server" },
				{ label: "esbuild", description: "one binary" },
				{ label: "rollup" },
			],
		},
	],
};

const TWO: AskSpec = {
	questions: [
		ONE.questions[0]!,
		{
			question: "which test runners?",
			header: "runners",
			multiSelect: true,
			options: [{ label: "vitest" }, { label: "node:test" }, { label: "playwright" }],
		},
	],
};

/** Walk a sequence of keys through the reducer. */
function walk(spec: AskSpec, keys: string[], from: AskRuntime = askStart(spec)): { state: AskRuntime; result?: AskResult } {
	let state = from;
	let result: AskResult | undefined;
	for (const k of keys) {
		const step = askKey(spec, state, k);
		state = step.state;
		if (step.result !== undefined) result = step.result;
	}
	return result === undefined ? { state } : { state, result };
}

describe("T-Q1 — the reducer: digits, space, the walk", () => {
	it("a single-select digit answers AND advances — one question, one gesture", () => {
		expect(walk(ONE, ["1"]).result).toEqual({ answers: [{ q: "which bundler?", choice: "vite" }] });
		expect(walk(ONE, ["2"]).result).toEqual({ answers: [{ q: "which bundler?", choice: "esbuild" }] });
	});

	it("a digit past the option count does nothing — the panel never invents an option", () => {
		const step = askKey(ONE, askStart(ONE), "4"); // three options only
		expect(step.result).toBeUndefined();
		expect(step.state).toEqual(askStart(ONE));
	});

	it("multi-select: digits TOGGLE and stay; enter submits the set", () => {
		const picked = walk(TWO, ["1", "1", "3"]); // q1: vite → q2 opens
		expect(picked.result).toBeUndefined();
		expect(picked.state.qIndex).toBe(1);
		expect(picked.state.picks[1]).toEqual([0, 2]); // vitest + playwright
		const submitted = walk(TWO, ["enter"], picked.state);
		expect(submitted.result).toEqual({
			answers: [
				{ q: "which bundler?", choice: "vite" },
				{ q: "which test runners?", choices: ["vitest", "playwright"] },
			],
		});
	});

	it("multi-select: a repeat digit UNTOGGLES — the set is the human's, both directions", () => {
		const state = walk(TWO, ["1", "1", "3", "1"]).state;
		expect(state.picks[1]).toEqual([2]);
	});

	it("space SELECTS at the cursor and never commits — a stray space must not answer anything", () => {
		// single-select: the pick lands, the walk does not move; enter commits
		const single = walk(ONE, ["down", "space"]);
		expect(single.result).toBeUndefined();
		expect(single.state.picks[0]).toEqual([1]);
		expect(walk(ONE, ["enter"], single.state).result).toEqual({ answers: [{ q: "which bundler?", choice: "esbuild" }] });
		// multi-select: the same gesture, toggling
		const multi = walk(TWO, ["1", "down", "space"]);
		expect(multi.result).toBeUndefined();
		expect(multi.state.picks[1]).toEqual([1]);
	});

	it("enter on an EMPTY question is a no-op — no answer is invented, none is skipped", () => {
		const step = askKey(TWO, { ...askStart(TWO), qIndex: 1 }, "enter");
		expect(step.result).toBeUndefined();
		expect(step.state.qIndex).toBe(1);
	});

	it("the ‹ n/m › walk: ← goes back and the earlier pick is still there; ← at question one stays put", () => {
		const at2 = walk(TWO, ["1"]).state;
		expect(at2.qIndex).toBe(1);
		const back = askKey(TWO, at2, "left").state;
		expect(back.qIndex).toBe(0);
		expect(back.picks[0]).toEqual([0]); // vite, still chosen
		expect(askKey(TWO, back, "left").state.qIndex).toBe(0); // the floor
		// ...and re-answering question one walks forward again
		expect(askKey(TWO, back, "2").state.qIndex).toBe(1);
	});

	it("`t` opens the type-your-own line; the text becomes THE answer and clears the picks", () => {
		const typing = walk(ONE, ["1" /* picked */, "t"], askStart(ONE));
		expect(typing.state.phase).toBe("custom");
		const done = askCommitCustom(ONE, typing.state, "  parcel, actually  ");
		expect(done.result).toEqual({ answers: [{ q: "which bundler?", custom: "parcel, actually" }] });
	});

	it("an EMPTY typed line records nothing — it backs out to the options", () => {
		const typing = askKey(ONE, askStart(ONE), "t").state;
		const done = askCommitCustom(ONE, typing, "   ");
		expect(done.result).toBeUndefined();
		expect(done.state.phase).toBe("options");
		expect(done.state.custom[0]).toBeNull();
	});

	it("esc declines the WHOLE call, listing every question with its options", () => {
		const declined = walk(TWO, ["1", "esc"]).result;
		expect(declined).toEqual({
			declined: ["which bundler? (vite, esbuild, rollup)", "which test runners? (vitest, node:test, playwright)"],
		});
		// the same list from question one — the round declines the CALL,
		// never half of it (the walked-back stop clause).
		expect(walk(TWO, ["esc"]).result).toEqual(declined);
		expect(askDeclineAll(TWO)).toEqual(declined);
	});

	it("a partially-walked multi answers with what was actually picked — never a fabricated one", () => {
		const state = walk(TWO, ["1", "2"]).state; // q2: node:test toggled on
		expect(askAnswers(TWO, state)[1]).toEqual({ q: "which test runners?", choices: ["node:test"] });
	});
});

describe("T-Q1 — the rows: the frames the human reads", () => {
	it("the question, the header, the numbered options and their descriptions", () => {
		const rows = plain(askBlockRows(askView(ONE), askStart(ONE), 80, 20));
		expect(rows).toContain("which bundler?");
		expect(rows).toContain("bundler");
		expect(rows).toContain(" 1 ");
		expect(rows).toContain("vite");
		// DECLARED SUPERSESSION (R2, design §7.5): the description used to
		// run on after an em dash. It sits in a right column now, so the
		// labels — the thing being chosen between — all start and END at a
		// column the LIST decided rather than the previous row's length.
		expect(rows).toMatch(/ 1   vite {2,}fast dev server/);
		expect(rows).toMatch(/ 2   esbuild {2,}one binary/);
		expect(rows).toContain("t   type your own answer");
		// DECLARED SUPERSESSION (R6/D2): the row names the FINISHER and the
		// REAL option count. It said `1-4 pick · t type · esc decline` in
		// both modes, never mentioning enter — on the one panel shape
		// where enter is the only way to finish — and hardcoding 1-4
		// whatever the count was (REL-0152-D3's defect, one function down
		// from where that finding fixed it). The owner could not find the
		// finisher because the screen did not name it.
		expect(rows).toContain("⏎ confirms");
		expect(rows).toContain("esc declines");
		// ...and the range is this question's OWN count. ONE has three
		// options plus the type-your-own row, so a hardcoded "1-4" was
		// wrong here in the most literal way available.
		expect(rows).toContain("1-3 instant");
	});

	it("the ‹ n/m › counter appears only when there is more than one question, and ← joins the keys", () => {
		expect(plain(askBlockRows(askView(ONE), askStart(ONE), 80, 20))).not.toContain("‹");
		const two = askView(TWO);
		expect(plain(askBlockRows(two, askStart(TWO), 80, 20))).toContain("‹ 1/2 ›");
		const at2 = walk(TWO, ["1"]).state;
		const rows = plain(askBlockRows(two, at2, 80, 20));
		expect(rows).toContain("‹ 2/2 ›");
		expect(rows).toContain("← back");
	});

	it("multi-select marks the chosen options, names its mode, and names what SENDS", () => {
		const state = walk(TWO, ["1", "1"]).state;
		const rows = plain(askBlockRows(askView(TWO), state, 80, 20));
		// R6/D2: the header names the MODE; the keys live on the keys row,
		// once — and the key that was missing from it is the one that
		// finishes a multi-select.
		expect(rows).toContain("pick any");
		expect(rows).toContain("⏎ sends the set");
		expect(rows).toContain("◉ vitest");
		expect(rows).toContain("◯ node:test");
	});

	it("the typed answer shows on its own row once committed", () => {
		const typed = askCommitCustom(TWO, askKey(TWO, askStart(TWO), "t").state, "webpack").state;
		expect(plain(askBlockRows(askView(TWO), { ...typed, qIndex: 0 }, 80, 20))).toContain("t ◉ webpack");
	});

	it("the block is BOUNDED: a small maxRows drops rows with the honest notice", () => {
		const rows = askBlockRows(askView(ONE), askStart(ONE), 80, 8);
		expect(rows.length).toBeLessThanOrEqual(8);
		expect(plain(rows)).toContain("more rows — the full question is in the event log");
	});
});

describe("T-Q1 — the editor: the raw bytes, the precedence, the stash", () => {
	const open = (spec: AskSpec): { editor: Editor; got: () => PanelVerdict | null } => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(askView(spec), (v) => {
			verdict = v;
		});
		return { editor, got: () => verdict };
	};

	it("a digit byte answers a single-select question and closes with the answers", () => {
		const { editor, got } = open(ONE);
		expect(editor.panelState()?.ask?.qIndex).toBe(0);
		editor.feed(enc("1"));
		expect(got()).toEqual({ action: "answers", result: { answers: [{ q: "which bundler?", choice: "vite" }] } });
		expect(editor.panelState()).toBeNull();
	});

	it("the two-question walk over real bytes: digit, space toggles, enter submits", () => {
		const { editor, got } = open(TWO);
		editor.feed(enc("1"));
		expect(editor.panelState()?.ask?.qIndex).toBe(1);
		editor.feed(enc(" ")); // toggles the cursor option (vitest)
		expect(got()).toBeNull();
		editor.feed(enc("\r")); // the PTY's Enter
		expect(got()).toEqual({
			action: "answers",
			result: {
				answers: [
					{ q: "which bundler?", choice: "vite" },
					{ q: "which test runners?", choices: ["vitest"] },
				],
			},
		});
	});

	it("← walks back over the CSI bytes; ↑↓ move the option cursor", () => {
		const { editor } = open(TWO);
		editor.feed(enc("1"));
		editor.feed(enc("\x1b[D")); // ←
		expect(editor.panelState()?.ask?.qIndex).toBe(0);
		editor.feed(enc("\x1b[B")); // ↓
		expect(editor.panelState()?.ask?.cursor).toBe(1);
		editor.feed(enc("\x1b[A")); // ↑
		expect(editor.panelState()?.ask?.cursor).toBe(0);
	});

	it("`t` opens the typing line, the text is ordinary editing, enter answers with it", () => {
		const { editor, got } = open(ONE);
		editor.feed(enc("t"));
		expect(editor.panelState()?.ask?.phase).toBe("custom");
		editor.feed(enc("parcel"));
		expect(editor.line()).toBe("parcel");
		editor.feed(enc("\r"));
		expect(got()).toEqual({ action: "answers", result: { answers: [{ q: "which bundler?", custom: "parcel" }] } });
	});

	it("esc while typing backs out to the options and clears the line — the text never leaks", () => {
		const { editor, got } = open(ONE);
		editor.feed(enc("t"));
		editor.feed(enc("half a thought"));
		editor.feed(enc("\x1b"));
		expect(editor.panelState()?.ask?.phase).toBe("options");
		expect(editor.line()).toBe("");
		expect(got()).toBeNull(); // esc out of TYPING is not a decline
	});

	it("esc at rest declines the call — with the list of what was skipped", () => {
		const { editor, got } = open(TWO);
		editor.feed(enc("\x1b"));
		expect(got()).toEqual({ action: "answers", result: askDeclineAll(TWO) });
	});

	it("THE W21 CONTRACT: the pre-ask buffer stashes and returns — on an answer and on a decline", () => {
		for (const [keys, what] of [
			[["1"], "answered"],
			[["\x1b"], "declined"],
		] as const) {
			const editor = new Editor(() => {});
			editor.feed(enc("half-written turn"));
			editor.beginPanel(askView(ONE), () => {});
			expect(editor.line(), `${what}: the buffer is the panel's while up`).toBe("");
			for (const k of keys) editor.feed(enc(k));
			expect(editor.line(), `${what}: the buffer came back`).toBe("half-written turn");
		}
	});

	it("PRECEDENCE: the menu, the history walk and the @ picker never open under the ask", () => {
		const editor = new Editor(() => {});
		editor.beginPanel(askView(ONE), () => {});
		editor.feed(enc("/")); // the slash menu's opener
		expect(editor.menuState()).toBeNull();
		editor.feed(enc("@")); // the file picker's opener
		expect(editor.atState()).toBeNull();
		editor.feed(enc("\x1b[A")); // ↑ — the history walk
		expect(editor.line()).toBe("");
		expect(editor.panelState()?.ask?.qIndex).toBe(0); // still the ask's
	});
});

/**
 * REL-0152-D3 — the custom-answer row is rendered INSIDE the option list
 * and was not reachable by the cursor.
 *
 * `askBlockRows` pushes "t type your own answer" into the same `body`
 * array as the option rows, so it reads as the list's last item. But
 * `down` clamped at `q.options.length - 1`, the cursor never landed on
 * it, and the affordance line said "1-4>" — a range that excludes it.
 * The only way in was the bare `t` key, which nothing on screen said was
 * required.
 *
 * Found in owner dogfood on 0.15.2: the down key could not reach t.
 *
 * The row is a row now: the cursor reaches it, enter opens the typing
 * phase there, `t` still works from anywhere, and the prompt names the
 * real range instead of a hard-coded one.
 */
describe("REL-0152-D3: the type-your-own row is part of the list", () => {
	const custom = (q: AskSpec) => q.questions[0]!.options.length; // its index

	it("down reaches the custom row — one past the last option", () => {
		let s = askStart(ONE);
		for (let i = 0; i < 10; i += 1) s = askKey(ONE, s, "down").state;
		expect(s.cursor).toBe(custom(ONE));
	});

	it("enter on the custom row opens the typing phase", () => {
		let s = askStart(ONE);
		for (let i = 0; i < 10; i += 1) s = askKey(ONE, s, "down").state;
		expect(askKey(ONE, s, "enter").state.phase).toBe("custom");
	});

	it("up walks back off the custom row into the options", () => {
		let s = askStart(ONE);
		for (let i = 0; i < 10; i += 1) s = askKey(ONE, s, "down").state;
		expect(askKey(ONE, s, "up").state.cursor).toBe(custom(ONE) - 1);
	});

	it("the bare `t` key still works from anywhere", () => {
		expect(askKey(ONE, askStart(ONE), "t").state.phase).toBe("custom");
	});

	it("enter on a real option still answers rather than typing", () => {
		const s = askKey(ONE, askStart(ONE), "space").state; // pick at cursor 0
		expect(askKey(ONE, s, "enter").state.phase).not.toBe("custom");
	});

	it("the affordance names the real range, not a hard-coded 1-4", () => {
		const line = askLeadPlain(askStart(ONE));
		expect(line).not.toBe("1-4> ");
		expect(line).toMatch(/pick|1-\d/);
	});
});

describe("REL-0152-D3: the custom row shows the cursor like every other row", () => {
	// palette() is gated on process.stdout.isTTY, so the codes are empty
	// strings in a plain test run — the affordance under test would be
	// invisible and the assertion would pass on an unchanged row.
	const withColor = <T,>(fn: () => T): T => {
		const orig = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			return fn();
		} finally {
			Object.defineProperty(process.stdout, "isTTY", { value: orig ?? false, configurable: true });
		}
	};

	it("is dim when the cursor is elsewhere and bold when it is there", () => {
		const view = askView(ONE);
		let cur = askStart(ONE);
		for (let i = 0; i < 10; i += 1) cur = askKey(ONE, cur, "down").state;
		const away = withColor(() => askBlockRows(view, askStart(ONE), 80, 20).join("\n"));
		const on = withColor(() => askBlockRows(view, cur, 80, 20).join("\n"));
		expect(away).not.toBe(on);
		// the row itself moved, not some other part of the block
		const rowOf = (blob: string) => blob.split("\n").find((l) => l.includes("type your own answer"));
		expect(rowOf(away)).not.toBe(rowOf(on));
	});
});
