/**
 * E 组 — terminal safety: ESC, C0/C1 control characters, CR, backspace,
 * and bidi overrides must never reach the terminal from model/tool text.
 */

import { describe, expect, it } from "vitest";
import { canonicalPath, foldThinking, renderEvent, renderSessionLine, renderStatusLine, renderToolSummary } from "../src/render.js";

const NUL = "\u0000";
const BS = "\u0008";
const CR = "\u000d";
const C1 = "\u009b";
const ESC = "\u001b";
const BIDI = "\u202e";

describe("terminal escaping (E 组)", () => {
	it("strips ESC sequences from tool results", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "tool_result",
			callId: "c1",
			content: `normal${ESC}[2Jevil`,
			isError: false,
		});
		expect(rendered.text).not.toContain(`${ESC}[2J`); // the injected sequence
		expect(rendered.text).toContain("normal");
		expect(rendered.text).toContain("evil");
	});

	it("strips C0/C1 control characters, CR, and backspace", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "tool_result",
			callId: "c1",
			content: `a${NUL}b${BS}c${CR}d${C1}e`,
			isError: false,
		});
		expect(rendered.text).not.toContain(NUL);
		expect(rendered.text).not.toContain(BS);
		expect(rendered.text).not.toContain(CR);
		expect(rendered.text).not.toContain(C1);
		expect(rendered.text).toContain("abcde");
	});

	it("strips bidi override characters from model text", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "text_delta",
			text: `safe${BIDI}evil`,
		});
		expect(rendered.text).not.toContain(BIDI);
		expect(rendered.text).toContain("safe");
		expect(rendered.text).toContain("evil");
	});

	it("an ESC-injected shell command in the approval prompt is stripped", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "permission_requested",
			decisionId: "d-1",
			callId: "c1",
			name: "shell",
			input: { command: `echo safe ${ESC}[31mRED${ESC}[0m` },
		});
		expect(rendered.text).not.toContain(`${ESC}[31m`); // the injected sequence
		expect(rendered.text).toContain("echo safe");
	});

	it("八: an ESC-injected TOOL NAME in the approval prompt is stripped", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "permission_requested",
			decisionId: "d-1",
			callId: "c1",
			name: `shell${ESC}[2Jevil`,
			input: { command: "ls" },
		});
		expect(rendered.text).not.toContain(`${ESC}[2J`);
		expect(rendered.text).toContain("shell");
	});

	it("八: the terminal error message is escaped", () => {
		const rendered = renderEvent({
			seq: 0,
			type: "terminal",
			outcome: { kind: "error", error: { code: "unknown", retryable: false, message: `boom ${ESC}[31mRED${ESC}[0m` } },
		});
		// The ESC byte is stripped from the MESSAGE (the renderer's own color
		// codes legitimately contain ESC — the injection is the message text
		// glued to it: ESC[31m followed by "RED").
		expect(rendered.text).not.toContain(`${ESC}[31mRED`);
		expect(rendered.text).toContain("boom");
		expect(rendered.text).toContain("[31mRED[0m"); // the inert remnant
	});

	it("八: the session title is escaped", () => {
		const line = renderSessionLine({
			id: "s1",
			title: `safe${ESC}[31mRED${ESC}[0m`,
			events: 1,
			runs: 1,
			updatedAt: 0,
		});
		expect(line).not.toContain(`${ESC}[31m`);
		expect(line).toContain("safe");
	});

	it("八: write_file approval shows the CANONICAL path and the FULL content", async () => {
		const { mkdtempSync, realpathSync, writeFileSync, symlinkSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiso-render-"))); // /var → /private/var
		const real = join(dir, "real.txt");
		writeFileSync(real, "actual-target", "utf8");
		symlinkSync(real, join(dir, "link.txt"));
		expect(canonicalPath(join(dir, "link.txt"))).toBe(real);

		const longContent = "X".repeat(500);
		const rendered = renderEvent({
			seq: 0,
			type: "permission_requested",
			decisionId: "d-1",
			callId: "c1",
			name: "write_file",
			input: { path: join(dir, "link.txt"), content: longContent },
		});
		// The canonical path is shown, and the ENTIRE content — no truncated
		// tail hiding a dangerous payload.
		expect(rendered.text).toContain(real);
		expect(rendered.text).toContain(longContent);
		expect(rendered.text).not.toContain("…");
	});
});

describe("B: tool summary lines and the status line", () => {
	it("read_file summary shows the line count", () => {
		const line = renderToolSummary("read_file", { path: "src/foo.ts" }, { content: "a\nb\nc\n", isError: false });
		expect(line).toContain("read src/foo.ts");
		expect(line).toContain("(3 lines)");
		expect(line.startsWith("✓")).toBe(true);
	});

	it("edit_file summary shows +replace -search line counts", () => {
		const line = renderToolSummary("edit_file", { path: "src/foo.ts", search: "a\nb", replace: "a\nb\nc\nd" }, { content: "edited src/foo.ts", isError: false });
		expect(line).toContain("edit src/foo.ts");
		expect(line).toContain("(+4 -2)");
	});

	it("write_file summary shows the written line count", () => {
		const line = renderToolSummary("write_file", { path: "x.ts", content: "a\nb" }, { content: "wrote x.ts", isError: false });
		expect(line).toContain("write x.ts");
		expect(line).toContain("(+2)");
	});

	it("a FAILED shell summary shows ✗ and the exit code", () => {
		const line = renderToolSummary("shell", { command: "npm test" }, { content: "exit 1: boom", isError: true });
		expect(line.startsWith("✗")).toBe(true);
		expect(line).toContain("shell npm test");
		expect(line).toContain("(exit 1)");
	});

	it("a successful shell summary shows exit 0", () => {
		const line = renderToolSummary("shell", { command: "npm test" }, { content: "ok", isError: false });
		expect(line.startsWith("✓")).toBe(true);
		expect(line).toContain("(exit 0)");
	});

	it("the status line formats known usage with k-units and ~ctx", () => {
		const line = renderStatusLine(3, { in: 12345, out: 1800, cache: 9200, known: true }, 0.14);
		expect(line).toContain("turn 3");
		expect(line).toContain("in 12.3k");
		expect(line).toContain("out 1.8k");
		expect(line).toContain("cache 9.2k");
		expect(line).toContain("ctx ~14%");
	});

	it("v2a denoise: fully unknown usage → null (the whole line is omitted); partial fields are omitted, never ?", () => {
		expect(renderStatusLine(1, { in: null, out: null, cache: null, known: false }, 0.05)).toBeNull();
		expect(renderStatusLine(1, { in: 800, out: null, cache: null, known: true }, 0.05)).toBe("[turn 1 · in 800 · ctx ~5%]");
		expect(renderStatusLine(1, { in: 800, out: 200, cache: null, known: true }, NaN)).toBe("[turn 1 · in 800 out 200]");
	});

	it("v2a faux mode: [turn N · faux]", () => {
		expect(renderStatusLine(2, { in: null, out: null, cache: null, known: false }, 0.05, true)).toBe("[turn 2 · faux]");
	});
});

describe("自举 P1 + v2b: thinking blocks fold to ONE dim line (foldThinking)", () => {
	const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

	it("a block's deltas append to the SAME segment — the fold renders the WHOLE block on one line, no mid-block newline", () => {
		// v2b: the CONSUMER buffers the block's deltas (flushThinking) and
		// folds the accumulated text ONCE at the block's end — deltas never
		// render between themselves, so the one-segment property survives.
		const block = "Let me look at " + "the file first.";
		const folded = foldThinking(block);
		expect(folded).toContain("…Let me look at the file first.");
		expect(strip(folded)).toBe(`…Let me look at the file first.\n`);
		// the fold carries EXACTLY the block's ending newline
		expect(folded.match(/\n/g)?.length).toBe(1);
		// a short block carries no truncation marker
		expect(folded).not.toContain("/think shows full");
	});

	it("a block over 100 chars truncates with the /think hint", () => {
		const long = "x".repeat(101);
		const folded = foldThinking(long);
		expect(strip(folded)).toBe(`…${"x".repeat(100)} (… /think shows full)\n`);
	});

	it("the first delta of a NEW block gets the … prefix again", () => {
		const after = foldThinking("Now let me answer.");
		expect(after).toContain("…Now let me answer.");
		// whitespace is trimmed before the fold
		expect(foldThinking("  hi  ")).toContain("…hi");
	});
});
