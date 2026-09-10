/**
 * DC-60 (0.32.2) — a sent turn that carries an image still echoes its words.
 *
 * The owner's 0.32.1 dogfood: paste a screenshot (a `[Image #1]` capsule),
 * send — and the user chip showed a bar with nothing on it. The durable
 * content of such a turn is an ARRAY (text blocks and an image block); the
 * live echo passed only a string through and an array became "". The
 * transcript path already projected the same array to words with an
 * "(image)" mark; the live echo did not, and two projections of one thing
 * is how they came to differ. One definition now: `echoText`.
 */
import { describe, expect, it } from "vitest";
import { echoText } from "../src/render.js";

describe("DC-60 — echoText projects a turn's content to its words", () => {
	it("a string is itself", () => {
		expect(echoText("look at this")).toBe("look at this");
	});
	it("text blocks around an image block keep their words, the image is a mark", () => {
		expect(echoText([{ type: "text", text: "look at" }, { type: "image" }, { type: "text", text: "please" }])).toBe("look at (image) please");
	});
	it("an image alone is the mark, never an empty echo", () => {
		expect(echoText([{ type: "image" }])).toBe("(image)");
	});
});
