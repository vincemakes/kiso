/**
 * TUI2-R3v2 slice ③ — the safer-options arc on a real PTY.
 *
 * THE FAUX FIXTURE SHAPE, stated once because it is the thing that makes
 * these tests read strangely: the faux provider consumes ONE script turn
 * per adapter stream() call, and a side query IS an adapter call. So the
 * script for the full arc is:
 *
 *   turn 0  the assistant's turn that proposes the risky call
 *   turn 1  THE SIDE QUERY's answer (the JSON array) — consumed the
 *           moment option 3 is pressed, not by any user turn
 *   turn 2  the model's answer to the refusal: the amended call
 *   turn 3  the closing text
 *   + spares
 *
 * A script that forgets turn 1 hands the side query the AMENDED CALL's
 * turn, and everything after it shifts by one — which looks like a
 * product bug and is a fixture bug. The zero-ambient test below is the
 * other side of the same coin: a session that never presses 3 must NOT
 * consume turn 1, and it asserts exactly that.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, spares } from "./helpers/pty.js";

const RISKY = { type: "tool_call_end", callId: "r1", name: "shell", input: { command: "rm -rf build && npm run build" } };
const AMENDED = { type: "tool_call_end", callId: "r2", name: "shell", input: { command: "npm run build" } };

/** R3v2-F1: the fixture answers in the shape the prompt now ASKS for —
 *  the `alternatives` envelope with `reason` lines. A fixture that keeps
 *  answering in a shape the product no longer requests is a fixture that
 *  stops testing the live path; the bare array stays covered where it
 *  belongs, in the parser's own suite. */
const ALTERNATIVES = JSON.stringify({
	alternatives: [
		{ command: "npm run build", reason: "rebuild in place, keep build/" },
		{ command: "rm -rf build/cache && npm run build", reason: "only clear the cache" },
	],
});

/** Every request line in the session's trace sidecar. */
function requests(home: string): Record<string, unknown>[] {
	const dir = join(home, "sessions", "traces");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	return files.flatMap((f) =>
		readFileSync(join(dir, f), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.kind === "request"),
	);
}

describe("TUI2-R3v2 ③ — the safer-options arc, end to end", () => {
	it("3 → the alternatives → pick → the AMENDED call is re-presented", () => {
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Cleaning and rebuilding." }, RISKY, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: ALTERNATIVES }, { type: "stop", reason: "end_turn" }] }, // the SIDE QUERY
			{ events: [{ type: "text_delta", text: "Understood — narrower call." }, AMENDED, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-safer"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [
				[2.5, "3"], // ask for safer ways
				[4.5, "1"], // take the first alternative
				[7.0, "1"], // approve the amended call
			],
			timeout: 90,
		});

		// the alternatives were offered, in the model's own words
		const offered = screenAt(raw, "back to the original choices").join("\n");
		expect(offered).toContain("npm run build");
		expect(offered).toContain("rebuild in place, keep build/");
		expect(offered).toContain("asked the model for safer options");

		// …the pick went through the AMEND channel, so the model answered
		// with a new call, and the panel marked it
		const amended = screenAt(raw, "(amended)").join("\n");
		expect(amended, "the re-presented call carries the v4 marker").toContain("(amended)");
		expect(raw).toContain("Understood — narrower call.");

		// …and the trace shows EXACTLY ONE side query, marked
		const side = requests(dirs.home as string).filter((r) => r.purpose !== undefined);
		expect(side, "one press, one side query").toHaveLength(1);
		expect(side[0]!.purpose).toBe("safer-options");
		// its runId is its own — never a run's
		const runIds = new Set(requests(dirs.home as string).filter((r) => r.purpose === undefined).map((r) => r.runId));
		expect(runIds.has(side[0]!.runId as string)).toBe(false);
	}, 240_000);

	it("ZERO AMBIENT RENT: a session that never presses 3 leaves NO side query in the trace", () => {
		// the script still HOLDS a side-query answer at turn 1 — the test is
		// that nothing consumes it. If the request fired ambiently, turn 1
		// would be eaten and the closing text would never appear.
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Cleaning and rebuilding." }, RISKY, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-noask"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2.5, "1"]], // approve, never asking
		});
		expect(raw).toContain("all done.");
		const all = requests(dirs.home as string);
		expect(all.length, "the run's own requests, and nothing else").toBeGreaterThan(0);
		expect(all.filter((r) => r.purpose !== undefined), "not one side-query line").toHaveLength(0);
	}, 240_000);

	it("a FAILED ask degrades honestly on screen — the original choices stand", () => {
		// turn 1 is prose, not JSON: the parser refuses it, and the panel
		// says so rather than inventing alternatives.
		const script = fauxScript([
			{ events: [{ type: "text_delta", text: "Cleaning and rebuilding." }, RISKY, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "I would just run it honestly" }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
			...spares(3),
		]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "default" });
		const raw = ptyRun(["--mode", "default", "r3v2-degrade"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["all done.", "exit\r"],
			],
			delays: [[2.5, "3"], [5.0, "1"]],
			timeout: 90,
		});
		const screen = screenAt(raw, "the original choices stand").join("\n");
		expect(screen).toContain("couldn't get safer options — the original choices stand");
		// …and the original choices really do still work
		expect(screen).toContain("Yes, run it");
	}, 240_000);
});
