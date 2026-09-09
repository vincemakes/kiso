/**
 * LT-2b — the 50-turn checkpoint, end to end on a real PTY.
 *
 * R3e stands: no hard turn limit on an interactive session. What a long run
 * gets instead is a QUESTION every CHECKPOINT_TURNS model turns — "still
 * working, keep going?" — and the human's answer: keep going, or stop here
 * (the run ends as `aborted by user`, resumable). Headless entries never see
 * it (no dock, no panel).
 *
 * A faux model that calls the shell fifty times, one call per turn, then
 * answers. The panel must appear at the fiftieth turn, not before; choosing
 * "stop" ends the run as aborted and the session stays healthy.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const CHECKPOINT_TURNS = 50;
const call = (i: number) => ({ events: [{ type: "tool_call_end", callId: `c${i}`, name: "shell", input: { command: "true" } }, { type: "stop", reason: "tool_use" }] });

describe("LT-2b — the turn checkpoint on a real PTY", () => {
	it(`asks at turn ${CHECKPOINT_TURNS}, not before; "stop here" ends the run as aborted by user and the session survives`, () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				...Array.from({ length: CHECKPOINT_TURNS + 10 }, (_, i) => call(i)),
				{ events: [{ type: "text_delta", text: "done at last." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-checkpoint-"));
		const raw = ptyRun(["--mode", "bypass", "lt2-checkpoint"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				// the panel: a digit answers a single-select question at once
				["keep going?", "2"],
				// the abort lands between two model turns: the fiftieth turn's
				// call was approved but never started, and its card says so
				["(interrupted)", "exit\r"],
			],
			timeout: 90,
		});
		const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(plain, "the checkpoint never asked").toContain(`${CHECKPOINT_TURNS} turns`);

		const log = readFileSync(join(dirs.home, "sessions", "lt2-checkpoint.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: Record<string, unknown> & { type: string } });
		// exactly CHECKPOINT_TURNS model turns ran before the question; none after "stop"
		const stops = log.filter((e) => e.event.type === "stop");
		expect(stops, "the run went on past the checkpoint, or stopped short of it").toHaveLength(CHECKPOINT_TURNS);
		// stopped BETWEEN turns: the fiftieth turn's call was never started (the
		// same shape as an esc mid-turn — `kiso resume` re-issues it)
		const executed = log.filter((e) => e.event.type === "tool_execution_started");
		expect(executed, "the fiftieth turn's call ran although the human said stop").toHaveLength(CHECKPOINT_TURNS - 1);
		const terminal = log.find((e) => e.event.type === "terminal");
		expect((terminal?.event.outcome as { kind: string; by?: string } | undefined)?.kind, "the answer 'stop here' did not end the run as an abort").toBe("aborted");
		expect(plain, "the model kept going after the human said stop").not.toContain("done at last.");
	}, 180_000);
});
