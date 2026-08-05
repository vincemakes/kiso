/**
 * v2a — the color identity and the rhythm contract. The palette is
 * centralized in render.ts: NO_COLOR or a non-TTY output resolves to the
 * EMPTY palette (pipes carry zero ANSI — the byte-level e2e assertions
 * guard it). The rhythm test pins the exact bytes of one turn's render
 * sequence (渲染序列→期望字节) exactly as the consumer composes them.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	COLOR_OFF,
	COLOR_ON,
	palette,
	renderEvent,
	renderStatusLine,
	renderTerminalGap,
	renderToolSummary,
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

describe("v2a: the palette", () => {
	it("COLOR_ON is the ONE accent (ANSI 256 color 75), red, dim; COLOR_OFF is empty", () => {
		expect(COLOR_ON.blue).toBe("\x1b[38;5;75m");
		expect(COLOR_ON.red).toBe("\x1b[31m");
		expect(COLOR_ON.dim).toBe("\x1b[2m");
		expect(COLOR_ON.reset).toBe("\x1b[0m");
		expect(COLOR_OFF.blue).toBe("");
		expect(COLOR_OFF.red).toBe("");
		expect(COLOR_OFF.dim).toBe("");
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

	it("renders carry ZERO ANSI when the palette is off — pipes and CI are plain", () => {
		setNoColor(true);
		setTTY(true); // NO_COLOR wins even on a TTY
		expect(renderEvent({ seq: 0, type: "user_input", content: "hello" }).text).toBe("you> hello\n");
		expect(renderToolSummary("read_file", { path: "a.ts" }, { content: "x", isError: false })).toBe("✓ read a.ts (1 line)");
		expect(renderEvent({ seq: 0, type: "terminal", outcome: { kind: "completed" } }).text).toBe("\ndone\n");
	});
});

describe("v2a: the recolors", () => {
	it("✓ is the blue accent, ✗ stays red, the replay you> line is blue", () => {
		setNoColor(false);
		setTTY(true);
		const ok = renderToolSummary("read_file", { path: "a.ts" }, { content: "x", isError: false });
		expect(ok).toBe(`${COLOR_ON.blue}✓${COLOR_ON.reset} read a.ts (1 line)`);
		const err = renderToolSummary("shell", { command: "npm test" }, { content: "exit 1", isError: true });
		expect(err.startsWith(`${COLOR_ON.red}✗${COLOR_ON.reset}`)).toBe(true);
		expect(renderEvent({ seq: 0, type: "user_input", content: "hi" }).text).toBe(`${COLOR_ON.blue}you> hi${COLOR_ON.reset}\n`);
	});

	it("the decorative accents are gone — the call line, verdicts, ok, and done are plain", () => {
		setNoColor(false);
		setTTY(true);
		expect(renderEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "list_dir", input: {} }).text).toBe("→ list_dir({})\n");
		expect(
			renderEvent({ seq: 0, type: "tool_execution_succeeded", callId: "c1", executionId: "e1", result: { content: "ok", isError: false } }).text,
		).toBe("  ok\n");
		expect(renderEvent({ seq: 0, type: "permission_decided", decisionId: "d", callId: "c", decision: "approved" }).text).toBe("  approved\n");
		expect(renderEvent({ seq: 0, type: "terminal", outcome: { kind: "completed" } }).text).toBe("\ndone\n");
	});

	it("error states stay red — ✗ marks, failed executions, terminal errors", () => {
		setNoColor(false);
		setTTY(true);
		expect(
			renderEvent({ seq: 0, type: "tool_execution_failed", callId: "c1", executionId: "e1", error: "boom", safeToRetry: true }).text,
		).toBe(`${COLOR_ON.red}  failed: boom${COLOR_ON.reset}\n`);
		expect(renderEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "unknown", retryable: false, message: "nope" } } }).text).toBe(
			`\n${COLOR_ON.red}error${COLOR_ON.reset}: nope\n`,
		);
	});
});

describe("v2a: the rhythm — 渲染序列→期望字节", () => {
	it("one turn's exact bytes: the summary hugs the result, the status hugs done, one blank, then the prompt", () => {
		setNoColor(false);
		setTTY(true);
		const events: Array<import("@vincemakes/kiso-core").Event> = [
			{ seq: 0, type: "thinking", text: "Let me look" },
			{ seq: 1, type: "text_delta", text: "I see the workspace." },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
			{ seq: 3, type: "tool_execution_started", callId: "c1", executionId: "e1", name: "list_dir", input: {} },
			{ seq: 4, type: "tool_execution_succeeded", callId: "c1", executionId: "e1", result: { content: "ok", isError: false } },
			{ seq: 5, type: "tool_result", callId: "c1", content: "…entries…", isError: false },
			{ seq: 6, type: "terminal", outcome: { kind: "completed" } },
		];
		// The consumer's exact composition: the thinking block closes with a
		// newline at the next non-thinking event; the summary line is printed
		// per tool_result; the gap follows the terminal. (The interactive
		// echo filter skips the turn's own user_input — the sequence starts
		// at the model's first output.)
		let bytes = "";
		let thinkingOpen = false;
		for (const ev of events) {
			const prevThinking = thinkingOpen;
			thinkingOpen = ev.type === "thinking";
			if (prevThinking && !thinkingOpen) bytes += "\n";
			if (ev.type === "tool_result") {
				bytes += `${renderToolSummary("list_dir", { path: "notes" }, { content: "…entries…", isError: false })}\n`;
			}
			bytes += renderEvent(ev).text;
			if (ev.type === "terminal") {
				bytes += renderTerminalGap(renderStatusLine(1, { in: null, out: null, cache: null, known: false }, 0, true));
			}
		}
		const expected =
			`${COLOR_ON.dim}…Let me look${COLOR_ON.reset}` + // thinking streams, no newline
			"\n" + // the consumer closes the thinking segment
			"I see the workspace." + // text continues the line
			"→ list_dir({})\n" +
			`${COLOR_ON.dim}  running…${COLOR_ON.reset}\n` +
			"  ok\n" +
			`${COLOR_ON.blue}✓${COLOR_ON.reset} list_dir notes\n` + // summary hugs the result
			`${COLOR_ON.dim}${COLOR_ON.dim}  [result] …entries…${COLOR_ON.reset}\n` +
			"\ndone\n" + // the terminal render
			"[turn 1 · faux]\n\n"; // the status hugs done, then EXACTLY one blank
		expect(bytes).toBe(expected);
	});
});
