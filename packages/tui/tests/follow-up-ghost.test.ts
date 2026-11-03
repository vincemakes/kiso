/**
 * The follow-up in the terminal (owner 2026-11-03: "the composer's grey placeholder; Tab makes it real text"): a line
 * set with setGhost is drawn dim in the EMPTY box with the cursor at its start; Tab takes it into the buffer as real
 * text; a typed character hides it (the box is no longer empty) and it is never part of the line; null clears it.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { palette } from "../src/lines.js";

const enc = (s: string): Buffer => Buffer.from(s, "utf8");
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("the follow-up ghost", () => {
	it("is drawn dim in the empty box, the cursor at its start", () => {
		const editor = new Editor(() => {});
		editor.setGhost("make it a - b €");
		const st = editor.dockState();
		expect(plain(st.lines[0]!)).toBe("make it a - b €");
		expect(st.lines[0], "dim, by the palette the dock draws with").toBe(`${palette().dim}make it a - b €${palette().reset}`);
		expect(st.cursorCol).toBe(0);
		expect(editor.line()).toBe("");
	});

	it("Tab takes it into the buffer as real text", () => {
		const editor = new Editor(() => {});
		editor.setGhost("fix it");
		editor.feed(enc("\t"));
		expect(editor.line()).toBe("fix it");
		expect(plain(editor.dockState().lines[0]!)).toBe("fix it");
	});

	it("typing hides it and it is never part of the line; null clears it", () => {
		const editor = new Editor(() => {});
		editor.setGhost("fix it");
		editor.feed(enc("x"));
		expect(editor.line()).toBe("x");
		expect(plain(editor.dockState().lines.join(""))).not.toContain("fix it");
		editor.feed(enc("\x7f"));
		expect(plain(editor.dockState().lines[0]!), "emptied again, the line stands again").toBe("fix it");
		editor.setGhost(null);
		expect(plain(editor.dockState().lines[0] ?? "")).toBe("");
		editor.feed(enc("\t"));
		expect(editor.line(), "Tab with no ghost puts nothing in").not.toBe("fix it");
	});
});
