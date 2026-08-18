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
	renderResumeList,
	renderStatusLine,
	renderTerminalGap,
	renderToolSummary,
	renderRecap,
	relativeTime,
	truncateRow,
	type RenderInput,
	type ResumeMeta,
} from "../src/render.js";
import { displayWidth } from "../src/width.js";
import { visibleWidth } from "../src/components.js";

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

describe("v2a/v5/KC3: the palette", () => {
	it("COLOR_ON is bold (SGR 1), the MONO inline-code tint (256 color 252), red, dim, green; COLOR_OFF is empty", () => {
		expect(COLOR_ON.bold).toBe("\x1b[1m");
		// KC3 §2, the mono recolor (a DECLARED SUPERSESSION): the tint was
		// the light BLUE 38;5;110 — the last blue byte in the product. The
		// mono discipline carries the body in shades of black and white,
		// so the tint is the light GRAY 38;5;252.
		expect(COLOR_ON.code).toBe("\x1b[38;5;252m");
		expect(COLOR_ON.red).toBe("\x1b[31m");
		expect(COLOR_ON.dim).toBe("\x1b[2m");
		expect(COLOR_ON.green).toBe("\x1b[32m");
		// TUI2-R2 ①: warn — the mono ruling's third functional exception
		// ("green ✓, yellow warn and red error") finally has an entry. It
		// carries the uncertain badge: a state that is neither success nor
		// failure but a question addressed to the human.
		expect(COLOR_ON.warn).toBe("\x1b[33m");
		expect(COLOR_ON.reset).toBe("\x1b[0m");
		expect(COLOR_OFF.bold).toBe("");
		expect(COLOR_OFF.code).toBe("");
		expect(COLOR_OFF.red).toBe("");
		expect(COLOR_OFF.dim).toBe("");
		expect(COLOR_OFF.green).toBe("");
		expect(COLOR_OFF.warn).toBe("");
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

	/**
	 * KC3 §2 — the mono discipline, stated as a gate rather than a
	 * convention. The body of the interface is carried by shades of
	 * black and white; green, yellow and red are the ONLY functional
	 * exceptions, and they are UNTOUCHED by the recolor.
	 *
	 * TUI2-R2 ①: the RESERVATION IS CLAIMED. KC3 wrote "yellow is
	 * reserved — the palette has no yellow entry today, so there is
	 * nothing to pin"; the uncertain badge is the first thing that
	 * needed it, and `warn` is now pinned here as the third functional
	 * colour rather than left to be re-argued. This is the reserved slot
	 * being filled, not a fourth colour: the gate below is unchanged in
	 * scope — a chromatic entry outside the three is still a regression.
	 */
	/**
	 * THE MARKDOWN-RENDER CLASS (TUI2-MD, the one declared class of moved
	 * assertions this round). MOVED #1 — the mono gate's allowed set gains
	 * SGR 3 and 23.
	 *
	 * The gate's SCOPE is unchanged and its question is unchanged: is any
	 * entry CHROMATIC? Italic is not. It is an attribute, exactly like
	 * bold (1), dim (2) and reverse (7) already in the set — no hue, no
	 * 256-cube index, and a terminal without italics simply draws the
	 * text. MD-1 (the owner's circle) put it in the alphabet because
	 * `*italic*` needed a rendering the mono discipline could accept; 23
	 * rides along as its close, the same way 27 rides along with 7.
	 */
	it("KC3: no chromatic entry survives outside the three functional colors", () => {
		const MONO = /^\x1b\[(?:0|1|2|3|7|23|27|38;5;(?:23[2-9]|24\d|25[0-5]))m$/; // SGR 0/1/2/3/7/23/27 + the 256-cube greyscale ramp
		const FUNCTIONAL: Record<string, string> = { red: "\x1b[31m", green: "\x1b[32m", warn: "\x1b[33m" };
		for (const [name, code] of Object.entries(COLOR_ON)) {
			if (name in FUNCTIONAL) {
				expect(code, `${name} is a FUNCTIONAL color — the recolor never moves it`).toBe(FUNCTIONAL[name]);
				continue;
			}
			expect(code, `${name}=${JSON.stringify(code)} is chromatic — the mono discipline forbids it`).toMatch(MONO);
		}
	});

	it("KC3: the functional colors are the plain SGR ones, not 256-color approximations", () => {
		expect(COLOR_ON.red).toBe("\x1b[31m");
		expect(COLOR_ON.green).toBe("\x1b[32m");
		// and the empty palette still zeroes them — a pipe carries no ANSI
		expect(COLOR_OFF.red).toBe("");
		expect(COLOR_OFF.green).toBe("");
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
	// KC3 §2: the NAME caught up with the assertions — these have pinned
	// the BOLD accent since v5 #16e; only the wording still said "blue".
	it("✓ is the bold accent, ✗ stays red, the replay you> line is bold", () => {
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
			"▞ 47s · 3 tools (1 edit) · in 8.2k out 410 · cache 49% · ctx left ~96%\n", // 7954/(8200+7954)
		);
	});

	it("W19 — the plan branch drops the metadata BEFORE the fold: 79 cols, one row at W=80, never ctx left", () => {
		const line = renderRecap({ seconds: 47, tools: 3, edits: 1, usage: usage(), ctxLeftPct: 96, mode: "plan" });
		expect(line).toBe("▞ plan ready · /mode default executes · /mode accept-edits auto-approves edits\n");
		// the done-when: the line's visible width ≤ 80 even with the ctx
		// left present (the segment is dropped — the status row carries it).
		expect(visibleWidth(line.trim())).toBeLessThanOrEqual(80);
	});

	it("singulars and omissions: 1 tool, no edits, unknown usage → the parts drop", () => {
		expect(renderRecap({ seconds: 2, tools: 1, edits: 0, usage: usage({ known: false }), ctxLeftPct: null })).toBe(
			"▞ 2s · 1 tool\n",
		);
	});

	it("E2 T5: cache % is cache/(in+cache) — the pinned sentence, never > 100%; null cache drops it", () => {
		// the denominator is the TOTAL (fresh + cache) — a cache ratio can
		// never exceed 100% (the old cache/in denominator rendered 923%).
		// in 0 with cache > 0 is honest: everything came from cache → 100%.
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: 0 }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 0 out 410 · cache 100%\n",
		);
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ cache: null }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 8.2k out 410\n",
		);
	});

	it("E2 T5: the >100% disease regression — fresh 111 + cache 1024 rendered 923%, now 90%", () => {
		// the fixture: an anthropic turn whose fresh delta is tiny next to
		// the cached prefix. OLD formula: 1024/111 = 922.5% → "cache 923%".
		// NEW: 1024/1135 = 90.2% → "cache 90%".
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: 111, cache: 1024 }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 111 out 410 · cache 90%\n",
		);
	});

	it("E2 T5: the never->100% gate — every in/cache pair renders a cache % in [0, 100]", () => {
		for (let in_ = 0; in_ <= 2000; in_ += 250) {
			for (const cache of [0, 1024, 8200, 12410, 50000]) {
				const line = renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: in_, cache }), ctxLeftPct: null });
				const hit = /cache (\d+)%/.exec(line);
				if (hit === null) {
					// dropped only when both sides are 0 (the empty denominator)
					expect(in_).toBe(0);
					expect(cache).toBe(0);
				} else {
					const pct = Number.parseInt(hit[1]!, 10);
					expect(pct, `in=${in_} cache=${cache}`).toBeGreaterThanOrEqual(0);
					expect(pct, `in=${in_} cache=${cache}`).toBeLessThanOrEqual(100);
				}
			}
		}
	});

	it("k-units: 12345 → 12.3k, 800 → 800", () => {
		expect(renderRecap({ seconds: 1, tools: 1, edits: 0, usage: usage({ in: 12345, out: 800 }), ctxLeftPct: null })).toBe(
			"▞ 1s · 1 tool · in 12.3k out 800 · cache 39%\n", // 7954/(12345+7954)
		);
	});

	it("R-C item 4: an above-floor cache miss appends the miss segment", () => {
		expect(renderRecap({ seconds: 3, tools: 2, edits: 0, usage: usage({ in: 123456, cache: 82000 }), missed: 41000, ctxLeftPct: null })).toBe(
			"▞ 3s · 2 tools · in 123.5k out 410 · cache 40% · miss 41k\n",
		);
	});

	it("R-C item 4: a zero miss renders nothing — the historical bytes hold", () => {
		expect(renderRecap({ seconds: 3, tools: 2, edits: 0, usage: usage(), missed: 0, ctxLeftPct: null })).toBe(
			"▞ 3s · 2 tools · in 8.2k out 410 · cache 49%\n",
		);
	});
});

describe("⑥: the checklist cell (the durable task render)", () => {
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

describe("v7 W5: the resume list — the opening-screen sessions (W5)", () => {
	const METAS: readonly ResumeMeta[] = [
		{ title: "fix the resize repaint storm", events: 41, runs: 3, updatedAt: 1_700_000_000_000 },
		{ title: "v6 one-compositor gates", events: 183, runs: 12, updatedAt: 1_700_000_300_000 },
	];
	const NOW = 1_700_000_400_000;

	it("the shape: header, relative time, title, right-aligned meta — every row exactly W wide, the meta column aligned (the done-when)", () => {
		const rows = renderResumeList(METAS, 80, NOW);
		expect(rows[0]).toBe("  ▞ resume");
		// metaW = 20 (the longer meta); titleW = 80 - 13 - 20 = 47; pads 19 / 24
		expect(rows[1]).toBe(
			"    6m ago  fix the resize repaint storm" + " ".repeat(19) + " " + "  41 events · 3 runs",
		);
		expect(rows[2]).toBe("    1m ago  v6 one-compositor gates" + " ".repeat(24) + " " + "183 events · 12 runs");
		// the DATA rows are exactly W wide — the meta's RIGHT edge lands at W
		// on every row (the done-when); the header is its own short row
		expect(displayWidth(rows[0]!)).toBe(10);
		for (const r of rows.slice(1)) expect(displayWidth(r)).toBe(80);
		// the meta FIELD (padStart to metaW) occupies the SAME columns on
		// every row — the meta column is aligned across rows
		expect(rows[1]!.slice(60, 80)).toBe("  41 events · 3 runs");
		expect(rows[2]!.slice(60, 80)).toBe("183 events · 12 runs");
	});

	it("empty metas → no rows at all", () => {
		expect(renderResumeList([], 80, NOW)).toEqual([]);
	});

	it("a too-long title cuts inside the width with the ellipsis marker", () => {
		const rows = renderResumeList([{ title: "a".repeat(100), events: 1, runs: 1, updatedAt: NOW }], 60, NOW);
		// titleW = 60 - 13 - 16 = 31; the marker "…" is 2 cells wide (the
		// ambiguous-width authority) — the cut keeps 29 cells + the marker
		expect(rows[1]).toBe("    now     " + "a".repeat(29) + "…" + " " + "1 events · 1 runs");
		expect(displayWidth(rows[1]!)).toBe(60);
		expect(truncateRow(rows[1]!, 60)).toBe(rows[1]);
	});

	it("relativeTime edges: now, m, h, d, w — no 0m window exists", () => {
		expect(relativeTime(NOW - 59_999, NOW)).toBe("now");
		expect(relativeTime(NOW - 60_000, NOW)).toBe("1m ago");
		expect(relativeTime(NOW - 3_599_000, NOW)).toBe("59m ago");
		expect(relativeTime(NOW - 3_600_000, NOW)).toBe("1h ago");
		expect(relativeTime(NOW - 86_400_000, NOW)).toBe("1d ago");
		expect(relativeTime(NOW - 604_800_000, NOW)).toBe("1w ago");
	});

	it("the tier gate: BIG (W≥40 && H≥20) shows the list, one blank above; COMPACT / narrow / empty drop it entirely", () => {
		const big = bannerLines(80, 24, "0.1.37", "[3 extensions: asky]", METAS, NOW);
		expect(big).toContain("  ▞ resume");
		expect(big.some((r) => r.includes("fix the resize repaint storm"))).toBe(true);
		expect(big.some((r) => r.includes("183 events · 12 runs"))).toBe(true);
		const ext = big.indexOf("[3 extensions: asky]");
		expect(big[ext + 1]).toBe("");
		expect(big[ext + 2]).toBe("  ▞ resume");
		expect(big.length).toBe(13); // 6 art + blank + version + extensions + blank + 3 resume rows
		for (const r of big) expect(truncateRow(r, 80)).toBe(r);
		// the narrowest BIG tier still aligns the meta at exactly W (40)
		const narrow = bannerLines(40, 20, "0.1.37", "", METAS, NOW);
		expect(narrow).toContain("  ▞ resume");
		for (const r of narrow) expect(truncateRow(r, 40), r).toBe(r);
		// the tier drops below the gate — COMPACT, narrow, and empty
		expect(bannerLines(80, 15, "0.1.37", "", METAS, NOW).some((r) => r.includes("▞ resume"))).toBe(false);
		expect(bannerLines(39, 24, "0.1.37", "", METAS, NOW).some((r) => r.includes("▞ resume"))).toBe(false);
		expect(bannerLines(80, 24, "0.1.37", "", [], NOW).some((r) => r.includes("▞ resume"))).toBe(false);
	});
});
