/**
 * ADR-0058 (3b) through the CLI's real entry: the CLI wires the session's
 * tasks into the coding tools, so a shell command that outlives its
 * `foregroundMs` is promoted, not killed; its task lives beside the
 * session's log (`<sessions>/<id>.tasks/`); and a clean exit stops it and
 * writes its terminal — nothing is left running.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

function live(marker: string): number {
	try {
		return execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
			.split("\n")
			.filter((l) => l.includes(marker) && !l.includes("ps -axo")).length;
	} catch {
		return 0;
	}
}

describe("ADR-0058 (3b) — the CLI's shell promotes, and a clean exit stops the task", () => {
	it("promoted past foregroundMs, the task sits beside the session log, and the exit ends it", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		const cwd = mkdtempSync(join(tmpdir(), "kiso-st-ws-"));
		const marker = `sleep 30.${Math.floor(Math.random() * 1e6)}`;
		const script = join(dirs.home, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: marker, foregroundMs: 300 } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "noted" }, { type: "stop", reason: "end_turn" }] },
			]),
		);
		const t0 = Date.now();
		const run = runCli(["chat", "st1"], { ...env, KISO_FAUX_SCRIPT: script }, { input: "go\n", cwd, timeout: 60_000 });
		expect(run.status).toBe(0);
		expect(Date.now() - t0).toBeLessThan(30_000); // the exit stopped it; nothing waited for the sleep

		const sessions = join(dirs.home, "sessions");
		const log = readFileSync(join(sessions, "st1.jsonl"), "utf8");
		expect(log).toMatch(/continued as background task t1/);

		const journal = readFileSync(join(sessions, "st1.tasks", "t1", "journal.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as { type: string; backend?: string; by?: string });
		expect(journal.map((r) => r.type)).toEqual(["planned", "runner_started", "command_started", "stop_requested", "terminal"]);
		expect(journal[0]!.backend).toBe("foreground");
		expect(journal[3]!.by).toBe("exit");
		expect(live(marker)).toBe(0);
	}, 90_000);
});
