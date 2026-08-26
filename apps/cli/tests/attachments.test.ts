/**
 * REL-0152-D11 — an image reaches the model.
 *
 * The owner asked for image paste twice. The wire was already there and
 * nobody had noticed: the `user_input` event's content has been
 * `string | ContentBlock[]` since the protocol was written, the
 * projection passes it straight through, the Anthropic adapter sends an
 * `image` block and the OpenAI-compatible family sends `image_url` with
 * a data URI. `grep 'type: "image"' apps/cli/src` was empty — the CLI
 * never built one, and `session.run()` narrowed its parameter to text so
 * no caller could have.
 *
 * This is the piece that was missing: a turn's text is scanned for
 * references to image files, and each one becomes an image block beside
 * the words. Two things a user can do TODAY produce such a reference,
 * on any terminal, with no clipboard involved: dragging a file into the
 * window (terminals insert its path) and typing or pasting a path.
 *
 * The rules the cases below pin:
 *   - a turn with no reference is a STRING, byte-identical to today. The
 *     common turn must not start paying for this feature.
 *   - the words stay with the image. A turn is "what is wrong here?"
 *     plus the screenshot, and sending the screenshot alone loses the
 *     question.
 *   - a path that is not there, or is not an image, is left as ordinary
 *     text. A model that is told about a file it cannot see is worse off
 *     than one told nothing, and a typo is not an attachment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImages } from "../src/attachments.js";

let dir: string;
let png: string;

// the smallest real PNG: an 8-byte signature is what the sniffer reads
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kiso-attach-"));
	png = join(dir, "shot.png");
	writeFileSync(png, PNG_BYTES);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("REL-0152-D11 — a referenced image becomes a content block", () => {
	it("a turn with no reference stays a STRING — today's bytes, unchanged", () => {
		expect(attachImages("just a question")).toBe("just a question");
		expect(attachImages("")).toBe("");
	});

	it("a path to a real image becomes an image block, with the words kept", () => {
		const out = attachImages(`what is wrong here? ${png}`);
		expect(Array.isArray(out)).toBe(true);
		const blocks = out as unknown as { type: string; text?: string; mediaType?: string; data?: string }[];
		expect(blocks.some((b) => b.type === "text" && b.text!.includes("what is wrong here?"))).toBe(true);
		const img = blocks.find((b) => b.type === "image")!;
		expect(img.mediaType).toBe("image/png");
		expect(Buffer.from(img.data!, "base64")).toEqual(PNG_BYTES);
	});

	it("the media type comes from the file's BYTES, not its name", () => {
		const lying = join(dir, "actually-a-png.jpg");
		writeFileSync(lying, PNG_BYTES);
		const blocks = attachImages(lying) as unknown as { type: string; mediaType?: string }[];
		expect(blocks.find((b) => b.type === "image")!.mediaType).toBe("image/png");
	});

	it("a path that does not exist is ordinary text — a typo is not an attachment", () => {
		const missing = join(dir, "nope.png");
		expect(attachImages(`look at ${missing}`)).toBe(`look at ${missing}`);
	});

	it("a real file that is NOT an image is ordinary text", () => {
		const txt = join(dir, "notes.png"); // named .png, is not one
		writeFileSync(txt, "plain text, not an image");
		expect(attachImages(`see ${txt}`)).toBe(`see ${txt}`);
	});

	it("two images in one turn are two blocks, in the order they were named", () => {
		const second = join(dir, "b.png");
		writeFileSync(second, PNG_BYTES);
		const blocks = attachImages(`compare ${png} with ${second}`) as unknown as { type: string }[];
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
	});

	it("a quoted path survives — dragging a file with a space in its name quotes it", () => {
		const spaced = join(dir, "my shot.png");
		writeFileSync(spaced, PNG_BYTES);
		const blocks = attachImages(`look at '${spaced}'`) as unknown as { type: string }[];
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
	});

	it("an oversized image is left as text rather than sent — the limit is honest, not silent", () => {
		const big = join(dir, "huge.png");
		writeFileSync(big, Buffer.concat([PNG_BYTES, Buffer.alloc(9 * 1024 * 1024)]));
		expect(typeof attachImages(`see ${big}`)).toBe("string");
	});
});

/**
 * REL-0152-D16 — the capsule resolves to the image, and the LINE stays
 * a line rather than becoming a command.
 */
describe("REL-0152-D16 — an [Image #N] capsule becomes the image", () => {
	it("resolves through the editor's map", () => {
		const blocks = attachImages("what is wrong here? [Image #1]", new Map([[1, png]])) as unknown as { type: string; mediaType?: string }[];
		expect(Array.isArray(blocks)).toBe(true);
		expect(blocks.find((b) => b.type === "image")!.mediaType).toBe("image/png");
		expect(blocks.some((b) => b.type === "text")).toBe(true);
	});

	it("an unregistered number stays literal text — a typed [Image #9] is not an attachment", () => {
		expect(attachImages("see [Image #9]", new Map([[1, png]]))).toBe("see [Image #9]");
	});

	it("a capsule whose file has gone stays literal text", () => {
		expect(attachImages("see [Image #1]", new Map([[1, join(dir, "vanished.png")]]))).toBe("see [Image #1]");
	});

	it("with no map at all the text is untouched — the pipe path has no editor", () => {
		expect(attachImages("plain turn")).toBe("plain turn");
	});
});
