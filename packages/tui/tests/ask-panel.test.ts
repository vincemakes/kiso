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
import {
	askAnswers,
	askBlockRows,
	askCommitCustom,
	askDeclineAll,
	askKey,
	askStart,
	askView,
	type AskResult,
	type AskRuntime,
	type AskSpec,
} from "../src/ask-panel.js";
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

	it("space toggles at the cursor (multi) and answers at it (single)", () => {
		expect(walk(ONE, ["down", "space"]).result).toEqual({ answers: [{ q: "which bundler?", choice: "esbuild" }] });
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
		expect(rows).toContain("— fast dev server");
		expect(rows).toContain("t   type your own answer");
		expect(rows).toContain("1-4 pick · t type · esc decline");
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

	it("multi-select marks the chosen options and says space toggles", () => {
		const state = walk(TWO, ["1", "1"]).state;
		const rows = plain(askBlockRows(askView(TWO), state, 80, 20));
		expect(rows).toContain("pick any — space toggles");
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
