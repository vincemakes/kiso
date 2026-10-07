/** LT2B-F1: turn count alone must not ask a human to keep a healthy run alive.
 * The old 50/100-turn panels blocked unattended work. These real PTY tests
 * exercise both former boundaries and preserve deliberate cancellation.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const call = (i: number, command = "true") => ({ events: [
	{ type: "tool_call_end", callId: `c${i}`, name: "shell", input: { command } },
	{ type: "stop", reason: "tool_use" },
] });

function events(home: string, id: string): Array<Record<string, unknown> & { type: string }> {
	return readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8").trim().split("\n")
		.map((line) => JSON.parse(line).event);
}

// If the old panel returns, end it deliberately so the test can report a
// completed counterexample instead of spending its timeout on a dead wait.
const oldPanelEscape: [string, string][] = [["keep going?", "2"], ["(interrupted)", "exit\r"]];

describe("LT2B-F1 — long interactive runs do not require periodic consent", () => {
	it("completes beyond both former checkpoints without any continuation answer", () => {
		const calls = 105;
		const id = "lt2-unattended";
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				...Array.from({ length: calls }, (_, i) => call(i)),
				{ events: [{ type: "text_delta", text: "long-run complete." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const raw = ptyRun(["--mode", "bypass", id], env as NodeJS.ProcessEnv, {
			cwd: mkdtempSync(join(tmpdir(), "kiso-unattended-")),
			feeds: [["/mode to switch", "go\r"], ["long-run complete.", "exit\r"], ...oldPanelEscape],
			timeout: 90,
		});
		const log = events(dirs.home, id);
		expect(log.filter((e) => e.type === "terminal").map((e) => e.outcome)).toEqual([{ kind: "completed" }]);
		expect(log.filter((e) => e.type === "stop")).toHaveLength(calls + 1);
		expect(log.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(calls);
		expect(raw).toContain("long-run complete.");
		expect(raw).not.toContain("keep going?");
	}, 180_000);

	it("Esc still aborts a long run after the former first checkpoint", () => {
		const id = "lt2-cancel-long";
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				...Array.from({ length: 55 }, (_, i) => call(i)),
				call(55, "sleep 20"),
				{ events: [{ type: "text_delta", text: "must not finish." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const raw = ptyRun(["--mode", "bypass", id], env as NodeJS.ProcessEnv, {
			cwd: mkdtempSync(join(tmpdir(), "kiso-cancel-long-")),
			feeds: [["/mode to switch", "go\r"], ["sleep 20", "\x1b"], ["[aborting run]", "exit\r"], ...oldPanelEscape],
			timeout: 90,
		});
		const log = events(dirs.home, id);
		expect(log.filter((e) => e.type === "stop").length).toBeGreaterThanOrEqual(55);
		expect(log.filter((e) => e.type === "terminal").map((e) => e.outcome)).toEqual([{ kind: "aborted", by: "user" }]);
		expect(raw).not.toContain("must not finish.");
		expect(raw).not.toContain("keep going?");
	}, 180_000);
});
