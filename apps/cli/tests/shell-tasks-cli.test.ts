/**
 * ADR-0058 (3b) through the CLI's real entry: the CLI wires the session's
 * tasks into the coding tools, so a shell command that outlives its
 * `foregroundMs` is promoted, not killed; its task lives beside the
 * session's log (`<sessions>/<id>.tasks/`); and a clean exit stops it and
 * writes its terminal — nothing is left running.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
		// the 300 ms wait promotes only with the floor lowered (Amendment 10)
		const run = runCli(["chat", "st1"], { ...env, KISO_FAUX_SCRIPT: script, KISO_MIN_FOREGROUND_MS: "0" }, { input: "go\n", cwd, timeout: 60_000 });
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

describe("0.50.1 (ADR-0058 Amendment 16) — the foreground ceiling at the CLI", () => {
	const faux = (home: string, command: string): string => {
		const script = join(home, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command, foregroundMs: 5_000 } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "noted" }, { type: "stop", reason: "end_turn" }] },
			]),
		);
		return script;
	};

	it("kiso -p keeps the model's wait: no ceiling, whatever the rigs' knob says", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		const cwd = mkdtempSync(join(tmpdir(), "kiso-st-ws-"));
		const done = `done-${Math.floor(Math.random() * 1e6)}`;
		const script = faux(dirs.home, `sleep 2; echo ${done}`);
		const run = runCli(["-p", "go"], { ...env, KISO_FAUX_SCRIPT: script, KISO_MIN_FOREGROUND_MS: "0", KISO_MAX_FOREGROUND_MS: "1000" }, { cwd, timeout: 60_000 });
		expect(run.status).toBe(0);
		const sessions = join(dirs.home, "sessions");
		const logs = readdirSync(sessions).filter((f) => f.endsWith(".jsonl"));
		expect(logs).toHaveLength(1);
		const log = readFileSync(join(sessions, logs[0]!), "utf8");
		expect(log).toContain(done);
		expect(log).not.toMatch(/background task/);
	}, 90_000);

	it("the interactive CLI promotes at the ceiling, tells the model it was the limit, and draws one TASK line", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		const cwd = mkdtempSync(join(tmpdir(), "kiso-st-ws-"));
		const marker = `sleep 30.${Math.floor(Math.random() * 1e6)}`;
		const script = faux(dirs.home, marker);
		const run = runCli(["chat", "st2"], { ...env, KISO_FAUX_SCRIPT: script, KISO_MIN_FOREGROUND_MS: "0", KISO_MAX_FOREGROUND_MS: "1000" }, { input: "go\n", cwd, timeout: 60_000 });
		expect(run.status).toBe(0);
		const log = readFileSync(join(dirs.home, "sessions", "st2.jsonl"), "utf8");
		expect(log).toMatch(/still running after 1000 ms \(the limit; you asked 5000 ms\); continued as background task t1/);
		expect(run.stdout).toContain("✦ task t1 · moved to the background at the 1s limit · asked 5s");
		expect(live(marker)).toBe(0);
	}, 90_000);
});
