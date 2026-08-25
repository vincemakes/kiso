/**
 * REL-0152-D4 — the custom row is a text field, so typing into it types.
 *
 * From the owner's dogfood of 0.15.3: selecting the type-your-own row
 * should give you a box with a faint placeholder that you can type into
 * straight away; today you have to press enter first. The row said "type
 * your own answer" and then swallowed the first thing you typed — the
 * key went nowhere, and only enter (or `t`) opened the phase. A row that
 * names typing as its purpose must accept a keystroke as the gesture
 * that starts it.
 *
 * On THIS row the digits and `t` are text, not shortcuts: someone
 * answering "3 days" or "typescript" means the characters. Everywhere
 * else in the list they keep their fast-path meaning exactly — that
 * asymmetry is the point, and D3's gates pin the other side of it.
 */

import { describe, expect, it } from "vitest";
import { askBlockRows, askKey, askOnCustomRow, askStart, askView } from "../src/ask-panel.js";
import { Editor } from "../src/editor.js";
import type { AskSpec, PanelVerdict } from "../src/approval-panel.js";

const spec: AskSpec = { questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }] }] };
const view = { ask: spec } as never;

describe("REL-0152-D4 — typing on the custom row opens it and keeps the keystroke", () => {
	it("askOnCustomRow reports the row the keystroke rule keys off", () => {
		const s = askStart(spec);
		expect(askOnCustomRow(spec, s)).toBe(false);
		expect(askOnCustomRow(spec, askKey(spec, askKey(spec, s, "down").state, "down").state)).toBe(true);
	});

	it("the `type` key opens the custom phase from the options phase", () => {
		const on = askKey(spec, askKey(spec, askStart(spec), "down").state, "down").state;
		expect(askKey(spec, on, "type").state.phase).toBe("custom");
	});

	it("`type` inside the custom phase is inert — the phase is already open", () => {
		const typing = askKey(spec, askStart(spec), "t").state;
		expect(askKey(spec, typing, "type").state).toEqual(typing);
	});

	it("the custom phase shows a dim placeholder where the answer will go", () => {
		const typing = askKey(spec, askStart(spec), "t").state;
		const rows = askBlockRows(view, typing, 80, 40).join("\n");
		expect(rows).toContain("type your answer");
		expect(rows).toContain("enter sends");
	});

	it("the placeholder gives way to the answer once there is one", () => {
		const answered = { ...askKey(spec, askStart(spec), "t").state, custom: ["ship it"] };
		const rows = askBlockRows(view, answered, 80, 40).join("\n");
		expect(rows).toContain("ship it");
		expect(rows).not.toContain("type your answer");
	});
});

/**
 * The end-to-end half: real bytes through the real editor. The reducer
 * cases above prove the state machine; these prove the KEY ROUTE, which
 * is where the defect actually lived — the reducer was never reached.
 */
describe("REL-0152-D4 end to end — the keystroke that opens the box is in the box", () => {
	const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
	const ASK: AskSpec = { questions: [{ question: "which way?", options: [{ label: "safe" }, { label: "fast" }] }] };

	const onCustomRow = (): Editor => {
		const editor = new Editor(() => {});
		editor.beginPanel(askView(ASK), () => {});
		editor.feed(enc("\x1b[B\x1b[B")); // down, down — onto the type-your-own row
		return editor;
	};

	it("a letter on the custom row opens the box AND is its first character", () => {
		const editor = onCustomRow();
		editor.feed(enc("h"));
		expect(editor.panelState()!.ask!.phase, "the keystroke did not open the box").toBe("custom");
		editor.feed(enc("ello"));
		expect(editor.line()).toBe("hello");
	});

	it("a DIGIT on the custom row is text, not a pick — the row is a text field", () => {
		const editor = onCustomRow();
		editor.feed(enc("3 days"));
		expect(editor.panelState()!.ask!.phase).toBe("custom");
		expect(editor.line()).toBe("3 days");
	});

	it("`t` on the custom row is text too — the shortcut is not the answer's first letter's enemy", () => {
		const editor = onCustomRow();
		editor.feed(enc("typescript"));
		expect(editor.line()).toBe("typescript");
	});

	it("a digit on an OPTION row still picks — the fast path is untouched elsewhere", () => {
		const seen: unknown[] = [];
		const editor = new Editor(() => {});
		editor.beginPanel(askView(ASK), (v) => seen.push(v));
		editor.feed(enc("2"));
		expect(seen).toHaveLength(1); // answered and committed, no typing phase
	});

	it("the answer commits as typed, keystroke included", () => {
		const seen: PanelVerdict[] = [];
		const editor = new Editor(() => {});
		editor.beginPanel(askView(ASK), (v) => seen.push(v));
		editor.feed(enc("\x1b[B\x1b[B"));
		editor.feed(enc("3 days, then ship"));
		editor.feed(enc("\r"));
		const v = seen[0] as Extract<PanelVerdict, { action: "answers" }>;
		expect("answers" in v.result ? v.result.answers[0] : null).toEqual({ q: "which way?", custom: "3 days, then ship" });
	});
});
