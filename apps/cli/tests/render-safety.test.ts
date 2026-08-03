/**
 * E 组 — terminal safety: ESC, C0/C1 control characters, CR, backspace,
 * and bidi overrides must never reach the terminal from model/tool text.
 */

import { describe, expect, it } from "vitest";
import { canonicalPath, renderEvent, renderSessionLine } from "../src/render.js";

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
