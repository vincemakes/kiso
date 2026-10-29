/**
 * The shell's own exit versus `close`. A descendant that keeps the command's
 * stdout/stderr open (a daemon the command started) holds `close` back while
 * the shell itself is long gone. The foreground path used to settle only on
 * `close`, so such a call came back as a timeout error that dropped the
 * output the command had already produced, or as "still running" for a
 * command that had finished.
 *
 * F1: with a task manager, the exit plus a drain window with no `close` hands
 * the output and the descendants to the manager and says so; without one the
 * call is not reported complete and keeps its kill timeout and abort.
 * Nothing destroys the pipes: a descendant that keeps writing must not die of
 * SIGPIPE, and everything it writes lands in the task's output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "../src/process-backend.js";
import { shellTool, taskStopTool, type ShellTasks } from "../src/index.js";

const RUNNER = fileURLToPath(new URL("../dist/task-runner.js", import.meta.url));
const backend = processTaskBackend({ runnerPath: RUNNER });

function ctx(signal?: AbortSignal): ToolContext {
	const s = signal ?? { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
	return { signal: s, sessionId: "s1", executionId: "ex-1" } as unknown as ToolContext;
}

function setup(withTasks: boolean, minForegroundMs = 30_000) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-exitlife-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
	const opts = {
		workspaceRoot: cwd,
		...(withTasks ? { tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined), limits: { minForegroundMs } } : {}),
	};
	return { base, cwd, manager, shell: shellTool(opts), stop: taskStopTool(opts) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a killed process nobody has reaped yet (a zombie under load) is not alive */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
	} catch {
		return false;
	}
};
/** the record types of a task's journal, in order */
function journalTypes(base: string, id: string): string[] {
	return readFileSync(join(base, "s1.tasks", id, "journal.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => (JSON.parse(l) as { type: string }).type);
}
async function until(pred: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return true;
		await sleep(25);
	}
	return pred();
}

describe("F1 — the shell exited, a descendant holds its output, a manager is wired", () => {
	it("returns at the exit plus the drain window with an explicit background status, not at the wait and not at close", async () => {
		const { manager, shell } = setup(true);
		const t0 = Date.now();
		const r = await shell.execute({ command: "sleep 4 & echo started" }, ctx());
		const took = Date.now() - t0;
		expect(took).toBeLessThan(2_500);
		expect(r.isError).toBe(false);
		const text = String(r.content);
		expect(text).toMatch(/^the command exited \(code 0, after \d+ ms\), but processes it started are still running and hold its output;/);
		expect(text).toMatch(/they continue as background task t1 \(not killed — it keeps running\)/);
		expect(text).toContain("started");
		expect(text).not.toMatch(/still running after/);
		expect((manager.get("t1") as { state: { kind: string } }).state.kind).toBe("running");
		manager.close();
	}, 20_000);

	it("the task ends when the last holder lets go, with the command's own exit code", async () => {
		const { manager, shell } = setup(true);
		await shell.execute({ command: "sleep 1 & echo started" }, ctx());
		expect(await until(() => (manager.get("t1") as { state: { kind: string } }).state.kind !== "running", 8_000)).toBe(true);
		expect((manager.get("t1") as { state: { kind: string; exitCode?: number } }).state).toMatchObject({ kind: "ended", exitCode: 0 });
		manager.close();
	}, 20_000);

	it("pipes stay open: a descendant that writes after the result lives on, and its output lands in the task", async () => {
		const { manager, shell } = setup(true);
		const r = await shell.execute({ command: "(sleep 1; echo late; sleep 1; echo later) & echo first" }, ctx());
		expect(String(r.content)).toContain("first");
		const out = /Output: (\S+)/.exec(String(r.content))?.[1] ?? "";
		expect(out).not.toBe("");
		expect(await until(() => (manager.get("t1") as { state: { kind: string } }).state.kind !== "running", 10_000)).toBe(true);
		const body = readFileSync(out, "utf8");
		expect(body).toContain("first");
		expect(body).toContain("late");
		expect(body).toContain("later"); // a destroyed pipe would have killed the subshell with SIGPIPE before this line
		manager.close();
	}, 20_000);

	it("a non-zero exit is an error, and still names the manager's hold", async () => {
		const { manager, shell } = setup(true);
		const r = await shell.execute({ command: "sleep 3 & echo oops; exit 3" }, ctx());
		expect(r.isError).toBe(true);
		expect((r as { errorKind?: string }).errorKind).toBe("fatal");
		const text = String(r.content);
		expect(text).toMatch(/exited \(code 3, after \d+ ms\) and FAILED/);
		expect(text).toMatch(/processes it started are still running/);
		expect(text).toMatch(/its side effects may be incomplete/);
		expect(text).toMatch(/background task t1/);
		manager.close();
	}, 20_000);

	it("task_stop on the handed-over task takes the descendants down (no unmanaged child is left)", async () => {
		const { base, manager, shell, stop } = setup(true);
		const pidFile = join(base, "child.pid");
		const r = await shell.execute({ command: `sleep 60 & echo $! > ${pidFile}; echo started` }, ctx());
		expect(String(r.content)).toMatch(/background task t1/);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		expect(alive(pid)).toBe(true);
		const s = await stop.execute({ id: "t1" }, ctx());
		// what the sweep can see is killed; that nothing else is left cannot be shown, so the
		// answer is "not confirmed" (and returns when the unknown is recorded, not after 8 s)
		expect(String(s.content)).toMatch(/^task t1 could not be confirmed stopped/);
		expect(s.isError).toBe(true);
		expect(await until(() => !alive(pid), 8_000)).toBe(true);
		expect((manager.get("t1") as { state: { kind: string } }).state.kind).toBe("unknown");
		manager.close();
	}, 30_000);

	it("an aborted call that has not reached the drain window still kills the tree", async () => {
		const { base, manager, shell } = setup(true);
		const pidFile = join(base, "child.pid");
		const ac = new AbortController();
		const pending = shell.execute({ command: `sleep 60 & echo $! > ${pidFile}; echo started; sleep 60` }, ctx(ac.signal));
		await until(() => existsSync(pidFile), 3_000);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		await sleep(400); // "started" has been read by now
		ac.abort();
		const r = await pending;
		expect(String(r.content)).toMatch(/^shell aborted/);
		expect(String(r.content)).toContain("started");
		expect(await until(() => !alive(pid), 5_000)).toBe(true);
		manager.close();
	}, 20_000);

	it("a descendant that writes every 100 ms cannot keep the call in the foreground: the hand-over is bounded", async () => {
		const { base, manager, shell } = setup(true, 20_000);
		const pidFile = join(base, "ticker.pid");
		const t0 = Date.now();
		const r = await shell.execute({ command: `(while true; do echo tick; sleep 0.1; done) & echo $! > ${pidFile}; echo started` }, ctx());
		const took = Date.now() - t0;
		try {
			expect(took).toBeGreaterThanOrEqual(1_800); // the renewals ran to the cap
			expect(took).toBeLessThan(3_500);
			expect(String(r.content)).toMatch(/background task t1/);
			expect(String(r.content)).not.toMatch(/still running after/);
		} finally {
			try {
				process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
			} catch {
				// already gone
			}
			manager.close();
		}
	}, 20_000);

	it("a descendant that left the process group and was reparented: task_stop never claims it stopped while it lives", async () => {
		const { base, manager, shell, stop } = setup(true);
		const pidFile = join(base, "escaped.pid");
		const r = await shell.execute({ command: `python3 -c "import subprocess;p=subprocess.Popen(['sleep','60'],start_new_session=True);open('${pidFile}','w').write(str(p.pid))"; echo started` }, ctx());
		expect(String(r.content)).toMatch(/background task t1/);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		try {
			expect(alive(pid)).toBe(true);
			const t0 = Date.now();
			const s = await stop.execute({ id: "t1" }, ctx());
			expect(Date.now() - t0).toBeLessThan(6_000); // the unknown answers the wait; it does not run out the 8 s
			expect(String(s.content)).toMatch(/^task t1 could not be confirmed stopped — some of its processes may still be running/);
			expect(s.isError).toBe(true);
			expect(alive(pid)).toBe(true); // nothing in the pid table leads to it: the claim is withheld, not made
			expect((manager.get("t1") as { state: { kind: string } }).state.kind).toBe("unknown");
		} finally {
			process.kill(pid, "SIGKILL");
			await until(() => !alive(pid), 3_000);
			manager.close();
		}
	}, 40_000);

	it("a hand-over that fails after the task was recorded keeps the call waiting and records the task as unknown with the reason, never as ended or not run", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-exitlife-")));
		const cwd = join(base, "ws");
		mkdirSync(cwd);
		const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
		const flaky: ShellTasks = new Proxy(manager as unknown as ShellTasks, {
			get(target, key) {
				if (key === "adopt") {
					return (o: Parameters<ShellTasks["adopt"]>[0]) => {
						const a = target.adopt(o);
						return { ...a, outputPath: "/nonexistent-dir/x/output.log" }; // the sink cannot be opened
					};
				}
				const v = (target as unknown as Record<string | symbol, unknown>)[key];
				return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
			},
		});
		const shell = shellTool({ workspaceRoot: cwd, tasks: () => flaky, limits: { minForegroundMs: 30_000 } });
		const t0 = Date.now();
		const r = await shell.execute({ command: "sleep 2 & echo started" }, ctx());
		expect(Date.now() - t0).toBeGreaterThanOrEqual(1_800); // waited for the holder, not handed over
		expect(r).toMatchObject({ isError: false, content: "started" });
		// the command was running and did not end under that task: the failure is on record
		// with its reason, no terminal is written, and the task is unknown — not not_run, not running
		const types = journalTypes(base, "t1");
		expect(types).toContain("handover_failed");
		expect(types).not.toContain("terminal");
		expect(types).not.toContain("stop_unconfirmed");
		expect((manager.get("t1") as { state: { kind: string } }).state.kind).toBe("unknown");
		manager.close();
	}, 20_000);

	it("the pipes closing is not proof of a stop: a descendant outside the group that closes its stdout/stderr and lives on keeps the stop unconfirmed", async () => {
		const { base, manager, shell, stop } = setup(true);
		const pidFile = join(base, "quiet.pid");
		const flag = join(base, "close-now");
		const mark = join(base, "closed");
		writeFileSync(
			join(base, "desc.py"),
			`import os, time\nwhile not os.path.exists(${JSON.stringify(flag)}):\n    time.sleep(0.05)\nos.close(1)\nos.close(2)\nopen(${JSON.stringify(mark)}, "w").write("closed")\ntime.sleep(60)\n`,
		);
		writeFileSync(
			join(base, "launch.py"),
			`import subprocess, sys\np = subprocess.Popen([sys.executable, ${JSON.stringify(join(base, "desc.py"))}], start_new_session=True)\nopen(${JSON.stringify(pidFile)}, "w").write(str(p.pid))\n`,
		);
		const r = await shell.execute({ command: `python3 ${join(base, "launch.py")}; echo started` }, ctx());
		expect(String(r.content)).toMatch(/background task t1/);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		try {
			expect(alive(pid)).toBe(true);
			const stopping = stop.execute({ id: "t1" }, ctx());
			await sleep(300);
			writeFileSync(flag, "x"); // the descendant now lets go of the pipes, as the stop is under way
			const s = await stopping;
			expect(existsSync(mark)).toBe(true); // it closed its stdio; the pipes had no holder left
			expect(alive(pid)).toBe(true); // ...and it lives
			expect(String(s.content)).toMatch(/^task t1 could not be confirmed stopped/);
			expect(s.isError).toBe(true);
			const types = journalTypes(base, "t1");
			expect(types).toContain("stop_unconfirmed");
			expect(types).not.toContain("terminal");
			expect((manager.get("t1") as { state: { kind: string } }).state.kind).toBe("unknown");
		} finally {
			process.kill(pid, "SIGKILL");
			await until(() => !alive(pid), 3_000);
			manager.close();
		}
	}, 60_000);

	it("a hand-over the manager refuses is not success: the call keeps waiting and settles at close", async () => {
		const refusing: ShellTasks = {
			root: tmpdir(),
			start: async () => {
				throw new Error("unused");
			},
			adopt: () => {
				throw new Error("refused");
			},
			stop: () => false,
			get: () => undefined,
		};
		const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-exitlife-")));
		const shell = shellTool({ workspaceRoot: base, tasks: () => refusing, limits: { minForegroundMs: 30_000 } });
		const t0 = Date.now();
		const r = await shell.execute({ command: "sleep 2 & echo started" }, ctx());
		expect(Date.now() - t0).toBeGreaterThanOrEqual(1_800); // not before the holder let go
		expect(r).toMatchObject({ isError: false });
		expect(String(r.content)).toBe("started");
	}, 20_000);

	it("the ordinary paths are unchanged: a plain command, and a redirected daemon, return at once without a task", async () => {
		const { manager, shell } = setup(true);
		const a = await shell.execute({ command: "echo hi" }, ctx());
		expect(a).toMatchObject({ isError: false, content: "hi" });
		const t0 = Date.now();
		const b = await shell.execute({ command: "sleep 3 >/dev/null 2>&1 & echo started" }, ctx());
		expect(Date.now() - t0).toBeLessThan(1_500);
		expect(b).toMatchObject({ isError: false, content: "started" });
		expect(manager.get("t1")).toBeUndefined();
		await sleep(50);
		manager.close();
	}, 20_000);
});

describe("no manager — the call is not complete while a descendant holds the output", () => {
	it("is never reported as success: it waits for close under the kill timeout and the timeout carries the output and the exit fact (F2)", async () => {
		const { base, shell } = setup(false);
		const pidFile = join(base, "child.pid");
		const t0 = Date.now();
		const r = await shell.execute({ command: `sleep 60 & echo $! > ${pidFile}; echo started`, timeoutMs: 1_500 }, ctx());
		expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
		expect(r.isError).toBe(true);
		const text = String(r.content);
		expect(text).toMatch(/^shell timed out after 1500ms/);
		expect(text).toMatch(/the command itself had already exited \(code 0, after \d+ ms\) but processes it started still held its output/);
		expect(text).toContain("started");
		expect(await until(() => !alive(Number(readFileSync(pidFile, "utf8").trim())), 5_000)).toBe(true);
	}, 20_000);

	it("a descendant that lets go within the timeout gives the plain result", async () => {
		const { shell } = setup(false);
		const r = await shell.execute({ command: "sleep 1 & echo started", timeoutMs: 10_000 }, ctx());
		expect(r).toMatchObject({ isError: false, content: "started" });
	}, 20_000);
});
