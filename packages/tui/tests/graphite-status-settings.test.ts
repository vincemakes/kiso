/**
 * Graphite R3e — `/status` as a sheet over the input and `/settings` as a
 * panel (owner, 2026-09-29): the sheet is read and then typed past (only
 * esc is eaten); the settings panel names the axis each of its rows walks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor.js";
import { cellComponent, infoSheetRows, visibleWidth } from "../src/components.js";
import { Body } from "../src/compositor.js";
import { panelRowsOf } from "../src/ask-panel.js";
import { pickAffordance, settingsPickView, type PickSpec } from "../src/approval-panel.js";
import { palette, setGround } from "../src/lines.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");

let editor: Editor;
beforeEach(() => {
	vi.useFakeTimers();
	editor = new Editor(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	setGround("unknown");
});

const FACTS = [
	{ label: "session", value: "2026-09-29T09-00-00-ab12 · retry work · 42 events" },
	{ label: "model", value: "deepseek-flash (api.deepseek.com) · profile ds" },
	{ label: "context", value: "~12% used · window 1M (stated by the registry)" },
	{ label: "version", value: "0.44.0" },
];

describe("R3e — the /status sheet", () => {
	it("names itself, a fact per row (label dim in its column), and says how it closes", () => {
		setGround("light");
		const p = palette();
		const rows = infoSheetRows("status", FACTS, 80);
		expect(plain(rows[0]!)).toMatch(/^─{3} status ─+$/);
		expect(plain(rows[1]!)).toBe("  session  2026-09-29T09-00-00-ab12 · retry work · 42 events");
		expect(rows[1]).toContain(`${p.dim}session  ${p.reset}`);
		expect(plain(rows.at(-1)!)).toBe("  esc closes · typing goes to the input");
	});

	it("a long value folds by word under its own column; invariant ① W 20..200", () => {
		const long = [{ label: "context", value: "~12% used · window 1M (stated by the registry for this endpoint) · compaction past 50% at a phase end" }];
		const narrow = infoSheetRows("status", long, 40).map(plain);
		expect(narrow[2]!.startsWith(" ".repeat(11))).toBe(true);
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) for (const r of infoSheetRows("status", [...FACTS, ...long], W)) expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("the editor: the sheet opens with the caller's rows; a key closes it AND is typed; esc closes it and is eaten", () => {
		const rows = (W: number): string[] => infoSheetRows("status", FACTS, W);
		editor.openSheet(rows);
		expect(editor.sheetOpen()).toBe(true);
		expect(editor.sheetContent()).toBe(rows);
		editor.feed(enc("go"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("go");
		editor.feed(enc("\x15"));
		editor.openSheet(rows);
		editor.feed(enc("\x1b"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("");
	});

	it("the keys sheet is unchanged: any key closes it and is eaten", () => {
		editor.feed(enc("?"));
		expect(editor.sheetContent()).toBe(true);
		editor.feed(enc("x"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("");
	});
});

describe("R3e — the /settings panel", () => {
	const SPEC: PickSpec = {
		header: "settings — the session's own change here; the rest say how",
		options: [
			{ label: "mode", note: "default", levels: ["default", "accept-edits", "plan", "dontAsk", "bypass"], level: 0, axisLabel: "mode" },
			{ label: "thinking", note: "default", levels: ["shown", "hidden"], level: 0, axisLabel: "thinking" },
			{ label: "model", note: "deepseek-flash · ⏎ switches" },
			{ label: "floor", note: "on — irrecoverable deletes are refused in every mode · default" },
		],
	};
	const rows = (cursor: number, level: number | null, W = 100): string[] =>
		panelRowsOf({ view: settingsPickView(SPEC, "▸ default"), phase: "options", cursor, pick: { cursor, phase: "options", level } }, W, 14).map(plain);

	it("opens on its named hairline; a session row walks its own axis, named on the strip and the key row", () => {
		setGround("light");
		const on = rows(0, 2);
		expect(on[0]).toMatch(/^─{3} settings ─/);
		expect(on.some((r) => r.trim() === "mode: default · accept-edits · [plan] · dontAsk · bypass")).toBe(true);
		expect(on.some((r) => r.includes("←→ mode"))).toBe(true);
		const think = rows(1, 1);
		expect(think.some((r) => r.trim() === "thinking: shown · [hidden]")).toBe(true);
		expect(think.some((r) => r.includes("←→ thinking"))).toBe(true);
	});

	it("a config row has no axis: its value and source, and no ←→ on the key row", () => {
		setGround("light");
		const f = rows(3, null);
		expect(f.some((r) => r.includes("floor") && r.includes("on — irrecoverable deletes are refused"))).toBe(true);
		expect(f.some((r) => r.includes("←→"))).toBe(false);
	});

	it("the model's effort keeps its name where no label is given", () => {
		expect(pickAffordance({ cursor: 0, phase: "options", level: 0 }, true)).toContain("←→ effort");
		expect(pickAffordance({ cursor: 0, phase: "options", level: 0 }, "mode")).toContain("←→ mode");
	});
});

describe("R3e — the MODE row (owner, 2026-09-29, option A)", () => {
	const row = (from: string, to: string, W = 100): string[] =>
		cellComponent({ kind: "notice", text: `mode → ${to}`, done: true, label: "MODE", sentence: `${from} → ${to}`, mark: { text: to, tone: to === "bypass" ? "fail" : to === "plan" ? "blue" : "ink" }, stacked: true } as never).render(W, { spinnerI: 0, now: 0, height: 24 });

	it("MODE on a row of its own, then from → to at the content edge — no explanation — the new tier bold, bypass red, plan blue", () => {
		setGround("light");
		const p = palette();
		expect(row("default", "bypass").map(plain)).toEqual(["  MODE", "  default → bypass"]);
		expect(row("default", "bypass")[1]).toContain(`${p.bold}${p.red}bypass${p.reset}`);
		expect(row("bypass", "plan")[1]).toContain(`${p.bold}${p.blue}plan${p.reset}`);
		// the word after the arrow carries it, not an earlier one
		expect(row("plan", "plan")[1]).toContain(`plan → ${p.reset}${p.bold}${p.blue}plan`);
		expect(row("dontAsk", "accept-edits").map(plain)).toEqual(["  MODE", "  dontAsk → accept-edits"]);
	});

	it("invariant ①: the row fits, W 20..200, on both grounds and the unknown one", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) for (const r of row("accept-edits", "dontAsk", W)) expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("a pipe keeps the confirmation it always printed, byte for byte", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (x) => writes.push(x) });
		body.modeNotice("mode → bypass", "default", "bypass");
		expect(writes.join("")).toBe("mode → bypass\n");
	});
});
