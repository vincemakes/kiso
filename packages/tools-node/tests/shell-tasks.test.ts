/**
 * ADR-0058 §3–§4, step 3b — the shell with a session's tasks.
 *
 * With tasks wired, the wait ends three ways: the process exits (the
 * ordinary result), its output contains `readyWhen`, or `foregroundMs`
 * passes — and the last two PROMOTE the command to a task, never kill it.
 * `background: true` starts it as a task at once. A host that wires no
 * tasks keeps today's shell byte for byte.
 *
 * The runner is the BUILT one (dist/task-runner.js): `npm run check` builds
 * before it tests.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { readRecords, TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "../src/process-backend.js";
import { createCodingTools, readFileTool, shellTool, taskStopTool } from "../src/index.js";

const RUNNER = fileURLToPath(new URL("../dist/task-runner.js", import.meta.url));
const backend = processTaskBackend({ runnerPath: RUNNER });

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
	return { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, sessionId: "s1", executionId: "ex-1", ...extra } as unknown as ToolContext;
}

function setup() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-shelltasks-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
	const opts = { workspaceRoot: cwd, tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined) };
	return { base, cwd, manager, opts, shell: shellTool(opts), stop: taskStopTool(opts) };
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

describe("a host that wires no tasks keeps today's shell", () => {
	it("the schema, the description and the tool list are unchanged", () => {
		const shell = shellTool({ workspaceRoot: tmpdir() });
		expect(Object.keys((shell.parameters as { properties: object }).properties)).toEqual(["command", "timeoutMs"]);
		expect(shell.description).toContain("Fails loudly on timeout");
		expect(createCodingTools({ workspaceRoot: tmpdir() }).map((t) => t.name)).not.toContain("task_stop");
	});
});

describe("ADR-0058 §3 — the wait, with tasks", () => {
	it("the schema offers foregroundMs, background, readyWhen and the deprecated timeoutMs; task_stop joins the tools", () => {
		const { opts, shell } = setup();
		expect(Object.keys((shell.parameters as { properties: object }).properties)).toEqual(["command", "foregroundMs", "background", "readyWhen", "timeoutMs"]);
		expect(createCodingTools(opts).map((t) => t.name)).toContain("task_stop");
	});

	it("a process that exits within the wait gives the ordinary result, and no task", async () => {
		const { base, shell } = setup();
		const r = await shell.execute({ command: "echo hi" }, ctx());
		expect(r).toMatchObject({ content: "hi", isError: false });
		expect(existsSync(join(base, "s1.tasks")) ? readdirSync(join(base, "s1.tasks")) : []).toEqual([]);
	});

	it("promotion never kills: past foregroundMs the command continues as a task and ends with its real exit code", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "echo first; sleep 1; echo done; exit 3", foregroundMs: 300 }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toMatch(/continued as background task t1/);
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", exitCode: 3 });
		const out = readFileSync(ended.outputPath, "utf8");
		expect(out).toContain("first");
		expect(out).toContain("done");
		expect(readRecords(join(manager.root, "t1", "journal.jsonl"))[0]).toMatchObject({ backend: "foreground", executionId: "ex-1" });
	});

	it("the deprecated timeoutMs is foregroundMs: it promotes, never kills", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "sleep 0.8; exit 0", timeoutMs: 200 }, ctx());
		expect(r.content).toMatch(/continued as background task t1/);
		await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(manager.get("t1")!.state).toMatchObject({ exitCode: 0 });
	});

	it("readyWhen ends the wait: promoted, the result says ready, the task stays running", async () => {
		const { manager, shell, stop } = setup();
		const r = await shell.execute({ command: 'echo booting; sleep 0.2; echo "Local: http://127.0.0.1:5173"; sleep 30', readyWhen: "Local: http://", foregroundMs: 20_000 }, ctx());
		expect(r.content).toMatch(/^ready/);
		expect(r.content).toMatch(/continued as background task t1/);
		expect(manager.get("t1")!.state).toEqual({ kind: "running", ready: true });
		const s = await stop.execute({ id: "t1" }, ctx());
		expect(s.content).toMatch(/stopping task t1/);
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", stopped: true });
	});

	it("background: true starts a runner task at once", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "sleep 0.5; echo later", background: true }, ctx());
		expect(r.content).toMatch(/started background task t1/);
		expect(readRecords(join(manager.root, "t1", "journal.jsonl"))[0]).toMatchObject({ backend: "process", executionId: "ex-1" });
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(readFileSync(ended.outputPath, "utf8")).toContain("later");
	});

	it("background: true with readyWhen: a task at once, and the ready line is recorded later", async () => {
		const { manager, shell, stop } = setup();
		const r = await shell.execute({ command: "sleep 0.3; echo listening; sleep 30", background: true, readyWhen: "listening" }, ctx());
		expect(r.content).toMatch(/started background task t1/);
		await until(() => manager.get("t1")!, (i) => i.state.kind === "running" && i.state.ready);
		await stop.execute({ id: "t1" }, ctx());
		await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
	});

	it("Esc before promotion still stops the command exactly as today; no task is made", async () => {
		const { base, shell } = setup();
		const r = await shell.execute(
			{ command: "sleep 30", foregroundMs: 20_000 },
			ctx({ signal: { aborted: false, addEventListener: (_t: string, l: () => void) => void setTimeout(l, 200), removeEventListener: () => {} } as never }),
		);
		expect(r).toMatchObject({ isError: true });
		expect(r.content).toMatch(/^shell aborted/);
		expect(existsSync(join(base, "s1.tasks")) ? readdirSync(join(base, "s1.tasks")) : []).toEqual([]);
	});

	it("a promoted task is stopped by a clean exit, and its terminal is written", async () => {
		const { manager, shell } = setup();
		await shell.execute({ command: "sleep 30", foregroundMs: 200 }, ctx());
		expect(await manager.stopAll("exit", 10_000)).toEqual([]);
		expect(manager.get("t1")!.state).toMatchObject({ kind: "ended", stopped: true });
	});
});

describe("ADR-0058 §4 — task_stop and reading a task's output", () => {
	it("task_stop: an unknown id and an ended task are answered plainly", async () => {
		const { shell, stop, manager } = setup();
		expect((await stop.execute({ id: "t9" }, ctx())).content).toMatch(/no task t9/);
		await shell.execute({ command: "sleep 0.4", foregroundMs: 100 }, ctx());
		await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect((await stop.execute({ id: "t1" }, ctx())).content).toMatch(/t1 had already ended/);
	});

	it("read_file serves the session's task output by absolute path", async () => {
		const { manager, shell, opts } = setup();
		await shell.execute({ command: "echo task-output; sleep 0.3", foregroundMs: 100 }, ctx());
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		const r = await readFileTool(opts).execute({ path: ended.outputPath }, ctx());
		expect(r.isError).toBe(false);
		expect(r.content).toContain("task-output");
	});
});
