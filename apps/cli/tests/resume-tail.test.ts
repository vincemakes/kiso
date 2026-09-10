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

/**
 * R7b — an image-bearing turn does not vanish from the resumed tail.
 *
 * The tail kept only STRING `user_input`, so a turn carrying an image was
 * skipped entirely — and skipping an ASK does not just lose that ask: the
 * reply that followed it attached to the PREVIOUS one. A resumed session
 * showed an answer under a question it did not answer, which is worse
 * than showing nothing.
 *
 * The same shape as R7 at the title, and the same fix in the other
 * direction: the CLI may depend on tui-cells, so the tail uses the live
 * echo's own projection (`echoText`) rather than a second one. The
 * RUNTIME keeps its own `contentText` because it cannot depend on
 * tui-cells — two implementations, one direction each, and they agree on
 * "(image)".
 */
describe("R7b — an image-bearing ask in the resumed tail", () => {
	it("the ask appears with its image marked, and keeps its own reply", () => {
		const out = resumeTail([
			rec({ type: "user_input", content: "the first question" }),
			rec({ type: "text_delta", text: "the first answer" }),
			rec({
				type: "user_input",
				content: [
					{ type: "text", text: "what is wrong here?" },
					{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" },
				],
			}),
			rec({ type: "text_delta", text: "the second answer" }),
		] as never, 80);
		const text = out.join("\n");
		expect(text, "the image-bearing ask is on screen").toContain("what is wrong here? (image)");
		expect(text, "and so is its own reply").toContain("the second answer");
		// the pairing is the point: the second answer must not have drifted
		// up under the first question
		expect(text.indexOf("the second answer"), "the reply follows ITS ask").toBeGreaterThan(text.indexOf("what is wrong here?"));
	});

	it("an image-ONLY ask still appears", () => {
		const out = resumeTail([
			rec({ type: "user_input", content: [{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" }] }),
			rec({ type: "text_delta", text: "an answer about the picture" }),
		] as never, 80);
		const text = out.join("\n");
		expect(text).toContain("(image)");
		expect(text).toContain("an answer about the picture");
	});
});
