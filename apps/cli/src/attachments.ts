/**
 * REL-0152-D11 — an image reaches the model.
 *
 * The wire was already complete and nobody had noticed. The `user_input`
 * event's content has been `string | ContentBlock[]` since the protocol
 * was written; the projection passes it through untouched; the Anthropic
 * adapter sends an `image` block and the OpenAI-compatible family sends
 * `image_url` with a data URI. What was missing was at the two ends:
 * `session.run()` narrowed its parameter to text, and the CLI never
 * built a block — `grep 'type: "image"' apps/cli/src` came back empty.
 *
 * This module is the CLI end. A turn's text is scanned for references to
 * image files and each one becomes an image block beside the words.
 *
 * The reference is a PATH, deliberately, because two things a user can
 * already do produce one on any terminal with no clipboard involved:
 * dragging a file into the window, which terminals answer by inserting
 * its path, and typing or pasting a path. Clipboard image paste is a
 * separate mechanism with a separate open question (see the finding);
 * this one works today, everywhere, and is what that mechanism will
 * hand its temp file to when it lands.
 */

import { readFileSync, statSync } from "node:fs";
import type { ContentBlock } from "@vincemakes/kiso-core";

/**
 * The size a single image may reach before it is refused.
 *
 * Providers cap image payloads and base64 inflates by a third, so a file
 * near this bound is already near theirs. The refusal is deliberate and
 * VISIBLE: the path stays in the text, so the model is told a file was
 * named rather than being handed a request that the provider will reject
 * with something the user cannot act on.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The four media types the protocol accepts, recognised by the file's
 *  own leading bytes. A name is a claim; the bytes are the fact, and a
 *  screenshot saved as `.jpg` is a very ordinary thing to have. */
export function sniff(buf: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
	if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

/**
 * Path-shaped runs in a line, longest first so a quoted path wins over
 * the bare fragment inside it. Quoted forms come first because that is
 * what a terminal inserts for a name containing a space.
 */
const CANDIDATES = [
	/'([^']*\.(?:png|jpe?g|gif|webp))'/gi,
	/"([^"]*\.(?:png|jpe?g|gif|webp))"/gi,
	/(\S*\.(?:png|jpe?g|gif|webp))/gi,
];

/** One candidate that turned out to be a real, readable, in-bounds
 *  image: where it sat in the line, and what it holds. */
interface Found {
	readonly start: number;
	readonly end: number;
	readonly block: ContentBlock;
}

function look(path: string): { mediaType: ReturnType<typeof sniff>; data: string } | null {
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) return null;
		const buf = readFileSync(path);
		const mediaType = sniff(buf);
		if (mediaType === null) return null;
		return { mediaType, data: buf.toString("base64") };
	} catch {
		return null; // not there, not readable, not ours to complain about
	}
}

/**
 * The turn's content: the string itself when nothing was attached, or
 * the blocks when something was.
 *
 * Returning the STRING unchanged in the common case is not an
 * optimisation, it is the compatibility guarantee: a turn with no image
 * produces exactly the bytes it produced before this module existed, so
 * every request that is not about an image is unaffected by the feature.
 *
 * A path that is not there, or is not an image, or is too large, is left
 * standing in the text. Silently dropping it would tell the model about
 * a file it cannot see, which is worse than telling it nothing.
 */
export function attachImages(text: string, files?: ReadonlyMap<number, string>): string | ContentBlock[] {
	const found: Found[] = [];
	const claimed: { start: number; end: number }[] = [];
	// REL-0152-D16: the `[Image #N]` capsules first. The buffer carries a
	// token and the editor carries the file, so a pasted screenshot never
	// puts a path in the line — which is what sent one to the slash-command
	// dispatcher. A capsule whose file has gone, or whose number nobody
	// registered, stays as literal text: the same rule the path route uses,
	// for the same reason.
	if (files !== undefined && files.size > 0) {
		for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
			const path = files.get(Number(m[1]));
			if (path === undefined) continue;
			const hit = look(path);
			if (hit === null) continue;
			claimed.push({ start: m.index!, end: m.index! + m[0].length });
			found.push({ start: m.index!, end: m.index! + m[0].length, block: { type: "image", sourceType: "base64", mediaType: hit.mediaType!, data: hit.data } });
		}
	}
	for (const re of CANDIDATES) {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) {
			const path = m[1]!;
			const start = m.index!;
			const end = start + m[0].length;
			if (claimed.some((c) => start < c.end && end > c.start)) continue;
			const hit = look(path);
			if (hit === null) continue;
			claimed.push({ start, end });
			found.push({ start, end, block: { type: "image", sourceType: "base64", mediaType: hit.mediaType!, data: hit.data } });
		}
	}
	if (found.length === 0) return text;
	found.sort((a, b) => a.start - b.start);
	// the words are kept and kept IN PLACE: a turn is "what is wrong
	// here?" plus the screenshot, and the question is half of it.
	const blocks: ContentBlock[] = [];
	let at = 0;
	for (const f of found) {
		const before = text.slice(at, f.start).trim();
		if (before !== "") blocks.push({ type: "text", text: before });
		blocks.push(f.block);
		at = f.end;
	}
	const tail = text.slice(at).trim();
	if (tail !== "") blocks.push({ type: "text", text: tail });
	return blocks;
}
