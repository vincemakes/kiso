/**
 * Windows P1 — the process module's win32 branches, run on every OS.
 *
 * kiso's shell commands use POSIX shell syntax; on Windows they run through
 * Git Bash (never cmd.exe, never PowerShell), so the three shell safety
 * checks keep reading the language that actually runs. A process tree dies
 * through `taskkill /T /F`, and anything the module cannot confirm dead is
 * `unconfirmed` — the shell tool's UNCERTAIN wording, never "gone". A
 * process's start time comes from a CIM query, and "cannot tell" stays
 * distinct from "no such process".
 *
 * No Windows machine is needed: `process.platform` is set to "win32" per
 * case and `node:child_process` is scripted, so these run on the Linux CI
 * and on macOS. Windows paths are spelled with `path.win32`. The POSIX
 * path is pinned beside them: unchanged, byte for byte.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";

/** What an external program answers: its exit status and output, or a
 *  spawn failure (`error`, e.g. ENOENT). */
type Answer = { status?: number; stdout?: string; error?: NodeJS.ErrnoException };

const cp = vi.hoisted(() => ({
	/** Every external program run, in order: the file and its argv. */
	runs: [] as { file: string; args: readonly string[] }[],
	/** Every `spawn`, with its arguments exactly as passed. */
	spawns: [] as { file: string; args: readonly string[] | undefined; options: Record<string, unknown> }[],
	answer: (_file: string, _args: readonly string[]): Answer => ({ status: 0, stdout: "" }),
	/** What a spawned child writes before it closes. */
	childStdout: "",
}));

const fakeFiles = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return { ...real, existsSync: (p: unknown) => (typeof p === "string" && fakeFiles.has(p)) || real.existsSync(p as string) };
});

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	// a hoisted factory cannot see this file's imports
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const run = (file: string, args: readonly string[]): Answer => {
		cp.runs.push({ file, args: [...args] });
		return cp.answer(file, args);
	};
	class FakeChild extends EventEmitter {
		pid = 4242;
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		stdout = new PassThrough();
		stderr = new PassThrough();
		kill(): boolean {
			return true;
		}
		unref(): void {}
	}
	return {
		...real,
		spawn: (file: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
			const args = Array.isArray(argsOrOptions) ? (argsOrOptions as string[]) : undefined;
			const options = ((args === undefined ? argsOrOptions : maybeOptions) ?? {}) as Record<string, unknown>;
			cp.spawns.push({ file, args, options });
			const child = new FakeChild();
			setImmediate(() => {
				if (cp.childStdout !== "") child.stdout.write(cp.childStdout);
				child.stdout.end();
				child.stderr.end();
				child.exitCode = 0;
				child.emit("exit", 0, null);
				child.emit("close", 0, null);
			});
			return child;
		},
		execFileSync: (file: string, args: readonly string[] = [], opts?: { encoding?: string }) => {
			const a = run(file, args);
			if (a.error !== undefined) throw a.error;
			const stdout = a.stdout ?? "";
			if ((a.status ?? 0) !== 0) throw Object.assign(new Error(`${file} exited ${a.status}`), { status: a.status, stdout });
			return opts?.encoding !== undefined ? stdout : Buffer.from(stdout);
		},
		spawnSync: (file: string, args: readonly string[] = []) => {
			const a = run(file, args);
			return { pid: 1, status: a.error !== undefined ? null : (a.status ?? 0), signal: null, stdout: a.stdout ?? "", stderr: "", output: [], error: a.error };
		},
		execFile: (file: string, args: readonly string[], ...rest: unknown[]) => {
			const cb = rest.find((r) => typeof r === "function") as (err: unknown, stdout: string, stderr: string) => void;
			const a = run(file, args);
			setImmediate(() => {
				if (a.error !== undefined) cb(a.error, "", "");
				else if ((a.status ?? 0) !== 0) cb(Object.assign(new Error(`${file} exited ${a.status}`), { code: a.status }), a.stdout ?? "", "");
				else cb(null, a.stdout ?? "", "");
			});
			return new EventEmitter();
		},
	};
});

const { killTree, processStartTime, startCommand } = await import("../src/process.js");
const { shellTool } = await import("../src/index.js");
const { processTaskBackend } = await import("../src/process-backend.js");

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
};

const GIT_BASH = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
const GIT_BASH_X86 = win32.join("C:\\Program Files (x86)", "Git", "bin", "bash.exe");
const WSL_LAUNCHER = win32.join("C:\\Windows", "System32", "bash.exe");

const enoent = (file: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });

/** A Windows machine with nothing on it: no KISO_BASH, no Git, a PATH
 *  holding only the system directories. */
function bareWindows(): void {
	setPlatform("win32");
	vi.stubEnv("KISO_BASH", "");
	vi.stubEnv("ProgramFiles", "C:\\Program Files");
	vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
	vi.stubEnv("SystemRoot", "C:\\Windows");
	vi.stubEnv("PATH", ["C:\\Windows\\System32", "C:\\Windows"].join(win32.delimiter));
}

const NEVER_ABORT = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
const CTX = { signal: NEVER_ABORT } as unknown as ToolContext;
const ws = (): string => mkdtempSync(join(tmpdir(), "kiso-win32-"));

beforeEach(() => {
	cp.runs.length = 0;
	cp.spawns.length = 0;
	cp.answer = () => ({ status: 0, stdout: "" });
	cp.childStdout = "";
	fakeFiles.clear();
});

afterEach(() => {
	setPlatform(realPlatform);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("POSIX is unchanged (guards: green before and after P1)", () => {
	it("startCommand spawns the command through the shell, detached into its own group", () => {
		const cwd = ws();
		startCommand("echo hi", { cwd, env: { A: "1" } });
		expect(cp.spawns).toEqual([
			{ file: "echo hi", args: undefined, options: { shell: true, detached: true, cwd, stdio: ["ignore", "pipe", "pipe"], env: { A: "1" } } },
		]);
	});

	it("the shell tool's description names /bin/sh, byte for byte (without and with tasks wired)", () => {
		expect(shellTool({ workspaceRoot: ws() }).description).toBe(
			"Run a shell command through /bin/sh with the workspace root as the working directory: builds, tests, git, package managers, curl for HTTP APIs, system queries. Side effects are real; the human may be asked to approve the run. Fails loudly on timeout or non-zero exit.",
		);
		expect(shellTool({ workspaceRoot: ws(), tasks: () => undefined }).description).toBe(
			"Run a shell command through /bin/sh with the workspace root as the working directory: builds, tests, git, package managers, curl for HTTP APIs, system queries. Side effects are real; the human may be asked to approve the run. A command still running after foregroundMs is never killed: it continues as a background task, the result gives its id and output path, and you are notified when it ends. Fails loudly on a non-zero exit.",
		);
	});
});

describe("win32: which bash runs the command", () => {
	it("Git for Windows in Program Files: bash -c <command>, shell: false, hidden, never detached", () => {
		bareWindows();
		fakeFiles.add(GIT_BASH);
		const cwd = ws();
		startCommand("echo hi", { cwd, env: { A: "1" } });
		expect(cp.spawns).toHaveLength(1);
		const [s] = cp.spawns;
		expect(s!.file).toBe(GIT_BASH);
		expect(s!.args).toEqual(["-c", "echo hi"]);
		expect(s!.options.shell).toBe(false);
		expect(s!.options.windowsHide).toBe(true);
		expect(s!.options.detached).not.toBe(true);
		expect(s!.options.cwd).toBe(cwd);
		expect(s!.options.env).toEqual({ A: "1" });
	});

	it("the x86 Program Files install when that is the only one", () => {
		bareWindows();
		fakeFiles.add(GIT_BASH_X86);
		startCommand("true", { cwd: ws(), env: {} });
		expect(cp.spawns[0]!.file).toBe(GIT_BASH_X86);
	});

	it("KISO_BASH wins over the known install paths", () => {
		bareWindows();
		const msys = "D:\\msys64\\usr\\bin\\bash.exe";
		vi.stubEnv("KISO_BASH", msys);
		fakeFiles.add(msys);
		fakeFiles.add(GIT_BASH);
		startCommand("true", { cwd: ws(), env: {} });
		expect(cp.spawns[0]!.file).toBe(msys);
	});

	it("KISO_BASH's basename is matched case-insensitively (BASH.EXE is bash)", () => {
		bareWindows();
		const scoop = "C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\BASH.EXE";
		vi.stubEnv("KISO_BASH", scoop);
		fakeFiles.add(scoop);
		startCommand("true", { cwd: ws(), env: {} });
		expect(cp.spawns[0]!.file).toBe(scoop);
	});

	it("KISO_BASH naming another program fails fast — never a door to PowerShell or cmd", () => {
		bareWindows();
		const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		vi.stubEnv("KISO_BASH", pwsh);
		fakeFiles.add(pwsh);
		fakeFiles.add(GIT_BASH);
		expect(() => startCommand("true", { cwd: ws(), env: {} })).toThrow(/KISO_BASH.*bash/s);
		expect(cp.spawns).toHaveLength(0);
	});

	it("KISO_BASH pointing at nothing fails fast — no silent fallback to another bash", () => {
		bareWindows();
		vi.stubEnv("KISO_BASH", "D:\\missing\\bash.exe");
		fakeFiles.add(GIT_BASH);
		expect(() => startCommand("true", { cwd: ws(), env: {} })).toThrow(/KISO_BASH/);
		expect(cp.spawns).toHaveLength(0);
	});

	it("bash.exe on PATH, skipping the legacy WSL launcher in System32", () => {
		bareWindows();
		const onPath = "C:\\tools\\git\\usr\\bin";
		vi.stubEnv("PATH", ["C:\\Windows\\System32", onPath].join(win32.delimiter));
		fakeFiles.add(WSL_LAUNCHER);
		fakeFiles.add(win32.join(onPath, "bash.exe"));
		startCommand("true", { cwd: ws(), env: {} });
		expect(cp.spawns[0]!.file).toBe(win32.join(onPath, "bash.exe"));
	});

	it("no bash anywhere: an actionable error (install Git for Windows, or set KISO_BASH), nothing spawned", () => {
		bareWindows();
		fakeFiles.add(WSL_LAUNCHER);
		expect(() => startCommand("true", { cwd: ws(), env: {} })).toThrow(/Git for Windows[\s\S]*KISO_BASH|KISO_BASH[\s\S]*Git for Windows/);
		expect(cp.spawns).toHaveLength(0);
	});
});

describe("win32: the shell tool", () => {
	it("its description says bash, not /bin/sh (without and with tasks wired)", () => {
		bareWindows();
		for (const d of [shellTool({ workspaceRoot: ws() }).description, shellTool({ workspaceRoot: ws(), tasks: () => undefined }).description]) {
			expect(d).toMatch(/\bbash\b/);
			expect(d).not.toContain("/bin/sh");
		}
	});

	it("runs the command through bash and returns its output", async () => {
		bareWindows();
		fakeFiles.add(GIT_BASH);
		cp.childStdout = "hi\n";
		const result = await shellTool({ workspaceRoot: ws() }).execute({ command: "echo hi" }, CTX);
		expect(result).toMatchObject({ isError: false, content: "hi" });
		expect(cp.spawns[0]!.file).toBe(GIT_BASH);
		expect(cp.spawns[0]!.args).toEqual(["-c", "echo hi"]);
	});

	it("no bash: an error result the model can read — kiso keeps running, the file tools still work", async () => {
		bareWindows();
		const result = await shellTool({ workspaceRoot: ws() }).execute({ command: "echo hi" }, CTX);
		expect(result.isError).toBe(true);
		expect(String(result.content)).toMatch(/Git for Windows/);
		expect(String(result.content)).toMatch(/KISO_BASH/);
		expect(cp.spawns).toHaveLength(0);
	});
});

describe("win32: killTree keeps its contract — anything not confirmed dead is unconfirmed", () => {
	/** A running child of pid 4242; `alive` answers the liveness probe. */
	function running(alive: () => boolean) {
		const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: () => true });
		const kills: [number, string | number | undefined][] = [];
		vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			kills.push([pid, signal]);
			if ((signal === 0 || signal === undefined) && !alive()) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			return true;
		}) as typeof process.kill);
		return { child: child as unknown as import("node:child_process").ChildProcess, kills };
	}

	const taskkillRuns = () => cp.runs.filter((r) => /^taskkill(\.exe)?$/i.test(win32.basename(r.file)));

	function expectTaskkillOf(pid: number): void {
		const runs = taskkillRuns();
		expect(runs).toHaveLength(1);
		const args = runs[0]!.args.map((a) => a.toUpperCase());
		expect(args).toContain("/T");
		expect(args).toContain("/F");
		expect(args[args.indexOf("/PID") + 1]).toBe(String(pid));
	}

	it("taskkill /T /F /PID succeeds and the root is gone: confirmed", async () => {
		bareWindows();
		let dead = false;
		cp.answer = (file) => {
			if (/taskkill/i.test(file)) dead = true;
			return { status: 0, stdout: "" };
		};
		const { child, kills } = running(() => !dead);
		expect(await killTree(child)).toEqual({ unconfirmed: [] });
		expectTaskkillOf(4242);
		// no POSIX machinery: no group kill, no freeze, no ps walk
		expect(kills.some(([pid]) => pid < 0)).toBe(false);
		expect(kills.some(([, sig]) => sig === "SIGSTOP")).toBe(false);
		expect(cp.runs.some((r) => r.file === "ps")).toBe(false);
	});

	it("taskkill exits non-zero: the root is unconfirmed, even if it is gone (a child may have survived)", async () => {
		bareWindows();
		cp.answer = (file) => (/taskkill/i.test(file) ? { status: 1, stdout: "ERROR: access is denied" } : { status: 0 });
		const { child } = running(() => false);
		expect(await killTree(child)).toEqual({ unconfirmed: [4242] });
		expectTaskkillOf(4242);
	});

	it("taskkill cannot start: unconfirmed", async () => {
		bareWindows();
		cp.answer = (file) => (/taskkill/i.test(file) ? { error: enoent(file) } : { status: 0 });
		const { child } = running(() => true);
		expect(await killTree(child)).toEqual({ unconfirmed: [4242] });
		expect(taskkillRuns()).toHaveLength(1);
	}, 10_000);

	it("taskkill succeeds but the root is still alive: unconfirmed", async () => {
		bareWindows();
		const { child } = running(() => true);
		expect(await killTree(child)).toEqual({ unconfirmed: [4242] });
		expectTaskkillOf(4242);
	}, 10_000);

	it("graceMs: Windows has no TERM for a console tree — the stop is forced at once, never after the grace", async () => {
		bareWindows();
		let dead = false;
		cp.answer = (file) => {
			if (/taskkill/i.test(file)) dead = true;
			return { status: 0, stdout: "" };
		};
		const { child, kills } = running(() => !dead);
		const t0 = Date.now();
		expect(await killTree(child, { graceMs: 5_000 })).toEqual({ unconfirmed: [] });
		expect(Date.now() - t0).toBeLessThan(2_000);
		expectTaskkillOf(4242);
		expect(kills.some(([pid, sig]) => pid < 0 || sig === "SIGTERM")).toBe(false);
	}, 15_000);
});

describe("win32: processStartTime — running, gone, or unknown (never a failed query read as gone)", () => {
	const ps = () => cp.runs.filter((r) => /^powershell(\.exe)?$/i.test(win32.basename(r.file)));

	it("asks PowerShell for the process's creation time, never `ps`", () => {
		bareWindows();
		cp.answer = () => ({ status: 0, stdout: "2026-09-30T03:04:05.6789012Z\r\n" });
		expect(processStartTime(4242)).toEqual({ kind: "running", startedAt: "2026-09-30T03:04:05.6789012Z" });
		expect(ps()).toHaveLength(1);
		expect(ps()[0]!.args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive"]));
		expect(ps()[0]!.args.join(" ")).toContain("4242");
		expect(cp.runs.some((r) => r.file === "ps")).toBe(false);
	});

	it("the query says there is no such process: gone", () => {
		bareWindows();
		cp.answer = () => ({ status: 0, stdout: "gone\r\n" });
		expect(processStartTime(4242)).toEqual({ kind: "gone" });
	});

	it("PowerShell cannot start: unknown", () => {
		bareWindows();
		cp.answer = (file) => ({ error: enoent(file) });
		expect(processStartTime(4242)).toEqual({ kind: "unknown" });
		expect(ps()).toHaveLength(1);
	});

	it("the query fails: unknown", () => {
		bareWindows();
		cp.answer = () => ({ status: 1, stdout: "" });
		expect(processStartTime(4242)).toEqual({ kind: "unknown" });
	});

	it("an empty or unexpected answer: unknown, not gone", () => {
		bareWindows();
		cp.answer = () => ({ status: 0, stdout: "" });
		expect(processStartTime(4242)).toEqual({ kind: "unknown" });
		cp.answer = () => ({ status: 0, stdout: "Get-CimInstance : Invalid class\r\n" });
		expect(processStartTime(4242)).toEqual({ kind: "unknown" });
	});
});

describe("win32: a task stop is the journal's stop_requested record, never a signal", () => {
	it("signalStop does not call process.kill — on Windows that is TerminateProcess, and the runner would die without its record", () => {
		bareWindows();
		const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		processTaskBackend({ runnerPath: "/nowhere/task-runner.js" }).signalStop(4242);
		expect(kill).not.toHaveBeenCalled();
		expect(cp.runs.some((r) => /taskkill/i.test(r.file))).toBe(false);
	});

	it("POSIX keeps SIGTERM as the fast path (guard)", () => {
		const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		processTaskBackend({ runnerPath: "/nowhere/task-runner.js" }).signalStop(4242);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
	});
});

describe("the task runner's detached spawn is hidden (no console window on Windows)", () => {
	it("windowsHide: true beside detached: true", async () => {
		const dir = ws();
		writeFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "runner_started", pid: 1, startedAt: "" })}\n`);
		await processTaskBackend({ runnerPath: "/nowhere/task-runner.js" }).spawn({ dir, env: {} });
		expect(cp.spawns).toHaveLength(1);
		expect(cp.spawns[0]!.options).toMatchObject({ detached: true, windowsHide: true });
	});
});
