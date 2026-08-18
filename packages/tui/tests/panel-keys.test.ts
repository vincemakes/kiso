/**
 * W21 — the panel's key routing through the editor's feed(): the raw byte
 * contract the PTY delivers.
 *
 * MOVED (the TUI2-R3v2 panel-selection supersession class). The file's
 * premise was "a digit SELECTS and enter COMMITS, and an enter at rest
 * never approves". There is no rest: the bar opens on the first option,
 * so enter always confirms something, and the safeguard moved onto WHERE
 * THE BAR STARTS. The `y`/`n` aliases survive unchanged in spirit — they
 * are the first and last rows — which is why the PTY byte shapes the
 * v2b/v2d gates feed ("y\r", "n\r") still land the verdicts they always
 * did: the letter confirms, and the carriage return that follows lands
 * in an empty composer and does nothing.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import type { PanelVerdict, PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

const view: PanelView = {
	flavor: "approval",
	name: "edit_file",
	title: "work.txt",
	speaker: "mode:default",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["- OLD", "+ NEW"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

describe("W21: the panel keys (the editor's raw-byte routing)", () => {
	it("y commits allow on the keypress — the trailing enter is inert", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("y"));
		expect(verdict).toEqual({ action: "allow", reason: "" });
		expect(editor.panelState()).toBeNull();
		editor.feed(enc("\n")); // the PTY's chaser — nothing left to answer
		expect(verdict).toEqual({ action: "allow", reason: "" });
	});

	it("n opens the note, and a bare enter is still the bare denial", () => {
		// the rejection asymmetry's routing pair, restated: the approval
		// flavor's last option is "let me tell it what to do instead", so `n`
		// opens the composer; sending it EMPTY is the bare No the run aborts
		// on, exactly as "3\r" used to be.
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("n"));
		expect(editor.panelState()?.phase).toBe("amend");
		editor.feed(enc("\n"));
		expect(verdict).toEqual({ action: "deny", reason: "" });
	});

	it("split feed across the chunk boundary — the exact PTY byte shape", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		// the PTY delivers "y\n" possibly split — feed byte by byte
		editor.feed(enc("y"));
		editor.feed(enc("\n"));
		expect(verdict).toEqual({ action: "allow", reason: "" });
	});

	it("esc on the list cancels", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("\x1b"));
		expect(verdict).toEqual({ action: "cancel" });
	});
});
