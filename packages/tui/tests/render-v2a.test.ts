/**
 * v2a — the color identity and the rhythm contract. The palette is
 * centralized in render.ts: NO_COLOR or a non-TTY output resolves to the
 * EMPTY palette (pipes carry zero ANSI — the byte-level e2e assertions
 * guard it). The rhythm test pins the exact bytes of one turn's render
 * sequence (the render sequence → the expected bytes) exactly as the consumer composes them.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	bannerLines,
	colorInlineCode,
	COLOR_OFF,
	COLOR_ON,
	palette,
	renderEvent,
	renderStatusLine,
	renderTerminalGap,
	renderToolSummary,
	renderRecap,
	truncateRow,
	type RenderInput,
} from "../src/render.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
const setNoColor = (v: boolean): void => {
	if (v) process.env.NO_COLOR = "1";
	else delete process.env.NO_COLOR;
};
afterEach(() => {
	setNoColor(false);
	setTTY(ORIG_TTY ?? false);
});

describe("v2a/v5: the palette", () => {
	it("COLOR_ON is bold (SGR 1), the inline-code tint (256 color 110), red, dim, green; COLOR_OFF is empty", () => {
		expect(COLOR_ON.bold).toBe("\x1b[1m");
		expect(COLOR_ON.code).toBe("\x1b[38;5;110m");
		expect(COLOR_ON.red).toBe("\x1b[31m");
		expect(COLOR_ON.dim).toBe("\x1b[2m");
		expect(COLOR_ON.green).toBe("\x1b[32m");
		expect(COLOR_ON.reset).toBe("\x1b[0m");
		expect(COLOR_OFF.bold).toBe("");
		expect(COLOR_OFF.code).toBe("");
		expect(COLOR_OFF.red).toBe("");
		expect(COLOR_OFF.dim).toBe("");
		expect(COLOR_OFF.green).toBe("");
		expect(COLOR_OFF.reset).toBe("");
	});

	it("NO_COLOR → the empty palette (even on a TTY)", () => {
		setTTY(true);
		setNoColor(true);
		expect(palette()).toBe(COLOR_OFF);
	});

	it("a non-TTY output → the empty palette", () => {
		setNoColor(false);
		setTTY(false);
		expect(palette()).toBe(COLOR_OFF);
	});

	it("TTY without NO_COLOR → the full palette", () => {
		setNoColor(false);
		setTTY(true);
		expect(palette()).toBe(COLOR_ON);
	});
});

describe("v5: the inline-code tint (TUI v5 #16e)", () => {
	const code = (s: string): string => `${COLOR_ON.code}${s}${COLOR_ON.reset}`;

	it("backtick spans on a line get the tint; the rest stays plain", () => {
		setNoColor(false);
		setTTY(true);
		expect(colorInlineCode("use `npm test` to verify")).toBe(`use ${code("`npm test`")} to verify`);
		expect(colorInlineCode("`a` and `b` and c")).toBe(`${code("`a`")} and ${code("`b`")} and c`);
	});

	it("single level only — an unterminated backtick stays plain; spans pair left-to-right", () => {
		setNoColor(false);
		setTTY(true);
		expect(colorInlineCode("an opener ` without a closer")).toBe("an opener ` without a closer");
		// "`a `b` c`": the regex pairs `a ` then ` c` — the inner "b" is plain
		// (left-to-right pairing, no nesting).
		expect(colorInlineCode("`a `b` c`")).toBe(`${code("`a `")}b${code("` c`")}`);
	});

	it("NO_COLOR → byte-identical (no codes leak into pipes)", () => {
		setNoColor(true);
		setTTY(true);
		expect(colorInlineCode("use `npm test` to verify")).toBe("use `npm test` to verify");
	});

	it("renders carry ZERO ANSI when the palette is off — pipes and CI are plain", () => {
		setNoColor(true);
		setTTY(true); // NO_COLOR wins even on a TTY
		expect(renderEvent({ type: "user_input", content: "hello" }).text).toBe("you> hello\n");
		expect(renderToolSummary("read_file", { path: "a.ts" }, { content: "x", isError: false })).toBe("✓ read a.ts (1 line)");
		expect(renderEvent({ type: "terminal", outcome: { kind: "completed" } }).text).toBe("\ndone\n");
	});
});

describe("v2a: the recolors", () => {
	it("✓ is the blue accent, ✗ stays red, the replay you> line is blue", () => {
		setNoColor(false);
		setTTY(true);
		const ok = renderToolSummary("read_file", { path: "a.ts" }, { content: "x", isError: false });
		expect(ok).toBe(`${COLOR_ON.bold}✓${COLOR_ON.reset} read a.ts (1 line)`);
		const err = renderToolSummary("shell", { command: "npm test" }, { content: "exit 1", isError: true });
		expect(err.startsWith(`${COLOR_ON.red}✗${COLOR_ON.reset}`)).toBe(true);
		expect(renderEvent({ type: "user_input", content: "hi" }).text).toBe(`${COLOR_ON.bold}you> hi${COLOR_ON.reset}\n`);
	});

	it("the decorative accents are gone — the call line, verdicts, ok, and done are plain", () => {
		setNoColor(false);
		setTTY(true);
		expect(renderEvent({ type: "tool_call_end", name: "list_dir", input: {} }).text).toBe("→ list_dir({})\n");
		expect(
			renderEvent({ type: "tool_execution_succeeded" }).text,
		).toBe("  ok\n");
		expect(renderEvent({ type: "permission_decided", decision: "approved" }).text).toBe("  approved\n");
		expect(renderEvent({ type: "terminal", outcome: { kind: "completed" } }).text).toBe("\ndone\n");
	});

	it("error states stay red — ✗ marks, failed executions, terminal errors", () => {
		setNoColor(false);
		setTTY(true);
		expect(
			renderEvent({ type: "tool_execution_failed", error: "boom" }).text,
		).toBe(`${COLOR_ON.red}  failed: boom${COLOR_ON.reset}\n`);
		expect(renderEvent({ type: "terminal", outcome: { kind: "error", error: { message: "nope" } } }).text).toBe(
			`\n${COLOR_ON.red}error${COLOR_ON.reset}: nope\n`,
		);
	});
});

describe("v2a: the rhythm — the render sequence → the expected bytes", () => {
	it("one turn's exact bytes: the summary hugs the result, the status hugs done, one blank, then the prompt", () => {
		setNoColor(false);
		setTTY(true);
		const events: Array<RenderInput> = [
			{ type: "thinking", text: "Let me look" },
			{ type: "text_delta", text: "I see the workspace." },
			{ type: "tool_call_end", name: "list_dir", input: {} },
			{ type: "tool_execution_started" },
			{ type: "tool_execution_succeeded" },
			{ type: "tool_result", content: "…entries…", isError: false },
			{ type: "terminal", outcome: { kind: "completed" } },
		];
		// The consumer's exact composition (v2b): the thinking block FOLDS to
		// one dim line — the fold owns the block's newline; the summary line
		// is printed per tool_result; the gap follows the terminal. (The
		// interactive echo filter skips the turn's own user_input — the
		// sequence starts at the model's first output.)
		let bytes = "";
		for (const ev of events) {
			if (ev.type === "tool_result") {
				bytes += `${renderToolSummary("list_dir", { path: "notes" }, { content: "…entries…", isError: false })}\n`;
			}
			bytes += renderEvent(ev).text;
			if (ev.type === "terminal") {
				bytes += renderTerminalGap(renderStatusLine(1, { in: null, out: null, cache: null, known: false }, 0, true));
			}
		}
		const expected =
			`${COLOR_ON.dim}…Let me look${COLOR_ON.reset}\n` + // the folded block, one line
			"I see the workspace." + // text continues on the next line
			"→ list_dir({})\n" +
			`${COLOR_ON.dim}  running…${COLOR_ON.reset}\n` +
			"  ok\n" +
			`${COLOR_ON.bold}✓${COLOR_ON.reset} list_dir notes\n` + // summary hugs the result
			`${COLOR_ON.dim}${COLOR_ON.dim}  [result] …entries…${COLOR_ON.reset}\n` +
			"\ndone\n" + // the terminal render
			"[turn 1 · faux]\n\n"; // the status hugs done, then EXACTLY one blank
		expect(bytes).toBe(expected);
	});
});

describe("v3 §02: the recap line (all fields derived locally — zero tokens)", () => {
	const usage = (u: Partial<import("../src/render.js").RunUsage> = {}): import("../src/render.js").RunUsage => ({
		in: 8200,
		out: 410,
		cache: 7954,
		known: true,
		...u,
	});

	it("the full form: seconds · tools (edits) · in/out · cache % · ctx left %", () => {
		expect(renderRecap({ seconds: 47, tools: 3, edits: 1, usage: usage(), ctxLeftPct: 96 })).toBe(
			"▞ 47s · 3 tools (1 edit) · in 8.2k out 410 · cache 97% · ctx left ~96%\n",
		);
	});

	it("singulars and omissions: 1 tool, no edits, unknown usage → the parts drop", () => {
		expect(renderRecap({ seconds: 2, tools: 1, edits: 0, usage: usage({ known: false }), ctxLeftPct: null })).toBe(
			"▞ 2s · 1 tool\n",
		);
	});

	it("cache % is cache/in — in 0 or null cache drops it", () => {
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: 0 }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 0 out 410\n", // in 0 is honest — only the cache % drops (a 0 denominator)
		);
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ cache: null }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 8.2k out 410\n",
		);
	});

	it("k-units: 12345 → 12.3k, 800 → 800", () => {
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: 12345, out: 800 }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 12.3k out 800 · cache 64%\n", // 7954/12345
		);
	});
});

describe("⑥: the checklist cell (the durable todo render)", () => {
	it("NO_COLOR: the header ▞ + the brick glyphs (□ pending / ▖ active / ▣ done), byte-exact", () => {
		const ev: RenderInput = {
			type: "checklist",
			header: "3 items — 1 pending, 1 active, 1 done",
			items: [
				{ text: "write the plan", status: "pending" },
				{ text: "implement", status: "active" },
				{ text: "verify", status: "done" },
			],
		};
		expect(renderEvent(ev).text).toBe(
			"▞ 3 items — 1 pending, 1 active, 1 done\n" +
				"  □ write the plan\n" +
				"  ▖ implement\n" +
				"  ▣ verify\n",
		);
	});

	it("TTY: only the ▞ accent is bold; the items stay plain (glyphs carry the status)", () => {
		setTTY(true);
		setNoColor(false);
		const ev: RenderInput = {
			type: "checklist",
			header: "1 item — 0 pending, 1 active, 0 done",
			items: [{ text: "go", status: "active" }],
		};
		expect(renderEvent(ev).text).toBe(`${COLOR_ON.bold}▞${COLOR_ON.reset} 1 item — 0 pending, 1 active, 0 done\n  ▖ go\n`);
	});

	it("terminal-injection vectors in item text are stripped (escaped at composition)", () => {
		// The escape strips ESC and C0 bytes; the residue is inert literal
		// text — no control sequence can reach the terminal.
		const ev: RenderInput = {
			type: "checklist",
			header: "1 item",
			items: [{ text: "\x1b[31mred\x07", status: "pending" }],
		};
		expect(renderEvent(ev).text).toBe("▞ 1 item\n  □ [31mred\n");
	});
});

describe("v7 W1: the banner tiers (the height input)", () => {
	const V = "0.1.37";
	it("≥ 20 rows → BIG: the 36x6 █-only wordmark, indented two — 38 cols clears 40", () => {
		const rows = bannerLines(40, 20, V, "[3 extensions: asky]");
		expect(rows[0]).toBe("  ██    ██  ██████  ████████  ████████");
		expect(rows.length).toBe(9); // 6 art + blank + version + extensions
		expect(rows[8]!).toBe("[3 extensions: asky]");
		// the version row (49 cells) truncates at 40 with the marker —
		// only the ART must clear 40, per the spec
		expect(rows[7]!.startsWith(`v${V} —`)).toBe(true);
		// the art is the wordmark — the text row does NOT repeat the name
		expect(rows[7]!).not.toMatch(/^kiso v/);
	});
	it("14–19 rows → COMPACT: v6's logo byte-identical, no redraw", () => {
		const rows = bannerLines(80, 15, V, "");
		expect(rows.slice(0, 3)).toEqual(["█ █ ▀█▀ █▀▀ █▀█", "█▀▄  █  ▀▀█ █ █", "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀"]);
		expect(rows[3]).toBe("");
		expect(rows[4]).toBe(`v${V} — the coding agent that survives kill -9`);
	});
	it("anything smaller → text rows only (narrow, short, and unmeasured)", () => {
		for (const [W, H] of [
			[39, 24],
			[80, 13],
			[80, 0], // a raw PTY / pipe reports rows = 0
		] as const) {
			const rows = bannerLines(W, H, V, "");
			// at 39 the version row itself truncates (with the marker, ≤ W) —
			// the tier's identity is the absence of art, not a full row
			expect(rows[0]!.startsWith(`v${V} —`)).toBe(true);
			expect(rows.every((r) => !r.includes("█"))).toBe(true);
			for (const r of rows) expect(truncateRow(r, W), `W=${W} H=${H}: ${r}`).toBe(r);
		}
	});
	it("all three tiers at 40, 64, 88, 120: no row exceeds W (truncateRow is the width authority)", () => {
		for (const W of [40, 64, 88, 120]) {
			for (const H of [24, 15, 0]) {
				const rows = bannerLines(W, H, V, "a ".repeat(80).trim());
				for (const r of rows) expect(truncateRow(r, W), `W=${W} H=${H}: ${r}`).toBe(r);
			}
		}
	});
});
