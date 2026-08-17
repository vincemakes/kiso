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
		// THE settled row — the rollup, formed with no keypress at all
		expect(joined).toMatch(/explored 6 files · 1 search · 1 dir/);
		// …and NOT the eight individual rows the walkthrough saw
		expect(grid.filter((l) => /✓ read {2}f\d\.txt/.test(l))).toHaveLength(0);
		// the affordance is on the row (ctrl+r must have something to do)
		expect(joined).toContain("ctrl+r lists them");
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
			delays: [[8, "exit\r"]],
			cwd: ws,
		});
		const grid = settledScreen(raw);
		expect(grid.join("\n")).toMatch(/explored 4 files · 1 search/);
		expect(grid.filter((l) => /✓ read {2}f\d\.txt/.test(l))).toHaveLength(0);
	}, 240_000);
});
