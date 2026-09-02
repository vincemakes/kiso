/**
 * TUI2-R1.5 slice ① — VD-1 on a REAL CLI process, at REAL pacing.
 *
 * R1's own rollup PTY gate (tui2-r1-visibility, T-V2) feeds a burst whose
 * turn has NO text before the tools. That shape kept every cell live
 * until the next turn's text released them, they all committed together,
 * and the rollup formed. A model does not behave that way: it SAYS
 * something first, and the walkthrough's frame s1-06 is what happened
 * next — nine reads, nine rows, no rollup unless a key was pressed.
 *
 * This gate drives the narrated shape and reads the SETTLED SCREEN (the
 * VT grid), not the byte stream: the stream necessarily carries the live
 * per-call rows on its way to the settle, which is precisely how a
 * byte-level suite could stay green through a dead feature.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). Two reasons, one of them a truthfulness bug: that table
 * names what a single-tool rollup COUNTS — "14 matches" means fourteen
 * matched lines — while this line counts CALLS, so one search rendered
 * "1 match" whenever the search had matched any other number. The
 * phrasing is the owner's, from the shape they asked for: "thought 17s
 * · read 4 files · listed 1 directory · ran 4 shell commands".
 */
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED, so
 * the fold's lead term is OPTIONAL in these patterns. R3b ruled that a
 * zero term is a sentence about something that did not happen; the
 * thought term was exempt by accident (written before the rule). The
 * faux model emits no thinking, so every fold here led with `thought
 * 0s` — which is exactly the sentence the rule forbids.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, settledScreen, spares } from "./helpers/pty.js";

/** A workspace the burst can really read. */
function workspace(n: number): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	for (let i = 0; i < n; i += 1) writeFileSync(join(dir, `f${i}.txt`), `alpha ${i}\nbeta ${i}\n`, "utf8");
	return dir;
}

describe("TUI2-R1.5 ① — the exploration rollup at real pacing (real CLI)", () => {
	it("a NARRATED burst (text before the tools) still settles as ONE exploration row", () => {
		const ws = workspace(6);
		const events: unknown[] = [{ type: "text_delta", text: "Let me explore the parser area first." }];
		for (let i = 0; i < 6; i += 1) events.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
		events.push({ type: "tool_call_end", callId: "s0", name: "search_text", input: { pattern: "alpha", path: "." } });
		events.push({ type: "tool_call_end", callId: "l0", name: "list_dir", input: { path: "." } });
		events.push({ type: "stop", reason: "tool_use" });
		const script = fauxScript([{ events }, { events: [{ type: "text_delta", text: "explored." }, { type: "stop", reason: "end_turn" }] }, ...spares()]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-roll"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["explored.", "exit\r"],
			],
			cwd: ws,
		});
		const grid = settledScreen(raw);
		const joined = grid.join("\n");
		// DECLARED SUPERSESSION (R3b, owner ruling): the burst's SETTLED
		// form is the segment fold; the exploration row is what `ctrl+o`
		// opens. The claim these cases make — the burst settles as ONE
		// thing, with no keypress, and never as N individual rows — is
		// unchanged and is stronger now: one row for the whole segment.
		expect(joined).toMatch(/read 6 files · ran 1 search · listed 1 directory/);
		// …and NOT the eight individual rows the walkthrough saw
		expect(grid.filter((l) => /✓ read {2}f\d\.txt/.test(l))).toHaveLength(0);
		// R4a: the affordance is no longer ON the row — a row cannot say
		// which fold a key would open, so it stopped claiming to. That
		// ctrl+o still has something to do is pinned behaviourally in
		// packages/tui/tests/r4-act-slot.test.ts ("R4a").
	}, 240_000);

	it("REAL PACING — a burst whose calls land seconds apart still rolls up at settle", () => {
		// the pacing here is the HUMAN's: the turn is submitted, then a
		// second turn's worth of wall time passes before the exit key. The
		// burst's own frames are already ≥16ms apart in a real process (the
		// durable log write between calls) — the first case proves the
		// shape, this one proves it survives a slow, real session.
		const ws = workspace(4);
		const events: unknown[] = [{ type: "text_delta", text: "Looking around." }];
		for (let i = 0; i < 4; i += 1) events.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
		events.push({ type: "tool_call_end", callId: "s0", name: "search_text", input: { pattern: "beta", path: "." } });
		events.push({ type: "stop", reason: "tool_use" });
		const script = fauxScript([{ events }, { events: [{ type: "text_delta", text: "had a look." }, { type: "stop", reason: "end_turn" }] }, ...spares()]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-roll-paced"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			delays: [[4, "exit\r"]],
			cwd: ws,
		});
		const grid = settledScreen(raw);
		// DECLARED SUPERSESSION (R3b, owner ruling): the burst's SETTLED
		// form is the segment fold; the exploration row is what `ctrl+o`
		// opens. The claim these cases make — the burst settles as ONE
		// thing, with no keypress, and never as N individual rows — is
		// unchanged and is stronger now: one row for the whole segment.
		expect(grid.join("\n")).toMatch(/read 4 files · ran 1 search/);
		expect(grid.filter((l) => /✓ read {2}f\d\.txt/.test(l))).toHaveLength(0);
	}, 240_000);
});
