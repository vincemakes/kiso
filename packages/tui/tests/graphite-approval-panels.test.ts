/**
 * Graphite P4 — the approval, the model's question and kiso's own question
 * take the shape of every list band (owner, 2026-10-04: all four
 * recommendations taken — this shape for all three, the call said once as
 * its card's head, the question's `answers are durable facts` retired with
 * the old status row, and a counter on every key row).
 *
 * The band names the facts (`needs you · asked by mode:default`, `question ·
 * bundler · 1 of 2`); the call or the question comes first, once; the
 * options keep their digits and the gold `›`; one key row with the counter
 * closes the band — no rule under it, the composer's rail closes it. On a
 * dock the Graphite bar stays under every panel, the input row is the
 * composer's, and an empty note or answer row carries a dim hint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor } from "../src/editor.js";
import { askBlockRows, askKey, askStart, askView, panelRowsOf, type AskSpec } from "../src/ask-panel.js";
import { panelBlockRows, type PanelView } from "../src/approval-panel.js";
import { projectTrustView } from "../src/index.js";
import { visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";
import type { BarInput } from "../src/status.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const BARE_ESC = /\x1b(?![[\]])/;

const SHELL: PanelView = {
	flavor: "approval",
	name: "shell",
	title: "rm -rf build && npm run build",
	speaker: "mode:default",
	riskHint: "deletes files permanently (build)",
	statusText: "❯ run paused",
	args: { kind: "text", lines: ["rm -rf build && npm run build"] },
	fallbackQuestion: "approve shell? (y/n) ",
};
const WRITE: PanelView = {
	flavor: "approval",
	name: "write_file",
	title: "src/clamp.ts",
	speaker: "mode:default",
	hint: "/mode accept-edits auto-approves edits",
	statusText: "❯ run paused",
	args: { kind: "diff", diff: [{ kind: "+", text: "export function clamp(n: number) {" }, { kind: "+", text: "  return n;" }, { kind: "+", text: "}" }] },
	fallbackQuestion: "approve write_file? (y/n) ",
};
const ASK: AskSpec = {
	questions: [
		{ question: "which bundler should the build use?", header: "bundler", options: [{ label: "vite", description: "fast dev server" }, { label: "esbuild", description: "one binary" }] },
		{ question: "which test runners?", header: "runners", multiSelect: true, options: [{ label: "vitest" }, { label: "node:test" }] },
	],
};
const LONG_ROOT = "/private/var/folders/rr/ssmz3cxj5rv4xlp6dtdbmt800000gn/T/kiso-p4-he2xuqb9/work";
const TRUST = projectTrustView(LONG_ROOT, [{ path: ".kiso/config.json", digest: "97e337aa" }], LONG_ROOT);

const rows = (view: PanelView, cursor = 0, phase: "options" | "amend" | "safer" | "asking" = "options", W = 80): string[] => panelBlockRows(view, phase, cursor, W, 30);

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

describe("P4 — an approval says the call once", () => {
	it("the band names who asked; an amended call says so in the same facts", () => {
		expect(plain(rows(SHELL)[0]!)).toMatch(/^─{3} needs you · asked by mode:default ─+$/);
		expect(plain(rows({ ...SHELL, amended: true })[0]!)).toMatch(/^─{3} needs you · amended · asked by mode:default ─+$/);
	});

	it("the head is the call as its card reads — the display verb, upper case, then the target", () => {
		const p = palette();
		expect(rows(SHELL)[1]).toBe(`  ${p.bold}SHELL${p.reset} rm -rf build && npm run build`);
		expect(plain(rows(WRITE)[1]!)).toBe("  WRITE src/clamp.ts");
	});

	it("a one-line command is said ONCE: whole on the head row, or folded under it at its spaces — never cut and repeated", () => {
		const text = rows(SHELL).map(plain).join("\n");
		expect(text).not.toContain("│ rm -rf build");
		// the owner's capture (2026-10-05): a long command was cut in the head
		// and then repeated whole in a body, its first half read twice
		const long = 'which -a kiso; kiso --version 2>&1 | head -5; echo "---"; ls -la ~/.kiso/sessions 2>/dev/null | head -10';
		const r = rows({ ...SHELL, title: long, args: { kind: "text", lines: [long] } }).map(plain);
		expect(r[1]).toBe('  SHELL which -a kiso; kiso --version 2>&1 | head -5; echo "---"; ls -la');
		expect(r[2], "the continuation sits under the command's first cell").toBe("        ~/.kiso/sessions 2>/dev/null | head -10");
		expect(r.join("\n")).not.toContain("│");
		expect(r.join("\n")).not.toContain("…");
		// every character of the command is on screen, in order (the breaks are spaces)
		expect([r[1]!.slice("  SHELL ".length), r[2]!.trim()].join(" ")).toBe(long);
		// a run with no space breaks hard at the width, still whole
		const path = `cat ${"/very/long".repeat(12)}`;
		const hard = rows({ ...SHELL, title: path, args: { kind: "text", lines: [path] } }, 0, "options", 60).map(plain);
		const head = hard.slice(1).filter((x, i) => i === 0 || x.startsWith("        "));
		expect(head[0]).toBe("  SHELL cat"); // the one space is the break
		expect(head.slice(1).map((x) => x.trim()).join("")).toBe("/very/long".repeat(12));
		for (const x of head) expect(visibleWidth(x), "one cell of margin").toBeLessThanOrEqual(59);
		// a multi-line command still has its body
		const two = rows({ ...SHELL, title: "make && make test", args: { kind: "text", lines: ["make &&", "make test"] } }).map(plain).join("\n");
		expect(two).toContain("│ make &&");
	});

	it("a diff is the body, and the speaker's hint has a row of its own under it — whole, not cut", () => {
		const r = rows(WRITE).map(plain);
		expect(r[2]).toContain("export function clamp");
		const hint = r.findIndex((x) => x.includes("/mode accept-edits auto-approves edits"));
		expect(hint).toBeGreaterThan(2);
		expect(r[hint]).toBe("  /mode accept-edits auto-approves edits");
	});

	it("the risk line stays under the call in the warning colour; the options keep their digits and the gold ›", () => {
		const p = palette();
		const r = rows(SHELL);
		expect(r[2]).toBe(`  ${p.warn}deletes files permanently (build)${p.reset}`);
		const sel = r.find((x) => x.startsWith(p.askEdge))!;
		expect(sel).toContain(`${p.gold}›${p.fgEnd}`);
		expect(plain(sel)).toMatch(/^ › 1 Yes, run it/);
		expect(r.map(plain).filter((x) => /^ {3}[2-4] /.test(x))).toHaveLength(3);
	});

	it("one key row closes the band: esc says it denies, the counter at the margin, no rule under it", () => {
		const r = rows(SHELL, 2).map(plain);
		expect(r.at(-1)).toMatch(/^ {2}↑↓ move · ⏎ or click confirms · 1–4 instant · esc denies +3\/4$/);
		expect(visibleWidth(r.at(-1)!)).toBe(79);
		expect(r.filter((x) => /^─/.test(x)), "the band's own rule, and no other").toHaveLength(1);
	});

	it("amend: the options give way to where the note goes, and the keys say where esc goes back to", () => {
		const r = rows(SHELL, 3, "amend").map(plain);
		expect(r).toContain("  your note goes to the model — it will propose a new call");
		expect(r.some((x) => /^ {3}[1-4] /.test(x) || x.startsWith(" › "))).toBe(false);
		expect(r.at(-1)!.trimEnd()).toBe("  ⏎ sends · esc back to the choices");
	});

	it("safer: the block says what it asked, then the alternatives, counted with the way back", () => {
		const r = panelBlockRows(SHELL, "safer", 0, 80, 30, undefined, { options: [{ command: "npm run build", why: "keeps build/" }], cursor: 0 }).map(plain);
		const said = r.indexOf("  asked the model for safer options");
		expect(said).toBeGreaterThan(0);
		expect(r[said + 1]).toMatch(/1 npm run build/);
		expect(r.at(-1)).toMatch(/ 1\/2$/);
	});
});

describe("P4 — a question from the model", () => {
	const at = (q: number) => {
		let s = askStart(ASK);
		if (q === 1) s = askKey(ASK, s, "1").state;
		return s;
	};
	it("the band carries the header and the place in the set; the question is the first row, bold", () => {
		const p = palette();
		const r = askBlockRows(askView(ASK), at(0), 80, 30);
		expect(plain(r[0]!)).toMatch(/^─{3} question · bundler · 1 of 2 ─+$/);
		expect(r[1]).toBe(`  ${p.bold}which bundler should the build use?${p.reset}`);
		expect(plain(r[2]!)).toMatch(/^ › 1 +vite +fast dev server/);
		expect(r.map(plain).join("\n")).not.toContain("‹");
	});

	it("a pick-any question says so in the band; the key row counts the type-your-own row too", () => {
		const r = askBlockRows(askView(ASK), at(1), 80, 30).map(plain);
		expect(r[0]).toMatch(/^─{3} question · runners · 2 of 2 · pick any ─+$/);
		expect(r.at(-1)).toMatch(/^ {2}↑↓ move · space or 1–2 marks · ⏎ sends the set · .*← back · esc declines +1\/3$/);
		expect(r.filter((x) => /^─/.test(x))).toHaveLength(1);
	});

	it("a description too long for its column is cut by cells WITH an ellipsis; a single-select spends no mark column", () => {
		// the owner's capture (2026-10-05): the model's descriptions ended in
		// mid-word at the right edge, and the labels sat three cells off the digits
		const long: AskSpec = { questions: [{ question: "which part?", header: "scope", options: [{ label: "config and sessions", description: "the model definitions in config.json, and whether the session files are complete" }, { label: "the command", description: "the install path, the version and the runtime" }] }] };
		// (the cursor on the SECOND option: a selected long one opens instead)
		const r = askBlockRows(askView(long), askKey(long, askStart(long), "down").state, 80, 30).map(plain);
		const first = r.find((x) => x.includes("config and sessions"))!.trimEnd();
		expect(first.endsWith("…")).toBe(true);
		expect(visibleWidth(first)).toBeLessThanOrEqual(79);
		expect(r.find((x) => x.includes("the command"))).toMatch(/^ › 2 the command +the install path, the version and the runtime/);
		expect(r.find((x) => x.includes("type your own answer"))).toMatch(/^ {3}t type your own answer/);
	});

	it("the selected option OPENS when its description does not fit: the label alone on its row, the description whole under it (owner, 2026-10-05)", () => {
		const p = palette();
		const long: AskSpec = { questions: [{ question: "which part?", header: "scope", options: [
			{ label: "config and sessions", description: "the model definitions in config.json, whether the session files are complete, and whether auth.json is kept private" },
			{ label: "the command", description: "the install path" },
		] }] };
		const r = askBlockRows(askView(long), askStart(long), 80, 30);
		const at = r.findIndex((x) => x.startsWith(p.askEdge) && plain(x).includes("config and sessions"));
		expect(plain(r[at]!).trimEnd(), "its own row is the label alone — nothing said twice").toBe(" › 1 config and sessions");
		const opened = [r[at + 1]!, r[at + 2]!];
		for (const x of opened) expect(x.startsWith(p.askEdge), "on the selection's wash").toBe(true);
		const words = opened.map((x) => plain(x).trim()).join(" ");
		expect(words).toBe("the model definitions in config.json, whether the session files are complete, and whether auth.json is kept private");
		expect(plain(opened[0]!).indexOf("the model"), "under the label's first cell").toBe(plain(r[at]!).indexOf("config"));
		// the others keep one row; a description that fits does not open
		expect(plain(r[at + 3]!)).toMatch(/^ {3}2 the command +the install path$/);
		const fits = askBlockRows(askView(long), askKey(long, askStart(long), "down").state, 80, 30).map(plain);
		expect(fits.find((x) => x.includes("the command"))).toMatch(/› 2 the command +the install path/);
		expect(fits.filter((x) => x.includes("the install path"))).toHaveLength(1);
		expect(fits.find((x) => x.includes("config and sessions"))!.trimEnd().endsWith("…"), "the unselected long one is cut, one row").toBe(true);
	});

	it("an opened description is at most three rows, the third cut with an ellipsis", () => {
		const huge: AskSpec = { questions: [{ question: "q?", options: [{ label: "a", description: "word ".repeat(80).trim() }, { label: "b" }] }] };
		const r = askBlockRows(askView(huge), askStart(huge), 60, 30).map(plain);
		const at = r.findIndex((x) => x.startsWith(" › 1 a"));
		expect(r[at + 4], "three opened rows, then the next option").toMatch(/^ {3}2 b/);
		expect(r[at + 3]!.trimEnd().endsWith("…")).toBe(true);
		for (const x of r) expect(visibleWidth(x)).toBeLessThanOrEqual(60);
	});

	it("one question alone: no place in a set", () => {
		const one: AskSpec = { questions: [ASK.questions[0]!] };
		expect(plain(askBlockRows(askView(one), askStart(one), 80, 30)[0]!)).toMatch(/^─{3} question · bundler ─+$/);
	});
});

describe("P4 — kiso's own question", () => {
	it("a long path is cut from the LEFT: its folder's name and the rule's end stay on screen", () => {
		const head = plain(panelRowsOf({ view: TRUST, phase: "options", cursor: 0 }, 80, 30)[0]!);
		expect(head).toMatch(/^─{3} trust this project\? · …\S*kiso-p4-he2xuqb9\/work ─{3}$/);
		expect(visibleWidth(head)).toBe(80);
	});

	it("a path that fits is whole; the key row keeps the bare esc, and the counter", () => {
		const short = projectTrustView("/home/me/kiso", [{ path: ".kiso/config.json", digest: "3fa9c2e8" }], "~/kiso");
		const r = panelRowsOf({ view: short, phase: "options", cursor: 1 }, 80, 30).map(plain);
		expect(r[0]).toMatch(/^─{3} trust this project\? · ~\/kiso ─+$/);
		expect(r.at(-1)).toMatch(/^ {2}↑↓ move · ⏎ or click confirms · 1–2 instant · esc +2\/2$/);
	});
});

describe("P4 — on the dock", () => {
	const BAR: BarInput = { mode: "default", floorOff: false, model: "deepseek-v4-flash", ctx: null, tokPerSec: null, branch: "main", folder: null };
	function screen(view: PanelView, keys = "", bar: BarInput | null = BAR): string[] {
		vi.useFakeTimers();
		try {
			const writes: string[] = [];
			const W = 80;
			const H = 24;
			const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
			const editor = new Editor(() => body.render());
			body.bindInput(() => editor.dockState(), "");
			body.bindApproval(() => editor.panelState());
			if (bar !== null) body.setBar(bar);
			body.enter();
			editor.beginPanel(view, () => {});
			if (keys !== "") editor.feed(enc(keys));
			body.render();
			vi.advanceTimersByTime(16);
			const out = new Map<number, string>();
			for (const m of writes.join("").matchAll(/\x1b\[(\d+);1H\x1b\[0K((?:[^\x1b]|\x1b\[[0-9;]*m)*)/g)) out.set(Number(m[1]), plain(m[2]!));
			return Array.from({ length: H }, (_, i) => out.get(i + 1) ?? "");
		} finally {
			vi.useRealTimers();
		}
	}

	it("the Graphite bar stays under an approval and a question — no `❯ needs you · run paused`, no key ladder", () => {
		for (const view of [SHELL, askView(ASK)]) {
			const r = screen(view);
			expect(r[23]).toContain("/mode to switch");
			expect(r.join("\n")).not.toContain("run paused");
			expect(r.join("\n")).not.toContain("answers are durable facts");
			expect(r.join("\n")).not.toContain("/ commands · ↑ history");
		}
	});

	it("before a bar exists (the trust question comes before the session) the row says the panel's words, without the retired ladder", () => {
		const r = screen(TRUST, "", null);
		expect(r[23]).toContain("needs you · project trust");
		expect(r[23]).not.toContain("/ commands");
	});

	it("the input row is the composer's: no `amend›`, no `pick>` — a dim hint while the note or the answer is empty", () => {
		const amend = screen(SHELL, "4");
		expect(amend.join("\n")).not.toContain("amend›");
		expect(amend[21]).toMatch(/^ ?tell kiso what to do instead/);
		const typed = screen(SHELL, "4only rebuild");
		expect(typed[21]!.trimEnd()).toMatch(/^only rebuild ?$/);
		const ask = screen(askView(ASK));
		expect(ask.join("\n")).not.toContain("pick>");
		expect(ask[21]!.trim()).toBe("");
		expect(screen(askView(ASK), "t")[21]).toMatch(/^ ?your answer/);
	});
});

describe("P4 — every row fits, and no cut leaves a bare escape", () => {
	it("W 20..160 on three grounds, for the approval, its amend and safer phases, the question and kiso's question", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 7) {
				const all = [
					...rows(SHELL, 0, "options", W),
					...rows(WRITE, 3, "options", W),
					...rows(SHELL, 3, "amend", W),
					...panelBlockRows(SHELL, "safer", 0, W, 30, undefined, { options: [{ command: "npm run build", why: "keeps build/" }], cursor: 0 }),
					...askBlockRows(askView(ASK), askStart(ASK), W, 30),
					...panelRowsOf({ view: TRUST, phase: "options", cursor: 0 }, W, 30),
				];
				for (const r of all) {
					expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
					expect(r, `${g} W=${W}`).not.toMatch(BARE_ESC);
				}
			}
		}
	});
});
