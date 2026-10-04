/**
 * Graphite §8.1–§8.2 (R3a) — one grammar for every list that asks the
 * person to pick: it names itself (the hairline, the name bold gold, its
 * facts dim) and marks its selected row one way (the `askEdge` cell, the
 * row on `washAsk`, a row's `→` drawn as a gold `›`). Off a known ground
 * the reverse-video bar and the dim header stay.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { panelRowsOf } from "../src/ask-panel.js";
import { modelPickView, type PickSpec } from "../src/approval-panel.js";
import { selectionBar, visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";
import { bandHeader } from "@vincemakes/kiso-tui-cells/strings";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const SPEC: PickSpec = {
	header: "model — current: deepseek-flash (openai-compat)",
	options: [
		{ label: "deepseek-flash", note: "profile: ds · current" },
		{ label: "gpt-6-astra", note: "profile: chatgpt" },
	],
};
const APPROVAL = {
	flavor: "approval" as const,
	name: "shell",
	title: "npm test",
	speaker: "mode:default",
	statusText: "❯ run paused",
	args: { kind: "lines" as const, lines: ["npm test"] },
	fallbackQuestion: "approve? ",
};
const approvalRows = (W: number): string[] => panelRowsOf({ view: APPROVAL as never, phase: "options", cursor: 0 }, W, 14);
const modelRows = (W: number): string[] => panelRowsOf({ view: modelPickView(SPEC, "▸ idle"), phase: "options", cursor: 1, pick: { cursor: 1, level: null } }, W, 12);

describe("§8.1 — a list names itself", () => {
	it("the hairline in `line`, the name bold gold, its facts dim", () => {
		setGround("light");
		const p = palette();
		const h = bandHeader("sessions · this workspace 2 of 5 · tab all", 80);
		expect(plain(h)).toMatch(/^─{3} sessions · this workspace 2 of 5 · tab all ─+$/);
		expect(h.startsWith(`${p.line}─── `)).toBe(true);
		expect(h).toContain(`${p.bold}${p.gold}sessions${p.reset}${p.dim} · this workspace 2 of 5 · tab all${p.reset}`);
		expect(visibleWidth(h)).toBe(80);
	});

	it("the approval, the model list: their opening row is the named hairline", () => {
		setGround("light");
		expect(plain(approvalRows(80)[0]!)).toMatch(/^─{3} needs you ─+$/);
		const m = modelRows(80).map(plain);
		// MOVED (Graphite P3 — DECLARED): the words after the name ride the
		// band's own row; the `current:` row under it is gone
		expect(m[0]).toMatch(/^─{3} model · current: deepseek-flash \(openai-compat\) ─+$/);
		expect(m[1]).not.toContain("current:");
	});

	it("off a known ground the header is one dim span, the same words", () => {
		setGround("unknown");
		const p = palette();
		const h = bandHeader("commands", 40);
		expect(h).toBe(`${p.dim}─── commands ${"─".repeat(40 - 13)}${p.reset}`);
	});
});

describe("§8.2 — the selected row", () => {
	it("on a known ground: the askEdge cell, washAsk to the edge, the `→` a gold `›`", () => {
		setGround("light");
		const p = palette();
		const row = selectionBar(`${p.bold}→ 1 Yes${p.reset}`, 7, 40);
		expect(row.startsWith(`${p.askEdge} ${p.washAsk}`)).toBe(true);
		expect(row).toContain(`${p.gold}›${p.fgEnd} 1 Yes`);
		expect(plain(row)).toBe(` › 1 Yes${" ".repeat(40 - 8)}`);
		expect(visibleWidth(row)).toBe(40);
		// a row with no marker keeps its words where they were
		expect(plain(selectionBar("notes.md", 8, 20))).toBe(` notes.md${" ".repeat(11)}`);
	});

	it("the approval and the model list mark their selected row that way, and the column does not move", () => {
		setGround("light");
		const p = palette();
		const a = approvalRows(80);
		const sel = a.findIndex((r) => r.startsWith(p.askEdge));
		expect(plain(a[sel]!).trimEnd()).toBe(" › 1 Yes, run it");
		expect(plain(a[sel + 1]!).trimEnd()).toBe("   2 Yes, and don't ask again for shell");
		const m = modelRows(80);
		// MOVED (P3, the §8.13 shape): the gold `›` sits right before the name,
		// as on the command list, so the name stays in column 2 whether or not
		// its row is selected — the column does not move
		expect(plain(m.find((r) => r.startsWith(p.askEdge))!)).toMatch(/^ ›gpt-6-astra +profile: chatgpt/);
		expect(plain(m.slice(1).find((r) => r.includes("deepseek-flash"))!)).toMatch(/^ {2}deepseek-flash +profile: ds/);
	});

	it("off a known ground: the reverse-video bar, the `→` kept", () => {
		setGround("unknown");
		const p = palette();
		const row = selectionBar(`→ 1 Yes`, 7, 20);
		expect(row.startsWith(`${p.rv} `)).toBe(true);
		expect(plain(row)).toBe(` → 1 Yes${" ".repeat(20 - 9)} `);
	});

	it("invariant ①: every row of both panels fits, W 20..200, on both grounds and the unknown one", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) for (const r of [...approvalRows(W), ...modelRows(W)]) expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
		}
	});
});
