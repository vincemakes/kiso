/**
 * ADR-0058 (3c) through the CLI's real entry: a background task that ends
 * while the session is idle WAKES it — one continuation turn whose first
 * input is the task notice (source "system", via tasks), the model answers
 * it, and the transcript shows a task row, not the person's chip. With
 * `taskWake: false` the notice waits for the person's next message.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `file` holds `needle` — never a fixed sleep: on a loaded
 *  runner the CLI's boot and the runner's spawn alone can outlast one. */
async function until(file: string, needle: string, deadlineMs = 30_000): Promise<void> {
	const end = Date.now() + deadlineMs;
	while (!(existsSync(file) && readFileSync(file, "utf8").includes(needle))) {
		if (Date.now() > end) throw new Error(`${needle} never appeared in ${file}`);
		await sleep(100);
	}
}

type Ev = { type: string; source?: string; via?: { kind: string; items?: { taskId: string; transition: string }[] }; content?: unknown };
const eventsOf = (home: string): Ev[] =>
	readFileSync(join(home, "sessions", "wk.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => (JSON.parse(l) as { event: Ev }).event);

function script(home: string): string {
	const path = join(home, "faux.json");
	writeFileSync(
		path,
		JSON.stringify([
			{ events: [{ type: "tool_call_end", callId: "b1", name: "shell", input: { command: "sleep 0.5; echo built", background: true } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "waiting for t1" }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "t1 is done" }, { type: "stop", reason: "end_turn" }] },
		]),
	);
	return path;
}

describe("ADR-0058 (3c) — an idle session wakes when its task ends", () => {
	it("the wake turn's first input is the notice; the model answers it; the transcript shows a task row", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		const cwd = mkdtempSync(join(tmpdir(), "kiso-wake-ws-"));
		const child = spawn("node", [CLI, "chat", "wk"], { env: { ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr.on("data", (d: Buffer) => (out += d.toString()));
		const closed = new Promise<number | null>((r) => child.on("close", r));
		child.stdin.write("build it\n");
		// stdin stays open until the wake turn has begun: its input is in the log
		await until(join(dirs.home, "sessions", "wk.jsonl"), '"kind":"tasks"');
		child.stdin.end();
		const run = { code: await closed, out };
		expect(run.code).toBe(0);
		const inputs = eventsOf(dirs.home).filter((e) => e.type === "user_input");
		expect(inputs.map((e) => e.source ?? "user")).toEqual(["user", "system"]);
		expect(inputs[1]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] });
		expect(String(inputs[1]!.content)).toMatch(/<kiso-task id="t1" status="exited" code="0"/);
		expect(run.out).toContain("t1 is done");
		expect(run.out).toContain("✦ task t1 exited");
	}, 60_000);

	it("taskWake: false — no wake; the notice rides the person's next message", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
		writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ taskWake: false }));
		const cwd = mkdtempSync(join(tmpdir(), "kiso-wake-ws-"));
		// the second line arrives after the task ended: its turn carries the notice
		const child = spawn("node", [CLI, "chat", "wk"], { env: { ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, cwd, stdio: ["pipe", "pipe", "pipe"] });
		child.stdin.write("build it\n");
		await until(join(dirs.home, "sessions", "wk.tasks", "t1", "journal.jsonl"), '"type":"terminal"');
		// the terminal is durable; the delivery hears it within one poll
		// (500 ms) and one window (1 s) — held for the next message
		await sleep(3_000);
		child.stdin.write("and now?\n");
		child.stdin.end();
		await new Promise((r) => child.on("close", r));
		const inputs = eventsOf(dirs.home).filter((e) => e.type === "user_input");
		expect(inputs.map((e) => e.source ?? "user")).toEqual(["user", "user", "system"]);
		expect(inputs[2]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] });
	}, 60_000);
});
