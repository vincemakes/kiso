/**
 * Graphite P3 — the pick panels (/model, /mode, /settings) take the shape of
 * every list band (owner, 2026-10-04: all four recommendations taken — the
 * band shape for the three, /model filters, §8.2's window, and the profile
 * name on the selected row's opened line).
 *
 * The band names itself with its count or its current value; the rows are a
 * table measured over the whole list; the selected row opens into a second
 * row (the level strip, why a profile cannot run, how a setting changes);
 * one key row with the counter closes it, and no rule under it — the
 * composer's rail closes the band. On a dock the Graphite bar stays under
 * the panel, and the input row is the composer's (a filter is typed there).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor } from "../src/editor.js";
import { panelRowsOf } from "../src/ask-panel.js";
import { modelPickView, modePickView, pickList, pickWindowOf, settingsPickView, type PanelVerdict, type PickOption, type PickSpec } from "../src/approval-panel.js";
import { visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";
import type { BarInput } from "../src/status.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const BARE_ESC = /\x1b(?![[\]])/;

const PROFILES: readonly PickOption[] = [
	{ label: "deepseek-v4-flash", cols: ["api.deepseek.com", "current"], opened: "profile ds · openai-compat · DS_KEY", match: ["ds"], levels: ["none", "low", "high", "max"], level: 2 },
	{ label: "gpt-5.6-sol", cols: ["chatgpt.com", "sign in"], opened: "not signed in: run kiso login chatgpt", off: true, match: ["sol"] },
	{ label: "claude-opus-5", cols: ["anthropic", ""], opened: "profile opus · anthropic · OPUS_KEY", match: ["opus"], levels: ["low", "medium", "high", "xhigh", "max"], level: 2 },
	{ label: "z-ai/glm-5.3-flash", cols: ["api.gateway-aaaa.ai", ""], opened: "profile co/glm · openai-compat · GW_A_KEY", match: ["co/glm"] },
	{ label: "xai/grok-4.7", cols: ["api.gateway-aaaa.ai", ""], opened: "profile co/grok · openai-compat · GW_A_KEY", match: ["co/grok"] },
	{ label: "xiaomi/mimo-v2.6-flash", cols: ["api.gateway-aaaa.ai", ""], opened: "profile co/mimo · openai-compat · GW_A_KEY", match: ["co/mimo"] },
	{ label: "deepseek-v4.1-flash", cols: ["gateway-bbbb.ai", "no key"], opened: "no credential: set the env var GW_B_KEY", off: true, match: ["op/ds"] },
	{ label: "glm-5.3-flash", cols: ["gateway-bbbb.ai", "no key"], opened: "no credential: set the env var GW_B_KEY", off: true, match: ["op/glm"] },
	{ label: "grok-4.7", cols: ["gateway-bbbb.ai", "no key"], opened: "no credential: set the env var GW_B_KEY", off: true, match: ["op/grok"] },
];
const MODEL: PickSpec = { header: "model", noun: "profiles", input: "filter", direct: true, enter: "⏎ switches", filterHint: "filter, or type provider/model", options: PROFILES };
const MODE: PickSpec = {
	header: "mode",
	facts: "current: default",
	enter: "⏎ switches",
	options: [
		{ label: "default", note: "read-only runs; the rest asks — a saved allow still allows" },
		{ label: "accept edits", note: "read-only, edits run; rest asks — a saved allow still allows" },
		{ label: "plan", note: "reads run; all else is denied — read-only, and a deny wins" },
		{ label: "full access", note: "runs without asking — a user deny and the floor still win" },
	],
};
const SETTINGS: PickSpec = {
	header: "settings",
	noun: "",
	input: "arrows",
	columns: ["plain", "dim"],
	levelColumn: 0,
	options: [
		{ label: "model", cols: ["deepseek-v4-flash", "user config"], opened: "api.deepseek.com · profile ds", enter: "⏎ opens /model" },
		{ label: "mode", cols: ["default", "default"], levels: ["default", "accept edits", "plan", "full access"], level: 0, axisLabel: "mode", enter: "⏎ applies" },
		{ label: "don't ask", cols: ["off", "default"], levels: ["off", "on"], level: 0, axisLabel: "don't ask", enter: "⏎ applies" },
		{ label: "floor", cols: ["on", "default"], opened: 'irrecoverable deletes are refused in every mode · change: "floor": "off" in ~/.kiso/config.json (user config only)', enter: "⏎ prints how" },
	],
};

const rowsOf = (spec: PickSpec, cursor: number, opts: { level?: number | null; query?: string; W?: number; height?: number } = {}): string[] =>
	panelRowsOf(
		{ view: modelPickView(spec, "▸ idle"), phase: "options", cursor: 0, pick: { cursor, level: opts.level === undefined ? (spec.options[cursor]?.level ?? null) : opts.level, ...(opts.query === undefined ? {} : { query: opts.query }) } },
		opts.W ?? 80,
		40,
		opts.height ?? 24,
	);

beforeEach(() => {
	delete process.env.NO_COLOR;
	process.env.COLORTERM = "truecolor";
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	setGround("light");
});
afterEach(() => {
	setGround("unknown");
	delete process.env.COLORTERM;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("P3 — the band: its name, its table, its key row", () => {
	it("the name carries the count, the matches under a filter, and the caller's facts", () => {
		expect(plain(rowsOf(MODEL, 0)[0]!)).toMatch(/^─{3} model · 9 profiles ─+$/);
		expect(plain(rowsOf(MODEL, 0, { query: "glm" })[0]!)).toMatch(/^─{3} model · 2 of 9 match ─+$/);
		expect(plain(rowsOf({ ...MODEL, facts: "run paused" }, 0)[0]!)).toMatch(/^─{3} model · 9 profiles · run paused ─+$/);
		expect(plain(rowsOf(MODE, 0)[0]!)).toMatch(/^─{3} mode · current: default ─+$/);
		expect(plain(rowsOf(SETTINGS, 0)[0]!)).toMatch(/^─{3} settings · 4 ─+$/);
	});

	it("the columns are measured over the WHOLE list: a filter and the cursor never move them", () => {
		const hostAt = (rows: string[], host: string): number => {
			const r = rows.map(plain).find((x) => x.includes(host) && !x.startsWith("───"))!;
			return visibleWidth(r.slice(0, r.indexOf(host)));
		};
		const all = rowsOf(MODEL, 3);
		const filtered = rowsOf(MODEL, 3, { query: "glm" });
		// the widest label in the list is `xiaomi/mimo-v2.6-flash` (22): the host column starts at 2 + 22 + 2
		expect(hostAt(all, "api.gateway-aaaa.ai")).toBe(26);
		expect(hostAt(filtered, "api.gateway-aaaa.ai")).toBe(26);
		expect(hostAt(rowsOf(MODEL, 0), "chatgpt.com")).toBe(26);
	});

	it("the selected row keeps the gold › right before its label; the label column does not move", () => {
		const p = palette();
		const rows = rowsOf(MODEL, 2);
		const sel = rows.find((r) => r.startsWith(p.askEdge))!;
		expect(sel).toContain(`${p.gold}›${p.fgEnd}`);
		expect(plain(sel)).toMatch(/^ ›claude-opus-5 +anthropic/);
		expect(plain(rows.find((r) => plain(r).includes("gpt-5.6-sol"))!)).toMatch(/^ {2}gpt-5\.6-sol/);
	});

	it("one key row closes the band — the keys this row has, the counter at the margin — and no rule under it", () => {
		const keys = (spec: PickSpec, cursor: number): string => plain(rowsOf(spec, cursor).at(-1)!);
		expect(keys(MODEL, 0)).toMatch(/^ {2}↑↓ move · ←→ effort · ⏎ switches · esc +1\/9$/);
		expect(keys(MODEL, 1), "no levels, no ←→").toMatch(/^ {2}↑↓ move · ⏎ switches · esc +2\/9$/);
		expect(keys(MODE, 0), "digits only where digits pick").toMatch(/^ {2}↑↓ move · 1–4 picks · ⏎ switches · esc +1\/4$/);
		expect(keys(SETTINGS, 0), "a row may say what ⏎ does on it").toMatch(/⏎ opens \/model · esc +1\/4$/);
		expect(keys(SETTINGS, 3)).toMatch(/⏎ prints how · esc +4\/4$/);
		expect(visibleWidth(rowsOf(MODEL, 0).at(-1)!)).toBe(79);
		for (const spec of [MODEL, MODE, SETTINGS]) expect(plain(rowsOf(spec, 0).at(-1)!), "the last row is the key row, not a rule").not.toMatch(/^─/);
	});
});

describe("P3 — the opened row", () => {
	it("the level strip: the level in force bold gold, no brackets; the facts give way first", () => {
		const p = palette();
		const rows = rowsOf(MODEL, 0);
		const open = rows[rows.findIndex((r) => r.startsWith(p.askEdge)) + 1]!;
		expect(open.startsWith(p.askEdge), "the opened row is on the same wash").toBe(true);
		expect(plain(open).trim()).toBe("effort none · low · high · max  ·  profile ds · openai-compat · DS_KEY");
		expect(open).toContain(`${p.bold}${p.gold}high${p.reset}`);
		expect(plain(open)).not.toContain("[");
		// narrow: the strip stays whole, the facts are cut with an ellipsis
		const narrow = rowsOf(MODEL, 2, { W: 60 });
		const o2 = plain(narrow[narrow.findIndex((r) => r.startsWith(p.askEdge)) + 1]!).trimEnd();
		expect(o2).toMatch(/^ {2}effort low · medium · high · xhigh · max {2}· {2}profile …?/);
		expect(o2.endsWith("…")).toBe(true);
		expect(visibleWidth(o2), "the two lead cells and the row's room: W − 1").toBe(59);
	});

	it("a named axis is the row's own value: its strip has no label, and the value cell follows the walk", () => {
		const p = palette();
		const rows = rowsOf(SETTINGS, 1, { level: 2 });
		const at = rows.findIndex((r) => r.startsWith(p.askEdge));
		expect(plain(rows[at]!)).toMatch(/^ ›mode +plan +default/);
		expect(plain(rows[at + 1]!).trim()).toBe("default · accept edits · plan · full access");
		expect(rows[at + 1]).toContain(`${p.bold}${p.gold}plan${p.reset}`);
	});

	it("a profile that cannot run: its row dim, its state in two words, the whole reason on the opened row", () => {
		const p = palette();
		const unselected = rowsOf(MODEL, 0).find((r) => plain(r).includes("gpt-5.6-sol"))!;
		expect(unselected).toContain(`${p.dim}gpt-5.6-sol`);
		expect(plain(unselected)).toMatch(/gpt-5\.6-sol +chatgpt\.com +sign in/);
		const rows = rowsOf(MODEL, 1);
		expect(plain(rows[rows.findIndex((r) => r.startsWith(p.askEdge)) + 1]!).trim()).toBe("not signed in: run kiso login chatgpt");
	});

	it("a config setting opens into what it means and how it changes — cut by cells, with an ellipsis", () => {
		const p = palette();
		const rows = rowsOf(SETTINGS, 3);
		const o = plain(rows[rows.findIndex((r) => r.startsWith(p.askEdge)) + 1]!).trimEnd();
		expect(o).toMatch(/^ {2}irrecoverable deletes are refused in every mode · change: "floor": "off"/);
		expect(o.endsWith("…"), "a long how is cut with an ellipsis, never bare").toBe(true);
		expect(visibleWidth(o)).toBe(79);
	});
});

describe("P3 — the filter (/model)", () => {
	it("matches the label, then the host, then the texts it does not draw; the typed letters are gold where they landed", () => {
		const p = palette();
		const gold = `${p.bold}${p.gold}`;
		expect(pickList(MODEL, { cursor: 0, level: null, query: "glm" }).shown).toEqual([3, 7]);
		expect(pickList(MODEL, { cursor: 0, level: null, query: "bbbb" }).shown, "the host").toEqual([6, 7, 8]);
		expect(pickList(MODEL, { cursor: 0, level: null, query: "op/" }).shown, "the profile's name").toEqual([6, 7, 8]);
		expect(rowsOf(MODEL, 3, { query: "glm" }).join("\n")).toContain(`${gold}glm`);
		expect(rowsOf(MODEL, 6, { query: "bbbb" }).join("\n")).toContain(`${gold}bbbb${p.reset}`);
	});

	it("a cursor the filter took away lands on the first row left, with that row's own level", () => {
		const list = pickList(MODEL, { cursor: 0, level: 3, query: "opus" });
		expect(list.cursor).toBe(2);
		expect(list.level, "the level comes with the row it lands on").toBe(2);
		const kept = pickList(MODEL, { cursor: 0, level: 3, query: "deep" });
		expect(kept.cursor, "a cursor still on the list stays").toBe(0);
		expect(kept.level).toBe(3);
	});

	it("a typed provider/model that nothing matches becomes a row; a slash typed into a profile's name is filtering", () => {
		const direct = pickList(MODEL, { cursor: 0, level: null, query: "openai-compat/deepseek-reasoner" });
		expect(direct.shown).toEqual([PROFILES.length]);
		expect(direct.direct).toBe("openai-compat/deepseek-reasoner");
		expect(rowsOf(MODEL, 0, { query: "openai-compat/deepseek-reasoner" }).map(plain).join("\n")).toContain("›use openai-compat/deepseek-reasoner directly");
		expect(pickList(MODEL, { cursor: 0, level: null, query: "co/glm" }).direct, "a profile's own name").toBeNull();
		expect(pickList(MODEL, { cursor: 0, level: null, query: "op/" }).direct, "half a profile name").toBeNull();
		expect(pickList(MODEL, { cursor: 0, level: null, query: "z-ai/glm-5.3-flash" }).direct, "a row's own label").toBeNull();
		expect(pickList(MODEL, { cursor: 0, level: null, query: "zz" }).direct, "no slash, no direct row").toBeNull();
		expect(pickList({ ...MODEL, direct: false }, { cursor: 0, level: null, query: "a/b" }).direct).toBeNull();
	});

	it("nothing matches: the band says so and the key row counts nothing", () => {
		const rows = rowsOf(MODEL, 0, { query: "zzzz" }).map(plain);
		expect(rows[1]).toBe('  nothing matches "zzzz"');
		expect(rows.at(-1)).toMatch(/ 0\/0$/);
	});
});

describe("P3 — the window (§8.2)", () => {
	const many: PickSpec = { header: "model", noun: "profiles", options: Array.from({ length: 20 }, (_, i) => ({ label: `m-${i + 1}` })) };
	it("five rows below a 30-row terminal, eight from one, with a dim more-mark in column 0", () => {
		const p = palette();
		expect(pickWindowOf(modelPickView(many, ""), { cursor: 0, level: null }, 40, 24).size).toBe(5);
		expect(pickWindowOf(modelPickView(many, ""), { cursor: 0, level: null }, 40, 30).size).toBe(8);
		const rows = rowsOf(many, 10);
		expect(rows.find((r) => plain(r).includes("m-8"))!.startsWith(`${p.dim}↑${p.reset} `)).toBe(true);
		expect(rows.find((r) => plain(r).includes("m-12"))!.startsWith(`${p.dim}↓${p.reset} `)).toBe(true);
	});
});

describe("P3 — the keys", () => {
	function open(spec: PickSpec): { editor: Editor; verdict: () => PanelVerdict | null } {
		const editor = new Editor(() => {});
		let v: PanelVerdict | null = null;
		editor.beginPanel(modelPickView(spec, "▸ idle"), (got) => {
			v = got;
		});
		return { editor, verdict: () => v };
	}

	it("a filter: digits and h/l are letters; ↑↓ walk what is SHOWN; ⏎ takes the row under the cursor", () => {
		const { editor, verdict } = open(MODEL);
		editor.feed(enc("5.3"));
		expect(editor.line()).toBe("5.3");
		expect(pickList(MODEL, editor.panelState()!.pick!).shown).toEqual([3, 7]);
		editor.feed(enc("\x1b[B"));
		expect(editor.panelState()!.pick!.cursor, "the second MATCH, not the second option").toBe(7);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "picked", result: { index: 7 } });
	});

	it("a filter's ←→ walk the level when the row has one, and are the composer's when it has none", () => {
		const { editor, verdict } = open(MODEL);
		editor.feed(enc("\x1b[C"));
		expect(editor.panelState()!.pick!.level, "the effort walked").toBe(3);
		editor.feed(enc("\r"));
		expect(verdict()).toEqual({ action: "picked", result: { index: 0 }, level: 3 });
		const second = open(MODEL);
		second.editor.feed(enc("glm\x1b[D"));
		expect(second.editor.panelState()!.pick!.cursor, "the filter moved the selection to the first match").toBe(3);
		expect(second.editor.panelState()!.pick!.level, "no axis on the glm row").toBeNull();
		expect(second.editor.line(), "← moved the filter's cursor, the text is unchanged").toBe("glm");
	});

	it("backspace edits the filter through the composer, and the list follows the text", () => {
		const { editor } = open(MODEL);
		editor.feed(enc("glmx"));
		expect(pickList(MODEL, editor.panelState()!.pick!).shown).toEqual([]);
		editor.feed(enc("\x7f"));
		expect(editor.line()).toBe("glm");
		expect(pickList(MODEL, editor.panelState()!.pick!).shown).toEqual([3, 7]);
	});

	it("the arrows-only list: a digit picks nothing, ←→ walk a setting's axis", () => {
		const editor = new Editor(() => {});
		let v: PanelVerdict | null = null;
		editor.beginPanel(settingsPickView(SETTINGS, "▸ idle"), (got) => {
			v = got;
		});
		editor.feed(enc("3"));
		expect(editor.panelState()!.pick!.cursor).toBe(0);
		editor.feed(enc("\x1b[B\x1b[B\x1b[C\r"));
		expect(v).toEqual({ action: "picked", result: { index: 2 }, level: 1 });
	});
});

describe("P3 — on the dock", () => {
	const BAR: BarInput = { mode: "default", floorOff: false, model: "deepseek-v4-flash", ctx: null, tokPerSec: null, branch: "main", folder: null };
	function frame(spec: PickSpec, typed = ""): string[] {
		vi.useFakeTimers();
		try {
			const writes: string[] = [];
			const W = 80;
			const H = 24;
			const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
			const editor = new Editor(() => body.render());
			body.bindInput(() => editor.dockState(), "");
			body.bindApproval(() => editor.panelState());
			body.setBar(BAR);
			body.enter();
			editor.beginPanel(modelPickView(spec, "▸ default"), () => {});
			if (typed !== "") editor.feed(enc(typed));
			body.render();
			vi.advanceTimersByTime(16);
			const rows = new Map<number, string>();
			for (const m of writes.join("").matchAll(/\x1b\[(\d+);1H\x1b\[0K((?:[^\x1b]|\x1b\[[0-9;]*m)*)/g)) rows.set(Number(m[1]), m[2]!);
			return Array.from({ length: H }, (_, i) => rows.get(i + 1) ?? "");
		} finally {
			vi.useRealTimers();
		}
	}

	it("the Graphite bar stays under a pick panel — no `▸ default`, no old key ladder", () => {
		const rows = frame(MODEL).map(plain);
		expect(rows[23]).toContain("/mode to switch");
		expect(rows[23]).toContain("deepseek-v4-flash");
		expect(rows.join("\n")).not.toContain("▸ default");
		expect(rows.join("\n")).not.toContain("/ commands · ↑ history");
	});

	it("the input row is the composer's: no `1-9>` lead, the filter's hint while it is empty, the text once typed", () => {
		const empty = frame(MODEL).map(plain);
		expect(empty[21]).toMatch(/^ ?filter, or type provider\/model/);
		expect(empty.join("\n")).not.toMatch(/\d-\d>/);
		const typed = frame(MODEL, "glm").map(plain);
		expect(typed[21]!.trimEnd()).toMatch(/^glm ?$/);
		const digits = frame(MODE).map(plain);
		expect(digits[21]!.trim(), "a digit list's input row is empty").toBe("");
	});

	it("the band closes on its key row — no rule of its own, so the screen's only rules are the composer's two", () => {
		const rows = frame(MODEL).map(plain);
		const keys = rows.findIndex((r) => /^ {2}↑↓ move .* 1\/9$/.test(r));
		expect(keys).toBeGreaterThan(0);
		expect(rows[keys + 1]).not.toMatch(/^─+$/);
		expect(rows.filter((r) => /^─+$/.test(r)).length).toBe(2);
	});
});

describe("P3 — every row fits, and no cut leaves a bare escape", () => {
	it("W 20..160 on three grounds, for the three panels, filtered and not", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 7) {
				for (const [spec, cursor, query] of [[MODEL, 0, undefined], [MODEL, 2, "o"], [MODEL, 0, "x/y"], [MODE, 3, undefined], [SETTINGS, 3, undefined], [SETTINGS, 1, undefined]] as const) {
					for (const r of rowsOf(spec, cursor, { W, ...(query === undefined ? {} : { query }) })) {
						expect(visibleWidth(r), `${g} W=${W} ${spec.header}: ${plain(r)}`).toBeLessThanOrEqual(W);
						expect(r, `${g} W=${W}`).not.toMatch(BARE_ESC);
					}
				}
			}
		}
	});
});
