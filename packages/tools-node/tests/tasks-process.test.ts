/**
 * ADR-0058 §6 — the process task backend and its runner, on real processes.
 *
 * The runner writes each record that gates an effect BEFORE the effect:
 * runner_started (its verifiable identity), command_started (then the
 * command), terminal (the real exit). These cases cut the runner at each
 * record and read the verdict the journal gives; verify that a reused pid
 * is never a live runner; kill the process that started a task and watch
 * the task finish anyway; stop a task's whole process group; see `ready`
 * and the output rotation; and let read_file serve a task's output by
 * absolute path while every other path stays in the workspace.
 *
 * The runner is the BUILT one (dist/task-runner.js): `npm run check`
 * builds before it tests.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { appendRecord, TaskManager, type TaskInfo, type TaskTransition } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "../src/process-backend.js";
import { readFileTool } from "../src/index.js";

const RUNNER = fileURLToPath(new URL("../dist/task-runner.js", import.meta.url));
const backend = processTaskBackend({ runnerPath: RUNNER });
const CTX: ToolContext = { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} } } as unknown as ToolContext;

function setup(onTransition?: (t: TaskInfo, tr: TaskTransition) => void) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-tasks-")));
	const root = join(base, "s.tasks");
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root, backend, pollMs: 50, ...(onTransition !== undefined ? { onTransition } : {}) });
	return { base, root, cwd, manager };
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 8_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = read();
		if (ok(v)) return v;
		if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

const journalTypes = (root: string, id: string) =>
	readFileSync(join(root, id, "journal.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => (JSON.parse(l) as { type: string }).type);

describe("ADR-0058 — a task outlives its caller and ends with the truth", () => {
	it("a one-shot ends with its real exit code and output; the records land in write-ahead order", async () => {
		const { root, cwd, manager } = setup();
		const t = await manager.start({ command: "echo hi; exit 3", cwd });
		const ended = await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", exitCode: 3, signal: null });
		expect(readFileSync(ended.outputPath, "utf8")).toContain("hi");
		expect(journalTypes(root, t.id)).toEqual(["planned", "runner_started", "command_started", "terminal"]);
		manager.close();
	});

	it("ids are t1, t2, … and survive a new manager on the same directory", async () => {
		const { root, cwd, manager } = setup();
		await manager.start({ command: "true", cwd });
		await manager.start({ command: "true", cwd });
		manager.close();
		const again = new TaskManager({ root, backend });
		const t3 = await again.start({ command: "true", cwd });
		expect(t3.id).toBe("t3");
		expect(again.list().map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
	});
});

describe("ADR-0058 — what the journal proves after a cut", () => {
	it("the runner dies after runner_started: the command provably never ran", async () => {
		const { cwd, manager } = setup();
		const marker = join(cwd, "ran");
		const t = await manager.start({ command: `touch ${marker}`, cwd, env: { ...process.env, KISO_TASK_RUNNER_DIE_AFTER: "runner_started" } });
		const info = await until(() => manager.get(t.id)!, (i) => i.state.kind !== "starting");
		expect(info.state.kind).toBe("not_run");
		expect(existsSync(marker)).toBe(false);
	});

	it("the runner dies after command_started: unknown — never guessed, never re-run", async () => {
		const { cwd, manager } = setup();
		const marker = join(cwd, "ran");
		const t = await manager.start({ command: `touch ${marker}`, cwd, env: { ...process.env, KISO_TASK_RUNNER_DIE_AFTER: "command_started" } });
		// "running" is the true verdict for the instant between the record and
		// the runner's exit; the cut is read once the runner is gone
		const info = await until(() => manager.get(t.id)!, (i) => i.state.kind !== "starting" && i.state.kind !== "running");
		expect(info.state.kind).toBe("unknown");
		await new Promise((r) => setTimeout(r, 200));
		expect(manager.get(t.id)!.state.kind).toBe("unknown"); // nothing re-ran it
	});

	it("a live pid with another start time is NOT the runner", () => {
		const { root, manager } = setup();
		const dir = join(root, "t1");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "journal.jsonl");
		appendRecord(file, { type: "planned", ts: Date.now(), taskId: "t1", backend: "process", command: "sleep 1", cwd: root, profile: "oneshot" });
		// this test's own pid — alive — recorded with a start time it never had
		appendRecord(file, { type: "runner_started", ts: Date.now(), pid: process.pid, startedAt: "Thu Jan  1 00:00:00 1970" });
		appendRecord(file, { type: "command_started", ts: Date.now() });
		expect(backend.identify(process.pid, "Thu Jan  1 00:00:00 1970")).toBe("gone");
		expect(manager.get("t1")!.state.kind).toBe("unknown");
	});
});

describe("ADR-0058 — the caller's death, a stop, the ready signal, the rotation", () => {
	it("the process that started a task is SIGKILLed; the task still finishes and a new manager reads it", async () => {
		const { root, cwd } = setup();
		const runtimeInternal = fileURLToPath(new URL("../../runtime/dist/internal.js", import.meta.url));
		const backendModule = fileURLToPath(new URL("../dist/process-backend.js", import.meta.url));
		const script = `
			const { TaskManager } = await import(${JSON.stringify(runtimeInternal)});
			const { processTaskBackend } = await import(${JSON.stringify(backendModule)});
			const m = new TaskManager({ root: ${JSON.stringify(root)}, backend: processTaskBackend() });
			await m.start({ command: "sleep 1; echo done", cwd: ${JSON.stringify(cwd)} });
			process.stdout.write("started\\n");
			setInterval(() => {}, 1000);
		`;
		const caller = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise<void>((resolve, reject) => {
			caller.stdout.on("data", (d: Buffer) => (d.toString().includes("started") ? resolve() : undefined));
			caller.on("exit", () => reject(new Error("the caller exited before starting the task")));
		});
		caller.kill("SIGKILL");
		const fresh = new TaskManager({ root, backend });
		const info = await until(() => fresh.get("t1")!, (i) => i.state.kind === "ended");
		expect(info.state).toMatchObject({ kind: "ended", exitCode: 0 });
		expect(readFileSync(info.outputPath, "utf8")).toContain("done");
	});

	it("stop ends the task's whole process group; stopAll leaves nothing live", async () => {
		const { cwd, manager } = setup();
		const t = await manager.start({ command: "sleep 31.7 & sleep 31.7", cwd });
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "running");
		expect(manager.stop(t.id, "person")).toBe(true);
		const ended = await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", stopped: true });
		await new Promise((r) => setTimeout(r, 200));
		let left = "";
		try {
			left = execFileSync("pgrep", ["-f", "sleep 31.7"], { encoding: "utf8" });
		} catch {
			left = ""; // pgrep exits 1 when nothing matches
		}
		expect(left.trim()).toBe("");
		expect(await manager.stopAll()).toEqual([]);
		manager.close();
	});

	it("a stop gives the task its grace: a service that traps TERM cleans up and ends stopped", async () => {
		const { cwd, manager } = setup();
		const marker = join(cwd, "cleaned");
		const t = await manager.start({ command: `trap 'echo bye > ${marker}; exit 0' TERM; echo up; sleep 30 & wait`, cwd, profile: "service", readyWhen: "up" });
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "running" && i.state.ready);
		expect(manager.stop(t.id, "person")).toBe(true);
		const ended = await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", stopped: true });
		expect(readFileSync(marker, "utf8").trim()).toBe("bye");
		manager.close();
	});

	it("a stop that cannot confirm the tree dead writes no terminal: the task is unknown, never ended", async () => {
		const { root, cwd, manager } = setup();
		const t = await manager.start({ command: "sleep 30", cwd, env: { ...process.env, KISO_TASK_RUNNER_STOP_UNCONFIRMED: "1" } });
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "running");
		expect(manager.stop(t.id, "person")).toBe(true);
		const info = await until(() => manager.get(t.id)!, (i) => i.state.kind !== "running");
		expect(info.state.kind).toBe("unknown");
		const types = journalTypes(root, t.id);
		expect(types).toContain("stop_unconfirmed");
		expect(types).not.toContain("terminal");
		manager.close();
	});

	it("the journal is the stop channel: a stop_requested record alone — no signal — stops the task", async () => {
		// on win32 a signal to the runner is TerminateProcess, so the record
		// (durable before any signal) is what every platform acts on
		const { root, cwd, manager } = setup();
		const t = await manager.start({ command: "sleep 30", cwd });
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "running");
		appendRecord(join(root, t.id, "journal.jsonl"), { type: "stop_requested", ts: Date.now(), by: "person" });
		const ended = await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", stopped: true });
		manager.close();
	});

	it("a command that cannot start ends with its error — never an invented exit code", async () => {
		const { base, manager } = setup();
		const t = await manager.start({ command: "echo never", cwd: join(base, "no-such-dir") });
		const ended = await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", exitCode: null, signal: null });
		expect(ended.state.kind === "ended" && ended.state.error).toMatch(/ENOENT/);
		expect(readFileSync(ended.outputPath, "utf8")).toMatch(/could not start/);
		manager.close();
	});

	it("a live pid whose start time cannot be read is unverifiable — never read as the runner", () => {
		// ADR-0058 §6: "When identity cannot be verified, the verdict is the
		// gone row." A reused pid must never be taken for the runner (or be
		// signalled as one).
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(backend.identify(process.pid, "Thu Jan  1 00:00:00 1970")).toBe("unverifiable");
		} finally {
			process.env.PATH = path;
		}
		expect(backend.identify(process.pid, "")).toBe("unverifiable"); // recorded without a start time
	});

	it("readyWhen: the task stays running and says it is ready once", async () => {
		const seen: TaskTransition[] = [];
		const { cwd, manager } = setup((_t, tr) => seen.push(tr));
		const t = await manager.start({ command: 'echo booting; sleep 0.3; echo "Local: http://127.0.0.1:5173"; sleep 30', cwd, profile: "service", readyWhen: "Local: http://" });
		const info = await until(() => manager.get(t.id)!, (i) => i.state.kind === "running" && i.state.ready);
		expect(info.state).toEqual({ kind: "running", ready: true });
		await until(() => seen, (s) => s.includes("ready"));
		manager.stop(t.id, "person");
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(seen.filter((s) => s === "ready")).toHaveLength(1);
		manager.close();
	});

	it("the output rotates at the cap and keeps the tail", async () => {
		const { root, cwd, manager } = setup();
		const t = await manager.start({
			command: "for i in 1 2 3 4; do head -c 400 /dev/zero | tr '\\0' x; sleep 0.05; done",
			cwd,
			env: { ...process.env, KISO_TASK_OUTPUT_CAP: "1000" },
		});
		await until(() => manager.get(t.id)!, (i) => i.state.kind === "ended");
		expect(existsSync(join(root, t.id, "output.1.log"))).toBe(true);
		expect(readFileSync(join(root, t.id, "output.log"), "utf8")).toMatch(/^\[kiso: output rotated after \d+ bytes/);
		manager.close();
	});
});

describe("ADR-0058 §4 — read_file serves a task's output, and nothing else widens", () => {
	it("an absolute path inside the task root reads; outside it is refused; relative stays in the workspace", async () => {
		const { root, cwd } = setup();
		mkdirSync(join(root, "t1"), { recursive: true });
		writeFileSync(join(root, "t1", "output.log"), "task output\n");
		writeFileSync(join(cwd, "a.txt"), "workspace file\n");
		const tool = readFileTool({ workspaceRoot: cwd, extraReadRoots: [root] });
		const inside = await tool.execute({ path: join(root, "t1", "output.log") }, CTX);
		expect(inside.isError).toBe(false);
		expect(inside.content).toContain("task output");
		const outside = await tool.execute({ path: join(tmpdir(), "elsewhere.txt") }, CTX);
		expect(outside.isError).toBe(true);
		const relative = await tool.execute({ path: "a.txt" }, CTX);
		expect(relative.content).toContain("workspace file");
		const escape = await tool.execute({ path: join(root, "..", "ws", "a.txt") }, CTX);
		expect(escape.isError).toBe(true);
	});
});
