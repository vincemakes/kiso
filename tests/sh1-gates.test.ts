/**
 * SH-1 — the two gates' own matrix (red before green).
 *
 * The round's one sentence: a red must be directly believable — the
 * gates below make the test partition structural (resource-dependency
 * closure, not import-string luck) and make control bytes impossible
 * to smuggle (raw Buffer, not UTF-8 decode — the NUL that hid from
 * every text gate since before 0.13.0 is the standing exhibit).
 */

import { describe, expect, it } from "vitest";
import { scanBytes } from "../scripts/check-bytes.mjs";
import { classifyTestSource, verifyPartition } from "../scripts/check-pty-manifest.mjs";

describe("SH-1 ① — check-bytes: raw-buffer control-byte scanning", () => {
	it("a NUL is red, NAMING the offset", () => {
		const hits = scanBytes(Buffer.from("hello\x00world"));
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ byte: 0x00, offset: 5 });
	});

	it("DEL (0x7f) and raw CR (0x0d) are red too — a control-byte gate does not skip DEL", () => {
		expect(scanBytes(Buffer.from("a\x7fb"))).toHaveLength(1);
		expect(scanBytes(Buffer.from("a\rb"))).toHaveLength(1);
	});

	it("tab and LF are the two blessed control bytes; plain UTF-8 text is green", () => {
		expect(scanBytes(Buffer.from("a\tb\ncafé — ✓ ⊔ ∅\n"))).toHaveLength(0);
	});

	it("every C0 byte outside tab/LF is caught (the sweep, not a sample)", () => {
		for (let b = 0; b < 0x20; b += 1) {
			if (b === 0x09 || b === 0x0a) continue;
			expect(scanBytes(Buffer.from([0x61, b, 0x62])), `byte 0x${b.toString(16)}`).toHaveLength(1);
		}
	});
});

describe("SH-1 ② — the resource-dependency classifier (the 16-file helper gap is the standing exhibit)", () => {
	it("a direct spawner classifies as resource", () => {
		expect(classifyTestSource('import { execFileSync } from "node:child_process";\nexecFileSync("python3", []);')).toBe(true);
		expect(classifyTestSource('import { spawn } from "node:child_process";')).toBe(true);
	});

	it("a helper-only test classifies as resource — the transitive gap the v1 grep missed", () => {
		expect(classifyTestSource('import { fauxScript, ptyRun } from "./helpers/pty.js";')).toBe(true);
		expect(classifyTestSource('import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";')).toBe(true);
	});

	it("an inline PTY driver classifies as resource (pty.fork inside an embedded python driver)", () => {
		expect(classifyTestSource('const PTY_DRIVER = `\nimport pty\npid, fd = pty.fork()\n`;')).toBe(true);
	});

	it("a plain unit test does not classify", () => {
		expect(classifyTestSource('import { describe, it } from "vitest";\nimport { foo } from "../src/foo.js";')).toBe(false);
	});
});

describe("SH-1 ③ — the partition invariant: ALL = UNIT ⊔ PTY, no ghosts, no leaks", () => {
	const discovered = ["a.test.ts", "b.test.ts", "c.test.ts"];

	it("a clean partition verifies", () => {
		expect(verifyPartition({ discovered, pty: ["b.test.ts"], resourceClassified: ["b.test.ts"] })).toEqual([]);
	});

	it("a classified resource file MISSING from the pty pool is named", () => {
		const errs = verifyPartition({ discovered, pty: [], resourceClassified: ["b.test.ts"] });
		expect(errs.join(" ")).toContain("b.test.ts");
	});

	it("a ghost manifest entry (file does not exist) is named", () => {
		const errs = verifyPartition({ discovered, pty: ["zz.test.ts"], resourceClassified: [] });
		expect(errs.join(" ")).toContain("zz.test.ts");
	});

	it("a duplicate across pools is impossible by construction, and the checker still says so if handed one", () => {
		const errs = verifyPartition({ discovered, pty: ["a.test.ts", "a.test.ts"], resourceClassified: ["a.test.ts"] });
		expect(errs.length).toBeGreaterThan(0);
	});
});
