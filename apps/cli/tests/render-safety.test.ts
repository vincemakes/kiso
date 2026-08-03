/**
 * E 组 — terminal safety: ESC, C0/C1 control characters, CR, backspace,
 * and bidi overrides must never reach the terminal from model/tool text.
 */

import { describe, expect, it } from "vitest";
import { renderEvent } from "../src/render.js";

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
});
