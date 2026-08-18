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

	it("APPROVAL, rule input: digit 2 then prose — the rule commits the text that was typed", () => {
		const { editor, seen } = open(APPROVAL_VIEW);
		editor.feed(enc("2"));
		expect(editor.panelState()!.phase, "digit 2 did not open the rule input").toBe("rule");
		// the phase prefills the tool name; clear it and type a real rule
		editor.feed(enc("\x15")); // ctrl+u — kill to start
		editor.feed(enc(TYPED));
		expect(editor.line(), "the rule buffer lost characters on the way in").toBe(TYPED);
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "allow-rule", rule: TYPED }]);
	});

	it("APPROVAL, amend/feedback: tab then prose — the feedback rides the verdict intact", () => {
		const { editor, seen } = open(APPROVAL_VIEW);
		editor.feed(enc("\t"));
		expect(editor.panelState()!.phase, "tab did not open the amend line").toBe("amend");
		editor.feed(enc(TYPED));
		expect(editor.line(), "the feedback buffer lost characters on the way in").toBe(TYPED);
		editor.feed(enc("\r"));
		expect(seen).toEqual([{ action: "allow", reason: TYPED }]);
	});

	it("the OPTIONS phase is UNCHANGED: y/1 still select yes, n/3 still select no", () => {
		for (const [key, sel] of [["y", 1], ["1", 1], ["n", 3], ["3", 3]] as const) {
			const { editor } = open(APPROVAL_VIEW);
			editor.feed(enc(key));
			expect(editor.panelState()!.sel, `the shortcut ${key} no longer selects in the options phase`).toBe(sel);
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
