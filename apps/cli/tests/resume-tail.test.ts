import { describe, expect, it } from "vitest";
import { resumeTail } from "../src/resume-tail.js";

const rec = (event: Record<string, unknown>): Record<string, unknown> => event;

describe("REL-0152-D5 — a resumed session shows where you were", () => {
	it("shows the last turns, question and reply, in conversation order", () => {
		const out = resumeTail([
			rec({ type: "user_input", content: "first question" }),
			rec({ type: "text_delta", text: "first answer" }),
			rec({ type: "user_input", content: "second question" }),
			rec({ type: "text_delta", text: "second " }),
			rec({ type: "text_delta", text: "answer" }),
		] as never);
		expect(out.join("\n")).toContain("first question");
		expect(out.join("\n")).toContain("second answer");
		expect(out.join("\n")).toMatch(/first question[\s\S]*second question/);
	});

	it("names an interrupted turn rather than printing a blank", () => {
		const out = resumeTail([rec({ type: "user_input", content: "do the thing" })] as never);
		expect(out.join("\n")).toContain("no reply recorded");
	});

	it("says how much it is not showing", () => {
		const many = Array.from({ length: 6 }, (_, i) => [rec({ type: "user_input", content: `q${i}` }), rec({ type: "text_delta", text: `a${i}` })]).flat();
		expect(resumeTail(many as never)[0]).toContain("showing the last 2");
	});

	it("is empty for an empty session, so the caller prints nothing", () => {
		expect(resumeTail([])).toEqual([]);
	});

	it("collapses newlines so a long reply cannot flood the prompt", () => {
		const out = resumeTail([rec({ type: "user_input", content: "q" }), rec({ type: "text_delta", text: "a\n".repeat(200) })] as never);
		expect(out.every((l) => !l.includes("\n"))).toBe(true);
		expect(out.join("").length).toBeLessThan(700);
	});
});
