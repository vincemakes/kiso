/**
 * 手感批 A3 — the stderr ring: byte-capped at 4096, trimming never splits
 * a UTF-8 sequence (the tail always renders cleanly), multi-chunk appends
 * accumulate in order.
 */

import { describe, expect, it } from "vitest";
import { StderrRing } from "../src/index.js";

describe("A3: the stderr ring (tail 4KB, byte-safe)", () => {
	it("starts empty and accumulates appends in order", () => {
		const ring = new StderrRing();
		expect(ring.tail()).toBe("");
		ring.append("hello ");
		ring.append("world");
		expect(ring.tail()).toBe("hello world");
	});

	it("caps at 4096 BYTES, dropping from the head", () => {
		const ring = new StderrRing();
		ring.append("a".repeat(8192));
		expect(Buffer.byteLength(ring.tail())).toBe(4096);
		expect(ring.tail()).toBe("a".repeat(4096)); // the HEAD fell off, the tail kept
	});

	it("a trim never splits a multi-byte char — the tail starts on a boundary", () => {
		const ring = new StderrRing();
		// 你 = 3 bytes; 2047 of them (6141 bytes) + "xxx" crosses the cap
		// mid-character (the trim point lands inside a 你).
		ring.append("你".repeat(2047) + "xxx");
		const tail = ring.tail();
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
		expect(tail.startsWith("你")).toBe(true); // snapped to the char boundary
		expect(tail.endsWith("xxx")).toBe(true);
		expect(tail).not.toContain("�"); // no replacement chars — nothing split
	});

	it("interleaved small appends still honor the byte cap", () => {
		const ring = new StderrRing();
		for (let i = 0; i < 2000; i++) ring.append(`chunk-${i}\n`);
		const tail = ring.tail();
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
		expect(tail.endsWith("chunk-1999\n")).toBe(true);
		expect(tail).toContain("chunk-1998\n");
		// The kept region is a CONTIGUOUS suffix of the byte stream — chunks
		// never interleave or duplicate. (The head may hold a partial line;
		// full "chunk-" lines must still be consecutive.)
		const lines = tail.split("\n").filter((l) => l.startsWith("chunk-"));
		for (let i = 1; i < lines.length; i++) {
			expect(Number(lines[i]!.slice("chunk-".length))).toBe(Number(lines[i - 1]!.slice("chunk-".length)) + 1);
		}
	});
});
