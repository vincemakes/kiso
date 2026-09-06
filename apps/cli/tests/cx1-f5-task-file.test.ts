/**
 * CX-1 F5 — `--task-file <path>`: the file is exactly ONE user turn.
 *
 * The non-TTY entry is a line-oriented readline: a task fed through
 * stdin became one turn per line, a command-shaped line was dispatched,
 * an `exit` line ended input early (audit F5). Task-file mode reads the
 * whole file as a single turn, bypasses the dispatcher (a leading `/`
 * is content), accepts no further stdin turns, exits after the turn's
 * terminal, and executes nothing when the file cannot be read.
 * Real CLI processes, faux provider, isolated homes.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

function fixture(): { env: NodeJS.ProcessEnv; home: string; dir: string } {
	const { env, dirs } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-cx1-f5-"));
	const script = join(dir, "faux.json");
	writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "F5-REPLY" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
	return { env: { ...env, KISO_FAUX_SCRIPT: script } as NodeJS.ProcessEnv, home: dirs.home, dir };
}

function userInputs(home: string, id: string): string[] {
	const log = readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8");
	return log
		.split("\n")
		.filter((l) => l.includes('"user_input"'))
		.map((l) => (JSON.parse(l) as { event: { type: string; content: string } }).event)
		.filter((e) => e.type === "user_input")
		.map((e) => e.content);
}

describe("CX-1 F5 — the task file is one turn", () => {
	it("(a)(b)(c) a multi-line task with a command-shaped first line and an `exit` line → one user_input, byte-equal, the turn ran", () => {
		const { env, home, dir } = fixture();
		const task = "/mode bypass\nsecond line with constraints\nexit\nfourth line";
		const file = join(dir, "task.txt");
		writeFileSync(file, task, "utf8");
		const res = runCli(["chat", "f5-a", "--task-file", file], env, { input: "", timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).toContain("F5-REPLY"); // the turn ran to its terminal before the exit
		expect(userInputs(home, "f5-a")).toEqual([task]);
	});

	it("(d) stdin carrying extra lines is NOT a second turn — task-file mode is single-turn", () => {
		const { env, home, dir } = fixture();
		const file = join(dir, "task.txt");
		writeFileSync(file, "only this", "utf8");
		const res = runCli(["chat", "f5-d", "--task-file", file], env, { input: "another line\nexit\n", timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		expect(userInputs(home, "f5-d")).toEqual(["only this"]);
	});

	it("(e) an unreadable task file → non-zero exit, no session log, nothing executed", () => {
		const { env, home, dir } = fixture();
		const res = runCli(["chat", "f5-e", "--task-file", join(dir, "missing.txt")], env, { input: "", timeout: 60_000 });
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain("--task-file");
		expect(() => readFileSync(join(home, "sessions", "f5-e.jsonl"), "utf8")).toThrow(); // no session was opened
	});

	it("(f) the D13 shape — a 3,000-line task is one turn, byte-equal", () => {
		const { env, home, dir } = fixture();
		const task = Array.from({ length: 3000 }, (_, i) => `line-${String(i + 1).padStart(4, "0")}`).join("\n");
		const file = join(dir, "task.txt");
		writeFileSync(file, task, "utf8");
		const res = runCli(["chat", "f5-f", "--task-file", file], env, { input: "", timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		const inputs = userInputs(home, "f5-f");
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toBe(task);
	});
});
