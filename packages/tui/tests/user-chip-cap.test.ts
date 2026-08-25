/**
 * REL-0152-D13 — a submitted paste stops writing its whole self to the
 * terminal.
 *
 * REL-0152-D9 made the editor linear: a paste costs 6ms at 146KB. The
 * owner still reported slowness, and the next bottleneck was measured
 * rather than assumed — it is not compute, it is VOLUME. Submitting a
 * 3000-line paste took kiso 10ms and wrote 260,298 bytes to the
 * terminal in ONE frame. kiso is done in ten milliseconds and the
 * terminal then has a quarter of a megabyte to lay out, on a renderer
 * REL-0150-D3 already established is the weak link.
 *
 * The D8 capsule was already the right idea and it stopped at the
 * composer. A paste is a capsule while you edit it and then expands to
 * its full self in the transcript — the one place it helps least, since
 * it is text the user already has and showing all of it scrolls away
 * everything they wanted to look at.
 *
 * So the chip is bounded. What the MODEL receives is untouched: the
 * capsule is a display form, here as in the composer, and the text that
 * was sent is the text that was sent. The notice says where the rest is
 * rather than pretending there is no rest.
 */

import { describe, expect, it } from "vitest";
import { cellComponent } from "@vincemakes/kiso-tui-cells/components";

const ctx = { spinnerI: 0, now: 0, height: 24 };
const render = (text: string, W = 80): string[] =>
	cellComponent({ kind: "user", text, done: true, turn: 0 } as never).render(W, ctx as never);
const plain = (rows: string[]): string => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("REL-0152-D13 — the user chip is bounded", () => {
	it("a short turn is untouched — every line of it is a chip row", () => {
		const rows = render("first line\nsecond line\nthird line");
		expect(rows).toHaveLength(3);
		expect(plain(rows)).toContain("second line");
		expect(plain(rows)).not.toContain("more lines");
	});

	it("a 3000-line paste renders a bounded chip, not 3000 rows", () => {
		const rows = render(Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));
		expect(rows.length, `the chip rendered ${rows.length} rows`).toBeLessThanOrEqual(13);
		expect(plain(rows)).toContain("line 0"); // the head is what you sent
	});

	it("the notice says how much is not shown, and that the turn kept it", () => {
		const rows = render(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
		const text = plain(rows);
		expect(text).toMatch(/\+\d+ more lines/);
		expect(text).toContain("sent in full");
	});

	it("the bound is on ROWS, so one enormous line folds and is capped too", () => {
		const rows = render("x".repeat(20_000));
		expect(rows.length).toBeLessThanOrEqual(13);
	});

	it("the frame a 3000-line turn writes is small enough to be laid out", async () => {
		const { Body } = await import("../src/compositor.js");
		let bytes = 0;
		const body = new Body({ active: () => true, height: () => 40, width: () => 120, editCol: () => 1, write: (s) => { bytes += s.length; } });
		body.enter();
		body.render();
		bytes = 0;
		body.userLine(Array.from({ length: 3000 }, (_, i) => `line ${i} of the pasted file with a fair amount of content on it`).join("\n"));
		body.render();
		// it was 260,298 — the gate is on the ORDER of magnitude, not a
		// byte count that would flake on a chrome tweak
		expect(bytes, `the turn wrote ${bytes} bytes`).toBeLessThan(20_000);
	});
});
