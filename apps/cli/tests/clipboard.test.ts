import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImages } from "../src/attachments.js";
import { clipboardImage } from "../src/clipboard.js";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kiso-clip-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The clipboard route. The runner is INJECTED so these cases test the
 * decision logic rather than macOS: what counts as a usable image, and
 * what happens on each way the read can fail. The one thing they cannot
 * test is whether the coercion works inside a real terminal session —
 * that is the finding's open question and it needs a machine, not a
 * mock.
 */
describe("REL-0152-D11 — the clipboard route decides honestly", () => {
	const ok = (): { status: number | null } => ({ status: 0 });
	const fail = (): { status: number | null } => ({ status: 1 });

	it("returns null when osascript fails — a failed read is not an image", () => {
		expect(clipboardImage(dir, fail)).toBeNull();
	});

	it("returns null when the coercion 'succeeded' but wrote nothing", () => {
		// the exact shape this round already produced once: exit 0 in some
		// shells, a zero-byte file, and a caller that believed it
		expect(clipboardImage(dir, ok)).toBeNull();
	});

	it("returns null when the file is not an image by its BYTES", () => {
		const runner = (_c: string, args: readonly string[]): { status: number | null } => {
			const target = JSON.parse(args.find((a) => a.includes("POSIX file "))!.split("POSIX file ")[1]!.split(" with write")[0]!) as string;
			writeFileSync(target, "not an image at all");
			return { status: 0 };
		};
		expect(clipboardImage(dir, runner)).toBeNull();
	});

	it("returns the path when a real PNG lands, and the path attaches", () => {
		const runner = (_c: string, args: readonly string[]): { status: number | null } => {
			const target = JSON.parse(args.find((a) => a.includes("POSIX file "))!.split("POSIX file ")[1]!.split(" with write")[0]!) as string;
			writeFileSync(target, PNG_BYTES);
			return { status: 0 };
		};
		const path = clipboardImage(dir, runner);
		expect(path).not.toBeNull();
		// the whole point of returning a PATH: the existing scan takes it
		const blocks = attachImages(`what is this? ${path}`) as unknown as { type: string }[];
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
	});
});
