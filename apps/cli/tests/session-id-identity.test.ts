/**
 * The session ID is minute-granular with no entropy.
 *
 *   new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)
 *   → "2026-08-25T02-11"
 *
 * and SessionStore is one file per ID (`packages/runtime/src/store.ts:132`).
 * So two sessions STARTED IN THE SAME MINUTE are the same session: the
 * second one silently inherits the first one's durable history.
 *
 * WHAT THIS IS NOT. It is not a concurrency bug. The store holds a
 * single-writer link lock (ADR-0050) and `storage.test.ts` already pins
 * that "a second writer cannot append while the first holds the lock" —
 * two SIMULTANEOUS writers fail loudly and correctly. An earlier
 * write-up called this "concurrent kiso -p silently merges histories",
 * which is wrong and would have sent the fix at the lock.
 *
 * The defect is IDENTITY ALIASING between sequential runs, and for a
 * product whose promise is durable sessions, an ID that silently names
 * someone else's history is a durability defect, not a cosmetic one.
 *
 * TIMING HONESTY. The two launches must land in the same wall-clock
 * minute for the aliasing to be observable. If they straddle a minute
 * boundary the run proves nothing — so this checks the boundary and
 * retries, and FAILS LOUDLY rather than passing when it could not
 * observe. A test that goes green because it missed its window is worse
 * than one that goes red.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

/** The minute the ID generator would stamp right now. */
const minuteNow = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

function twoSequentialSessions(): { ids: string[]; inputs: Record<string, string[]>; straddled: boolean } {
	const { env, dirs } = isolatedEnv();
	const before = minuteNow();
	for (const n of [1, 2]) {
		runCli(["chat"], { ...env, KISO_MODE: "bypass" }, { input: `turn from session ${n}\nexit\n`, timeout: 60_000 });
	}
	const straddled = minuteNow() !== before;
	const dir = join(dirs.home, "sessions");
	const ids = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();
	const inputs: Record<string, string[]> = {};
	for (const f of ids) {
		inputs[f] = readFileSync(join(dir, f), "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as { event: { type: string; content?: string } })
			.filter((r) => r.event.type === "user_input")
			.map((r) => r.event.content ?? "");
	}
	return { ids, inputs, straddled };
}

describe("session identity — two sequential `kiso chat` runs are two sessions", () => {
	it("each launch gets its own durable log", () => {
		let run = twoSequentialSessions();
		if (run.straddled) run = twoSequentialSessions(); // one retry for the boundary
		expect(run.straddled, "both attempts straddled a minute boundary — the window was never observed, so this proves nothing").toBe(false);

		expect(run.ids, `two launches produced ${run.ids.length} durable log(s): ${run.ids.join(", ")}`).toHaveLength(2);
		for (const [file, seen] of Object.entries(run.inputs)) {
			expect(seen, `${file} carries input from more than one launch`).toHaveLength(1);
		}
	}, 180_000);
});
