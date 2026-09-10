/**
 * R7 — a session whose first turn carried an IMAGE has a title.
 *
 * `sessionTitle` kept only string `content`, so a turn carrying a content
 * ARRAY — which is what a turn with an image is — was filtered out
 * entirely and the session was titled "(no prompt)". The resume picker
 * then offered a row that identifies nothing, for exactly the sessions a
 * human is most likely to recognise by what they showed it.
 *
 * Projected in the RUNTIME, with no dependency on the TUI packages: the
 * dependency runs one way, and a store that reached into the renderer to
 * name a session would invert it. HF-2's one-row label rule still applies
 * to the result — the projection happens first, the flattening after.
 */
import { describe, expect, it } from "vitest";
import { sessionTitle } from "../src/internal.js";

const rec = (content: unknown): { event: { type: string; content: unknown } } => ({ event: { type: "user_input", content } });

describe("R7 — an image-bearing first turn is titled", () => {
	it("image ONLY: the title names the image rather than claiming no prompt", () => {
		const title = sessionTitle([rec([{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" }])] as never);
		expect(title).toBe("(image)");
	});

	it("image AND text: the words are the title, the image marked in place", () => {
		const title = sessionTitle([
			rec([
				{ type: "text", text: "what is wrong here?" },
				{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" },
			]),
		] as never);
		expect(title).toBe("what is wrong here? (image)");
	});

	it("a greeting THEN an image: the opener is skipped, as for text", () => {
		const title = sessionTitle([
			rec("hi"),
			rec([
				{ type: "text", text: "look at this failure" },
				{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" },
			]),
		] as never);
		expect(title).toBe("look at this failure (image)");
	});

	it("HF-2 still holds: the projected title is ONE row", () => {
		const title = sessionTitle([rec([{ type: "text", text: "line one\nline two\ttabbed" }, { type: "image", sourceType: "base64", mediaType: "image/png", data: "A" }])] as never);
		expect(title).toBe("line one line two tabbed (image)");
		expect(title).not.toMatch(/[\r\n\t]/);
	});

	it("a string turn is unchanged", () => {
		expect(sessionTitle([rec("an ordinary first prompt")] as never)).toBe("an ordinary first prompt");
		expect(sessionTitle([])).toBe("(no prompt)");
	});
});
