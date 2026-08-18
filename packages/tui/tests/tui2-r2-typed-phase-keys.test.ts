/**
 * TUI2-R2 slice ⑧ — a panel's TYPED phase must receive the letters that
 * are typed into it.
 *
 * The approval panel's shortcut keys — `1`/`y` selects yes, `3`/`n`
 * selects no — are the OPTIONS phase's keys, and they were applied to
 * every phase of every panel flavour. Their guard reads:
 *
 *     if (c === "1" || c === "y" || c === "Y") {
 *         if (panel.phase === "options") this.#panelSelect(1);
 *         i += 1;          // <- consumed either way
 *         continue;
 *     }
 *
 * The `i += 1; continue;` sits OUTSIDE the phase check, so in a phase
 * where the key means nothing it is still swallowed — and a phase where
 * it means nothing is precisely a phase where the human is typing prose.
 * Every `y`, `n`, `1` and `3` disappears from the line, silently, with
 * no error and no visible cause: the text you type is not the text that
 * is committed.
 *
 * Slice ④ hit this on the NEW pick panel — "openai/deepseek-reasoner"
 * arrived as "opeai/deepseek-reasoer" — and guarded pick alone, because
 * fixing the rest is a behaviour change that deserved its own red. This
 * is that red. It covers every typed phase that already existed:
 *
 *   - the ASK panel's custom answer (`t`, then free text);
 *   - the APPROVAL panel's rule input (digit 2 — "don't ask again
 *     for ...");
 *   - the APPROVAL panel's amend/feedback line (tab).
 *
 * The words chosen below are ordinary English that happens to contain
 * the four characters. That is the whole point: nobody typing "yes, run
 * it now" is reaching for a shortcut.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { askView } from "../src/ask-panel.js";
import type { AskSpec, PanelVerdict, PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** Every offending character, inside words a human would really type. */
const TYPED = "yes, run it now 13";

const ASK_SPEC: AskSpec = {
	questions: [
		{
			question: "Which way should I take this?",
			options: [{ label: "the safe way" }, { label: "the fast way" }],
		},
	],
};

const APPROVAL_VIEW: PanelView = {
	flavor: "approval",
	name: "edit_file",
	title: "edit examples/foo.ts",
	speaker: "mode:default",
	hint: "/mode accept-edits auto-approves edits",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["old", "new"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

function open(view: PanelView): { editor: Editor; seen: PanelVerdict[] } {
	const seen: PanelVerdict[] = [];
	const editor = new Editor(() => {});
	editor.beginPanel(view, (v) => seen.push(v));
	return { editor, seen };
}

describe("TUI2-R2 ⑧ — the typed phase receives what is typed", () => {
	it("ASK, custom answer: `t` then prose — the committed answer is the prose, character for character", () => {
		const { editor, seen } = open(askView(ASK_SPEC));
		editor.feed(enc("t"));
		expect(editor.panelState()!.ask!.phase, "the `t` key did not open the type-it line").toBe("custom");
		editor.feed(enc(TYPED));
		// the line as the composer holds it — before any commit
		expect(editor.line(), "the buffer lost characters on the way in").toBe(TYPED);
		editor.feed(enc("\r"));
		expect(seen).toHaveLength(1);
		const v = seen[0]!;
		expect(v.action).toBe("answers");
		const result = (v as Extract<PanelVerdict, { action: "answers" }>).result;
		expect("answers" in result ? result.answers[0] : null).toEqual({ q: ASK_SPEC.questions[0]!.question, custom: TYPED });
	});

	// MOVED (the TUI2-R3v2 panel-selection supersession class): the RULE
	// INPUT is retired. It was a text box for a value the machinery could
	// not vary — the generated extension matches on the tool name — so the
	// characters this case proved survived the trip were characters that
	// could only ever produce a rule that never fired. Option 2 now grants
	// the tool, on the keypress, and the copy says so. What the case was
	// really protecting (a typed phase keeps every character) is asserted
	// below on the one typed phase that remains, and on the ask's.
	it("APPROVAL, the amend note: option 4 then prose — the note commits the text that was typed", () => {
		const { editor, seen } = open(APPROVAL_VIEW);
		editor.feed(enc("4"));
		expect(editor.panelState()!.phase, "option 4 did not open the amend note").toBe("amend");
		editor.feed(enc(TYPED));
		expect(editor.line(), "the note buffer lost characters on the way in").toBe(TYPED);
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "deny", reason: TYPED }]);
	});

	it("APPROVAL, the tab alias: tab then prose — the same phase, the same characters", () => {
		const { editor, seen } = open(APPROVAL_VIEW);
		editor.feed(enc("\t"));
		expect(editor.panelState()!.phase, "tab did not open the amend line").toBe("amend");
		editor.feed(enc(TYPED));
		expect(editor.line(), "the note buffer lost characters on the way in").toBe(TYPED);
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "deny", reason: TYPED }]);
	});

	// MOVED (same class): the digits and the letters no longer SELECT — they
	// confirm. The property the case exists for is the one that matters and
	// it is asserted unchanged: in the options phase these keys are keys,
	// and not one of them reaches the buffer.
	it("the OPTIONS phase: y/1 confirm the first option, and nothing leaks into the buffer", () => {
		for (const key of ["y", "1"] as const) {
			const { editor, seen } = open(APPROVAL_VIEW);
			editor.feed(enc(key));
			expect(seen, `the shortcut ${key} no longer confirms in the options phase`).toEqual([{ action: "allow", reason: "" }]);
			expect(editor.line(), `the shortcut ${key} leaked into the buffer`).toBe("");
		}
		for (const key of ["n", "4"] as const) {
			const { editor } = open(APPROVAL_VIEW);
			editor.feed(enc(key));
			expect(editor.panelState()!.phase, `the shortcut ${key} no longer opens the note`).toBe("amend");
			expect(editor.line(), `the shortcut ${key} leaked into the buffer`).toBe("");
		}
	});

	it("the ASK options phase is UNCHANGED: a printable key is still swallowed, never typed into the composer", () => {
		const { editor } = open(askView(ASK_SPEC));
		editor.feed(enc("y"));
		expect(editor.line(), "a stray key leaked into the buffer while the ask owned the keys").toBe("");
		expect(editor.panelState()!.ask!.phase).toBe("options");
	});
});
