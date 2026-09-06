/**
 * S3 D-1 — the transcript viewer's cut rows follow cutLine's convention:
 * the ellipsis rides AFTER the reset.
 *
 * The viewer's own cutter put it before, so a row cut inside a dim span
 * ended `…\x1b[0m` — the mark wearing the span's colour, which is the
 * one thing the post-reset convention (the PTY needles') exists to
 * prevent. Red on the old cutter: the two `endsWith` assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import { COLOR_ON } from "../src/lines.js";
import { viewerInit, viewerRows, type ViewerEntry } from "../src/transcript.js";

beforeEach(() => {
	delete process.env.NO_COLOR; // the palette must be ON — this asserts SGR bytes
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("S3 D-1 — a viewer row cut inside a colour span", () => {
	it("ends with the reset and THEN the ellipsis, and never exceeds W", () => {
		const head = `${COLOR_ON.dim}${"word ".repeat(30).trim()}${COLOR_ON.reset}`;
		const entries: ViewerEntry[] = [{ head, body: [] }];
		const W = 40;
		const rows = viewerRows(entries, viewerInit(entries), W, 10);
		const row = rows.find((r) => r.includes("word"));
		expect(row).toBeDefined();
		expect(row!.endsWith(`${COLOR_ON.reset}…`)).toBe(true);
		expect(row!.endsWith(`…${COLOR_ON.reset}`)).toBe(false);
		expect(visibleWidth(row!)).toBeLessThanOrEqual(W);
	});

	it("a row that fits is passed through whole — no mark, no reset added", () => {
		const head = `${COLOR_ON.dim}short${COLOR_ON.reset}`;
		const entries: ViewerEntry[] = [{ head, body: [] }];
		const rows = viewerRows(entries, viewerInit(entries), 40, 10);
		const row = rows.find((r) => r.includes("short"));
		expect(row).toBeDefined();
		expect(row!.endsWith(`short${COLOR_ON.reset}`)).toBe(true);
		expect(row!.includes("…")).toBe(false);
	});
});
