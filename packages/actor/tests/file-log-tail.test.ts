/**
 * ADR-0064 § 2.3 / review R9: the CAS reads the FILE on every append, but only
 * its last line, so a long log does not make the read slower.
 */
import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastCommittedSeq, repairTornTail } from "../src/file-tail.js";

const PAD = "x".repeat(4000);

function log(lines: number, tail = ""): number {
	const path = join(mkdtempSync(join(tmpdir(), "kiso-actor-tail-")), "x.jsonl");
	const body = Array.from({ length: lines }, (_, seq) => JSON.stringify({ seq, ts: 0, event: { pad: PAD } })).join("\n");
	writeFileSync(path, `${body}\n${tail}`);
	return openSync(path, "r+");
}

function medianMs(fd: number): number {
	const times: number[] = [];
	for (let i = 0; i < 31; i++) {
		const t0 = performance.now();
		lastCommittedSeq("x", fd);
		times.push(performance.now() - t0);
	}
	return times.sort((a, b) => a - b)[15]!;
}

describe("the CAS read is the last line, not the file", () => {
	it("reads the last committed seq of a 10,000-line (40 MB) log as fast as a 10-line one", () => {
		const small = log(10);
		const large = log(10_000);
		expect(lastCommittedSeq("x", large)).toBe(9_999);
		expect(medianMs(large)).toBeLessThan(medianMs(small) * 5 + 1);
		closeSync(small);
		closeSync(large);
	});

	it("repairs a torn tail on a long log back to the last committed line", () => {
		const fd = log(10_000, '{"seq":10000,"ts":0,"ev');
		repairTornTail(fd);
		expect(lastCommittedSeq("x", fd)).toBe(9_999);
		closeSync(fd);
	});
});
