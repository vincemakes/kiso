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

function setup(shellEnv?: Record<string, string>) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-shelltasks-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
	const opts = { workspaceRoot: cwd, tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined), ...(shellEnv !== undefined ? { shellEnv } : {}) };
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
		// a promoted ready is claimed for the shell call: its result told the model
		expect(readRecords(join(manager.root, "t1", "journal.jsonl")).filter((x) => (x.type as string) === "result_claimed")).toEqual([expect.objectContaining({ transition: "ready", executionId: "ex-1" })]);
		const s = await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
		expect(s.content).toMatch(/^stopped task t1 \(SIGTERM; it ran \d+(\.\d+)?s\)/);
		expect(manager.get("t1")!.state).toMatchObject({ kind: "ended", stopped: true });
	});

	it("background: true starts a runner task at once", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "sleep 0.5; echo later", background: true }, ctx());
		expect(r.content).toMatch(/started background task t1/);
		expect(readRecords(join(manager.root, "t1", "journal.jsonl"))[0]).toMatchObject({ backend: "process", executionId: "ex-1" });
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(readFileSync(ended.outputPath, "utf8")).toContain("later");
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

describe("ADR-0058 §2 (3e) — a running foreground command is moved to the background through the manager", () => {
	it("the person's detach: the tool returns at once, the command keeps running and ends with its real code", async () => {
		const { manager, shell } = setup();
		const pending = shell.execute({ command: "echo started; sleep 1; echo done; exit 4", foregroundMs: 30_000 }, ctx({ executionId: "ex-bg" } as Partial<ToolContext>));
		await until(() => manager.detachable(), (d) => d.some((x) => x.executionId === "ex-bg"));
		const t0 = Date.now();
		expect(manager.detach("ex-bg", "person")).toBe(true);
		const r = await pending;
		expect(Date.now() - t0).toBeLessThan(1_000);
		expect(r).toMatchObject({ isError: false });
		expect(r.content).toMatch(/^moved to the background by the person; continued as background task t1 \(not killed — it keeps running\)/);
		expect(manager.detach("ex-bg", "person")).toBe(false); // once
		const ended = await until(() => manager.get("t1")!, (i) => i.state.kind === "ended");
		expect(ended.state).toMatchObject({ kind: "ended", exitCode: 4 });
		expect(readFileSync(ended.outputPath, "utf8")).toMatch(/started[\s\S]*done/);
	});

	it("a steer's detach says why; a command that ended is no longer detachable", async () => {
		const { manager, shell } = setup();
		const pending = shell.execute({ command: "sleep 1", foregroundMs: 30_000 }, ctx({ executionId: "ex-st" } as Partial<ToolContext>));
		await until(() => manager.detachable(), (d) => d.length === 1);
		manager.detach("ex-st", "steer");
		expect((await pending).content).toMatch(/^moved to the background so the person's message could land; continued as background task t1/);
		const quick = await shell.execute({ command: "echo hi" }, ctx({ executionId: "ex-q" } as Partial<ToolContext>));
		expect(quick).toMatchObject({ content: "hi", isError: false });
		expect(manager.detachable()).toEqual([]); // it unregistered when it settled
	});
});

/** A task with a final reading: ended, or `unknown` — a stop the runner
 *  could not confirm (a loaded machine can miss the sweep's deadline) is
 *  never read as stopped (ADR-0058 §6). */
const settled = (i: { readonly state: { readonly kind: string } }) => i.state.kind === "ended" || i.state.kind === "unknown";
const claimsOf = (manager: TaskManager, id: string) => readRecords(join(manager.root, id, "journal.jsonl")).filter((x) => (x.type as string) === "result_claimed");
/** A ctx whose signal fires `abort` after `ms` (the person's Esc). */
const escAfter = (ms: number, extra: Partial<ToolContext> = {}) =>
	ctx({ signal: { aborted: false, addEventListener: (_t: string, l: () => void) => void setTimeout(l, ms), removeEventListener: () => {} } as never, ...extra });

describe("ADR-0058 Amendment 7 — task_stop waits for the end and says how it ended", () => {
	it("a running task is stopped within the call; the end is claimed for the STOP call, so no notice follows", async () => {
		const { manager, shell, stop } = setup();
		await shell.execute({ command: "sleep 30", background: true }, ctx());
		const s = await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
		expect(s).toMatchObject({ isError: false });
		expect(s.content).toMatch(/^stopped task t1 \(SIGTERM; it ran \d+(\.\d+)?s\)/);
		expect(manager.get("t1")!.state).toMatchObject({ kind: "ended", stopped: true });
		expect(claimsOf(manager, "t1")).toEqual([expect.objectContaining({ transition: "stopped", executionId: "ex-stop" })]);
	});

	it("Esc during the wait returns at once, claims nothing, and says the end is not confirmed", async () => {
		const { manager, shell, stop } = setup();
		// the whole group ignores TERM: the stop takes the 5 s grace, then KILL
		await shell.execute({ command: "trap '' TERM; sleep 30", background: true }, ctx());
		const t0 = Date.now();
		const s = await stop.execute({ id: "t1" }, escAfter(100, { executionId: "ex-stop" } as Partial<ToolContext>));
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(s.content).toMatch(/^stop requested for task t1; its end is not confirmed yet — you will be notified when it ends/);
		// the claim is what this pins, not how the stop ends: an idle machine
		// confirms it (ended); a loaded one may not (unknown) — either way
		// nothing was claimed, so the end is still noticed
		await until(() => manager.get("t1")!, settled, 15_000);
		expect(claimsOf(manager, "t1")).toEqual([]);
	}, 20_000);

	it("a stop the runner cannot confirm: Esc claims nothing, and the task reads unknown, never stopped", async () => {
		// the runner's knob reports the stop unconfirmed — what a sweep that
		// misses its deadline on a loaded machine reports
		const { manager, shell, stop } = setup({ KISO_TASK_RUNNER_STOP_UNCONFIRMED: "1" });
		await shell.execute({ command: "sleep 30", background: true }, ctx());
		await stop.execute({ id: "t1" }, escAfter(100, { executionId: "ex-stop" } as Partial<ToolContext>));
		// wait for the FACT this case is about — the runner's stop_unconfirmed
		// record — not merely a settled reading: on a loaded machine the
		// runner's identity check (every 5 s) can read `unknown` a moment
		// before the runner has written the record
		const unconfirmed = () => readRecords(join(manager.root, "t1", "journal.jsonl")).some((r) => r.type === "stop_unconfirmed");
		await until(() => unconfirmed(), (yes) => yes, 15_000);
		const t = await until(() => manager.get("t1")!, settled, 5_000);
		expect(t.state.kind).toBe("unknown");
		expect(claimsOf(manager, "t1")).toEqual([]);
	}, 20_000);
});

describe("ADR-0058 Amendment 7 — background with readyWhen waits for the ready line", () => {
	it("ready: the result says so, the task keeps running, and the ready is claimed for the shell call", async () => {
		const { manager, shell, stop } = setup();
		const r = await shell.execute({ command: "sleep 0.3; echo listening; sleep 30", background: true, readyWhen: "listening" }, ctx());
		expect(r).toMatchObject({ isError: false });
		expect(r.content).toMatch(/^started background task t1; ready — the output contains "listening"\./);
		expect(manager.get("t1")!.state).toEqual({ kind: "running", ready: true });
		expect(claimsOf(manager, "t1")).toEqual([expect.objectContaining({ transition: "ready", executionId: "ex-1" })]);
		await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
	});

	it("an end before the ready line fails the call, with its output, and is claimed", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "echo boom; exit 3", background: true, readyWhen: "listening" }, ctx());
		expect(r).toMatchObject({ isError: true });
		expect(r.content).toMatch(/^background task t1 ended before it was ready \(exit code 3\)/);
		expect(r.content).toContain("boom");
		expect(claimsOf(manager, "t1")).toEqual([expect.objectContaining({ transition: "failed", executionId: "ex-1" })]);
	});

	it("not ready within foregroundMs: the result never implies ready, the task keeps running, nothing is claimed", async () => {
		const { manager, shell, stop } = setup();
		const r = await shell.execute({ command: "sleep 30", background: true, readyWhen: "listening", foregroundMs: 300 }, ctx());
		expect(r).toMatchObject({ isError: false });
		expect(r.content).toMatch(/^not ready after 300 ms — no "listening" in the output yet; it keeps running as background task t1, and you will be notified when it is ready\./);
		expect(manager.get("t1")!.state).toEqual({ kind: "running", ready: false });
		expect(claimsOf(manager, "t1")).toEqual([]);
		await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
	});

	it("the person's detach RELEASES the wait: the one task keeps running, no second task, nothing claimed", async () => {
		const { base, manager, shell, stop } = setup();
		const pending = shell.execute({ command: "sleep 30", background: true, readyWhen: "listening", foregroundMs: 30_000 }, ctx({ executionId: "ex-bgw" } as Partial<ToolContext>));
		await until(() => manager.detachable(), (d) => d.some((x) => x.executionId === "ex-bgw"));
		expect(manager.detach("ex-bgw", "person")).toBe(true);
		const r = await pending;
		expect(r.content).toMatch(/^started background task t1; stopped waiting for "listening" \(moved on by the person\) — not ready yet; you will be notified when it is ready\./);
		expect(readdirSync(join(base, "s1.tasks"))).toEqual(["t1"]);
		expect(manager.get("t1")!.state).toEqual({ kind: "running", ready: false });
		expect(claimsOf(manager, "t1")).toEqual([]);
		expect(manager.detachable()).toEqual([]);
		await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
	});

	it("a steer releases the wait the same way, and says why", async () => {
		const { base, manager, shell, stop } = setup();
		const pending = shell.execute({ command: "sleep 30", background: true, readyWhen: "listening", foregroundMs: 30_000 }, ctx({ executionId: "ex-st" } as Partial<ToolContext>));
		await until(() => manager.detachable(), (d) => d.length === 1);
		manager.detach("ex-st", "steer");
		expect((await pending).content).toMatch(/^started background task t1; stopped waiting for "listening" \(so the person's message could land\) — not ready yet/);
		expect(readdirSync(join(base, "s1.tasks"))).toEqual(["t1"]);
		await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
	});

	it("Esc releases the wait; the task keeps running and nothing is claimed", async () => {
		const { manager, shell, stop } = setup();
		const r = await shell.execute({ command: "sleep 30", background: true, readyWhen: "listening", foregroundMs: 30_000 }, escAfter(150));
		expect(r.content).toMatch(/^started background task t1; stopped waiting for "listening" \(interrupted\) — not ready yet/);
		expect(manager.get("t1")!.state.kind).toBe("running");
		expect(claimsOf(manager, "t1")).toEqual([]);
		await stop.execute({ id: "t1" }, ctx({ executionId: "ex-stop" } as Partial<ToolContext>));
	});
});

describe("ADR-0058 Amendment 7 — the descriptions say when to background and what a stop does (0460-B1)", () => {
	it("background, readyWhen and task_stop carry the measured wording", () => {
		const { shell, stop } = setup();
		const props = (shell.parameters as { properties: Record<string, { description: string }> }).properties;
		expect(props.background!.description).toBe(
			"Run independently as a task. Use for services/watchers or work whose exit result is not needed next. If you need the result, keep it foreground and raise foregroundMs. You are notified when it ends; do not sleep/poll.",
		);
		expect(props.readyWhen!.description).toBe("For a continuing service, wait up to foregroundMs for this literal output before returning; the task keeps running afterward.");
		expect(stop.description).toBe("Stop a task, wait briefly for its terminal state, and report how it ended.");
	});
});
