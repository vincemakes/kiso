/**
 * TUI2-R3v2 slice ① — the selection-list panel model, at the editor's
 * raw-byte routing.
 *
 * The approval moment stops being an input box that happens to accept
 * digits and becomes a LIST with a highlight bar on it. The whole point
 * is the shortest path: look, press enter. So the invariants under test
 * are the ones that make that path real —
 *
 *   - the bar OPENS on the first option, so a bare ⏎ is an approval and
 *     nothing else (the old model's enter-at-rest did nothing at all);
 *   - ↑↓ move the bar and never leave the list;
 *   - a digit CONFIRMS on the keypress — no ⏎ chaser (the old model's
 *     digit only selected, and the R2 pick panel's digit only moved);
 *   - the typed phase exists behind exactly ONE option and is never
 *     reachable by accident;
 *   - esc cancels from anywhere in the list, with no deselect step in
 *     between (there is no "nothing selected" state any more).
 *
 * The panel's own verdicts are unchanged: allow / allow-rule / deny /
 * cancel are the same four channels W21 shipped. This is an INPUT model
 * migration and the assertions it supersedes are enumerated in the green
 * commit body (the panel-selection supersession class).
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { panelOptions } from "../src/approval-panel.js";
import type { PanelVerdict, PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);
const UP = enc("\x1b[A");
const DOWN = enc("\x1b[B");

const view: PanelView = {
	flavor: "approval",
	name: "shell",
	title: "shell rm -rf build",
	speaker: "mode:default",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["rm -rf build && npm run build"] },
	fallbackQuestion: "approve shell? (y/n) ",
};

const simple: PanelView = {
	flavor: "simple",
	name: "trust",
	title: "trust this project?",
	speaker: "kiso",
	statusText: "▸ trust gate",
	args: { kind: "text", lines: ["mcp.json"] },
	fallbackQuestion: "trust? (y/n) ",
};

/** Open a panel and hand back the editor plus the verdict sink. */
function open(v: PanelView = view): { editor: Editor; verdict: () => PanelVerdict | null } {
	const editor = new Editor(() => {});
	let got: PanelVerdict | null = null;
	editor.beginPanel(v, (x) => {
		got = x;
	});
	return { editor, verdict: () => got };
}

describe("TUI2-R3v2 ① — the approval panel is a selection list", () => {
	it("opens with the bar on the FIRST option — a bare enter approves", () => {
		const { editor, verdict } = open();
		expect(editor.panelState()?.cursor).toBe(0);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "allow", reason: "" });
		expect(editor.panelState()).toBeNull();
	});

	it("the four options are the v4 frame's, in order", () => {
		const kinds = panelOptions(view).map((o) => o.kind);
		expect(kinds).toEqual(["allow", "rule", "safer", "deny"]);
		expect(panelOptions(view)[0]!.label).toBe("Yes, run it");
		expect(panelOptions(view)[2]!.label).toBe("Show me safer ways to do this");
		expect(panelOptions(view)[3]!.label).toBe("No — let me tell it what to do instead");
	});

	it("option 2's copy tells the RULE MACHINERY's truth — per tool, no session claim", () => {
		// addDontAskAgainRule writes RULES.has(call.name): the granularity is
		// the TOOL, and the generated extension file outlives the session.
		// Copy that said "this session" would understate a durable grant.
		const label = panelOptions(view)[1]!.label;
		expect(label).toBe("Yes, and don't ask again for shell");
		expect(label).not.toContain("session");
	});

	it("↑↓ move the bar and CLAMP at both ends", () => {
		const { editor } = open();
		editor.feed(UP); // already at the top — stays
		expect(editor.panelState()?.cursor).toBe(0);
		editor.feed(DOWN);
		editor.feed(DOWN);
		expect(editor.panelState()?.cursor).toBe(2);
		editor.feed(DOWN);
		editor.feed(DOWN); // past the last — stays
		expect(editor.panelState()?.cursor).toBe(3);
		editor.feed(UP);
		expect(editor.panelState()?.cursor).toBe(2);
	});

	it("↑↓ + ⏎ on option 2 commits the DURABLE rule for the tool — no typed phase", () => {
		const { editor, verdict } = open();
		editor.feed(DOWN);
		expect(editor.panelState()?.cursor).toBe(1);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "allow-rule", rule: "shell" });
	});

	it("a digit confirms INSTANTLY — no enter chaser", () => {
		const { editor, verdict } = open();
		editor.feed(enc("1"));
		expect(verdict()).toEqual({ action: "allow", reason: "" });

		const two = open();
		two.editor.feed(enc("2"));
		expect(two.verdict()).toEqual({ action: "allow-rule", rule: "shell" });
	});

	it("a digit past the list is INERT — the panel stays open on its cursor", () => {
		const { editor, verdict } = open();
		editor.feed(enc("9"));
		expect(verdict()).toBeNull();
		expect(editor.panelState()?.cursor).toBe(0);
	});

	it("the typed phase opens ONLY behind the last option (4 / the tab alias)", () => {
		const { editor, verdict } = open();
		expect(editor.panelState()?.phase).toBe("options");
		editor.feed(enc("4"));
		expect(verdict()).toBeNull(); // 4 does not deny — it opens the composer
		expect(editor.panelState()?.phase).toBe("amend");
		editor.feed(enc("keep build/, just run npm run build"));
		expect(editor.line()).toBe("keep build/, just run npm run build");
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "deny", reason: "keep build/, just run npm run build" });
	});

	it("tab stays the amend alias — the same typed phase, from anywhere in the list", () => {
		const { editor } = open();
		editor.feed(DOWN);
		editor.feed(enc("\t"));
		expect(editor.panelState()?.phase).toBe("amend");
	});

	it("digits and prose do not fight: the typed phase keeps every character", () => {
		// the R2 slice-⑧ guard, restated for the new model — a phase where a
		// human types prose never eats y/n/1/3 as keys.
		const { editor } = open();
		editor.feed(enc("4"));
		editor.feed(enc("yes, run 13 of them now"));
		expect(editor.line()).toBe("yes, run 13 of them now");
	});

	it("esc cancels straight from the list — no deselect step", () => {
		const { editor, verdict } = open();
		editor.feed(DOWN); // the bar is off the default; esc still cancels
		editor.feed(enc("\x1b"));
		expect(verdict()).toEqual({ action: "cancel" });
	});

	it("esc from the typed phase goes BACK to the list, cursor intact", () => {
		const { editor, verdict } = open();
		editor.feed(enc("4"));
		editor.feed(enc("some words"));
		editor.feed(enc("\x1b"));
		expect(verdict()).toBeNull();
		expect(editor.panelState()?.phase).toBe("options");
		expect(editor.panelState()?.cursor).toBe(3);
		expect(editor.line()).toBe("");
	});

	it("the simple flavor is the SAME list, two rows — 1 yes, 2 no", () => {
		expect(panelOptions(simple).map((o) => o.kind)).toEqual(["allow", "deny"]);
		const { editor, verdict } = open(simple);
		expect(editor.panelState()?.cursor).toBe(0);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "allow", reason: "" });

		const no = open(simple);
		no.editor.feed(enc("2"));
		expect(no.verdict()).toEqual({ action: "deny", reason: "" });
	});

	it("the simple flavor has no amend and no rule — tab is inert", () => {
		const { editor } = open(simple);
		editor.feed(enc("\t"));
		expect(editor.panelState()?.phase).toBe("options");
	});
});
