/**
 * RD1B-F9a — the collision path, forced.
 *
 * The id's safety does not rest on entropy. A 16-bit suffix collides at
 * script rates — measured, not modelled: 100 draws inside one second carry
 * a 7.3% chance of at least one collision, and 1,000 produce a handful
 * every time. The first version of this fix shipped a doc comment calling
 * that "collision-safe at any launch rate a human or a script produces",
 * which was an unmeasured claim and false.
 *
 * What makes the id safe is that `newSessionId` is handed the sessions
 * directory and will not return an id already spoken for. This forces that
 * path with an injected random source, because waiting for a 1-in-65,536
 * event to happen naturally is not a test.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSessionId } from "../src/session-id.js";

const AT = new Date("2026-08-25T02:38:18Z");
const dir = (): string => mkdtempSync(join(tmpdir(), "kiso-f9a-"));

describe("RD1B-F9a — a drawn id that is already taken is not returned", () => {
	it("redraws past an existing durable log", () => {
		const d = dir();
		writeFileSync(join(d, "2026-08-25T02-38-18-aaaa.jsonl"), "");
		const draws = ["aaaa", "aaaa", "bbbb"];
		let i = 0;
		expect(newSessionId(d, AT, () => draws[i++]!)).toBe("2026-08-25T02-38-18-bbbb");
		expect(i, "it must have redrawn past both collisions").toBe(3);
	});

	it("redraws past a lock held by a session that has not appended yet", () => {
		const d = dir();
		writeFileSync(join(d, "2026-08-25T02-38-18-cccc.lock"), "");
		const draws = ["cccc", "dddd"];
		let i = 0;
		expect(newSessionId(d, AT, () => draws[i++]!)).toBe("2026-08-25T02-38-18-dddd");
	});

	it("fails loudly rather than returning a colliding id", () => {
		const d = dir();
		writeFileSync(join(d, "2026-08-25T02-38-18-eeee.jsonl"), "");
		expect(() => newSessionId(d, AT, () => "eeee")).toThrow(/could not draw an unused session id/);
	});

	it("stays 24 characters — the session picker's id column cap", () => {
		expect(newSessionId(dir(), AT).length).toBe(24);
	});

	it("lexicographic order is still time order", () => {
		const d = dir();
		const early = newSessionId(d, new Date("2026-08-25T02:38:18Z"));
		const late = newSessionId(d, new Date("2026-08-25T02:39:01Z"));
		expect([late, early].sort()[0]).toBe(early);
		// and an old minute-granular id still sorts before same-minute new ones
		expect(["2026-08-25T02-38", early].sort()[0]).toBe("2026-08-25T02-38");
	});
});
