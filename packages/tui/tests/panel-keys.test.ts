/**
 * W21 — the panel's key routing through the editor's feed(): the raw byte
 * contract the PTY delivers. "y"/"1" select option 1, enter commits the
 * selected option (allow at 1, deny at 3 — an enter at rest never
 * approves), a feed split across the chunk boundary still commits (the
 * PTY delivers "y\n" possibly split), and a bare esc at rest cancels.
 * The end-to-end panel flow is pinned by the v2b/v2d PTY gates; this
 * gate pins the routing unit itself.
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
	it("y + enter commits allow", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("y"));
		expect(editor.panelState()?.sel).toBe(1);
		editor.feed(enc("\n"));
		expect(verdict).toEqual({ action: "allow", reason: "" });
		expect(editor.panelState()).toBeNull();
	});

	it("3 commits deny — the rejection asymmetry's routing pair", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("3"));
		expect(editor.panelState()?.sel).toBe(3);
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

	it("esc at rest cancels", () => {
		const editor = new Editor(() => {});
		let verdict: PanelVerdict | null = null;
		editor.beginPanel(view, (v) => {
			verdict = v;
		});
		editor.feed(enc("\x1b"));
		expect(verdict).toEqual({ action: "cancel" });
	});
});
