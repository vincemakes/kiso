/**
 * 0.40.0 — the catastrophe floor, through the real CLI.
 *
 * The invocation is a delegate child's, exactly: `KISO_MODE=bypass` and
 * `chat <id> --task-file <path>` — so this is also the proof that a child
 * assembles the floor at its chain head.
 *
 * SAFETY, first: no command here ever names the home directory. The
 * catastrophic target is the TEST's own workspace root — a fresh mkdtemp
 * directory, by its absolute path — so a floor that failed would delete a
 * temporary directory and nothing else. The home-directory rules are
 * proven in floor.test.ts against a temporary home, where no shell runs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

type Decided = { type: string; callId?: string; decision?: string; decidedBy?: string; reason?: string };

function run(opts: { floorOff?: boolean }) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-floor-e2e-")));
	const workdir = join(base, "ws");
	const probe = join(base, "probe");
	mkdirSync(workdir);
	mkdirSync(probe);
	writeFileSync(join(workdir, "sentinel.txt"), "still here");
	const { env, dirs } = isolatedEnv();
	if (opts.floorOff === true) writeFileSync(join(dirs.home, "config.json"), `${JSON.stringify({ floor: "off" })}\n`);
	const script = join(base, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([
			// the workspace root by its absolute path: `rm -rf .` would prove
			// nothing, because rm itself refuses `.` whatever the floor does
			{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: `rm -rf ${workdir}` } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "tool_call_end", callId: "s2", name: "shell", input: { command: `rm -rf ${probe}` } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "floor done" }, { type: "stop", reason: "end_turn" }] },
		]),
	);
	const task = join(base, "task.md");
	writeFileSync(task, "clean up\n");
	const r = runCli(["chat", "floor-child", "--task-file", task], { ...env, KISO_MODE: "bypass", KISO_FAUX_SCRIPT: script }, { cwd: workdir, timeout: 60_000 });
	const decided = existsSync(join(dirs.home, "sessions", "floor-child.jsonl"))
		? readFileSync(join(dirs.home, "sessions", "floor-child.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => (JSON.parse(l) as { event: Decided }).event)
				.filter((e) => e.type === "permission_decided")
		: [];
	return { r, decided, workdir, probe };
}

describe("the floor on the real CLI, invoked as a delegate child is", () => {
	it("bypass: the workspace root is refused (decidedBy floor), the run goes on, and an ordinary rm -rf still runs", () => {
		const { r, decided, workdir, probe } = run({});
		expect(r.status, r.stderr).toBe(0);
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({ decision: "denied", decidedBy: "floor" });
		expect(decided.find((e) => e.callId === "s1")?.reason).toContain("the workspace root");
		expect(existsSync(join(workdir, "sentinel.txt")), "the refused command never ran").toBe(true);
		// bypass stays bypass (a delegate child still passes the old name,
		// KISO_MODE=bypass; the tier it names is full-access)
		expect(decided.find((e) => e.callId === "s2")).toMatchObject({ decision: "approved", decidedBy: "mode:full-access" });
		expect(existsSync(probe), "the ordinary rm -rf ran").toBe(false);
		expect(r.stdout).toContain("floor done");
	}, 90_000);

	it("`\"floor\": \"off\"` in the USER config switches it off — and then bypass runs it", () => {
		const { r, decided, workdir } = run({ floorOff: true });
		expect(r.status, r.stderr).toBe(0);
		expect(decided.find((e) => e.callId === "s1")).toMatchObject({ decision: "approved", decidedBy: "mode:full-access" });
		expect(existsSync(workdir), "with the floor off the command ran").toBe(false);
	}, 90_000);
});
