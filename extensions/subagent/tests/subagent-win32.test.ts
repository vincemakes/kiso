/**
 * Windows P1 — the subagent extension's own win32 branch. Its copy-only
 * build has zero runtime dependencies, so it keeps its own short copy of
 * the bash rule instead of importing tools-node; the agreement block below
 * pins that copy to the process module: the same machines, the same bash
 * (or the same refusal).
 *
 * On win32 an acceptance check runs through bash, never /bin/sh; nothing
 * is detached into a process group (Windows has none) and nothing opens a
 * console window; a timeout or an abort kills the tree with taskkill /T /F.
 * Runs on every OS: `process.platform` is set per case and
 * `node:child_process` is scripted.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { status?: number; stdout?: string; error?: NodeJS.ErrnoException };

const cp = vi.hoisted(() => ({
	runs: [] as { file: string; args: readonly string[] }[],
	spawns: [] as { file: string; args: readonly string[] | undefined; options: Record<string, unknown> }[],
	answer: (_file: string, _args: readonly string[]): Answer => ({ status: 0, stdout: "" }),
	/** false: a spawned child runs until something kills it. */
	autoExit: true,
	last: null as null | { exit: (code: number | null, signal: string | null) => void },
}));

const fakeFiles = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	// a Windows-spelled path answers from the fake disk alone: on a real
	// Windows runner the real Git install must not leak into the cases
	const windowsy = (p: string): boolean => /^[A-Za-z]:/.test(p) || p.includes("\\");
	return { ...real, existsSync: (p: unknown) => (typeof p === "string" && windowsy(p) ? fakeFiles.has(p) : real.existsSync(p as string)) };
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
		signalCode: string | null = null;
		stdin = new PassThrough();
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
			let done = false;
			const exit = (code: number | null, signal: string | null): void => {
				if (done) return;
				done = true;
				child.exitCode = code;
				child.stdout.end();
				child.stderr.end();
				child.emit("exit", code, signal);
				child.emit("close", code, signal);
			};
			cp.last = { exit };
			if (cp.autoExit) setImmediate(() => exit(0, null));
			return child;
		},
		execFileSync: (file: string, args: readonly string[] = [], opts?: { encoding?: string }) => {
			const a = run(file, args);
			if (a.error !== undefined) throw a.error;
			const stdout = a.stdout ?? "";
			if ((a.status ?? 0) !== 0) throw Object.assign(new Error(`${file} exited ${a.status}`), { status: a.status, stdout });
			return opts?.encoding !== undefined ? stdout : Buffer.from(stdout);
		},
	};
});

const { runAcceptance } = await import("../dist/kiso-subagent.mjs");
const { startCommand } = await import("../../../packages/tools-node/src/process.js");

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
};

const GIT_BASH = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
const GIT_BASH_X86 = win32.join("C:\\Program Files (x86)", "Git", "bin", "bash.exe");
const WSL_LAUNCHER = win32.join("C:\\Windows", "System32", "bash.exe");

function bareWindows(): void {
	setPlatform("win32");
	vi.stubEnv("KISO_BASH", "");
	vi.stubEnv("ProgramFiles", "C:\\Program Files");
	vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
	vi.stubEnv("SystemRoot", "C:\\Windows");
	vi.stubEnv("PATH", ["C:\\Windows\\System32", "C:\\Windows"].join(win32.delimiter));
}

const ws = (): string => mkdtempSync(join(tmpdir(), "kiso-sub-win32-"));
const CHECK = [{ check: "test" }, { checks: { test: "npm test" } }] as const;
const taskkillRuns = () => cp.runs.filter((r) => /^taskkill(\.exe)?$/i.test(win32.basename(r.file)));

beforeEach(() => {
	cp.runs.length = 0;
	cp.spawns.length = 0;
	cp.answer = () => ({ status: 0, stdout: "" });
	cp.autoExit = true;
	cp.last = null;
	fakeFiles.clear();
});

afterEach(() => {
	setPlatform(realPlatform);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("POSIX is unchanged (guards)", () => {
	it("a check runs through /bin/sh, detached into its own group", async () => {
		setPlatform("linux");
		const dir = ws();
		const r = await runAcceptance(CHECK[0], CHECK[1], dir, "HEAD", 5_000, undefined);
		expect(r.exitCode).toBe(0);
		const s = cp.spawns.at(-1)!;
		expect(s.file).toBe("/bin/sh");
		expect(s.args).toEqual(["-c", "npm test"]);
		expect(s.options.detached).toBe(true);
	});

	it("a timeout kills the whole process group", async () => {
		setPlatform("linux");
		cp.autoExit = false;
		const kills: [number, unknown][] = [];
		vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
			kills.push([pid, sig]);
			cp.last?.exit(null, "SIGKILL");
			return true;
		}) as typeof process.kill);
		const r = await runAcceptance(CHECK[0], CHECK[1], ws(), "HEAD", 50, undefined);
		expect(r.killed).toBe("timeout");
		expect(kills).toContainEqual([-4242, "SIGKILL"]);
	});
});

describe("win32: an acceptance check", () => {
	it("runs through Git Bash, bash -c <check>, hidden, never detached", async () => {
		bareWindows();
		fakeFiles.add(GIT_BASH);
		const r = await runAcceptance(CHECK[0], CHECK[1], ws(), "HEAD", 5_000, undefined);
		expect(r.exitCode).toBe(0);
		const s = cp.spawns.at(-1)!;
		expect(s.file).toBe(GIT_BASH);
		expect(s.args).toEqual(["-c", "npm test"]);
		expect(s.options.windowsHide).toBe(true);
		expect(s.options.detached).not.toBe(true);
	});

	it("an evaluator is hidden and never detached either", async () => {
		bareWindows();
		const r = await runAcceptance({ evaluator: "C:\\tools\\eval.exe" }, { checks: {} }, ws(), "HEAD", 5_000, undefined);
		expect(r.exitCode).toBe(0);
		const s = cp.spawns.at(-1)!;
		expect(s.file).toBe("C:\\tools\\eval.exe");
		expect(s.options.windowsHide).toBe(true);
		expect(s.options.detached).not.toBe(true);
	});

	it("no bash: the check fails with the actionable message, nothing spawned", async () => {
		bareWindows();
		const r = await runAcceptance(CHECK[0], CHECK[1], ws(), "HEAD", 5_000, undefined);
		expect(r.passed).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(r.tail).toMatch(/Git for Windows/);
		expect(r.tail).toMatch(/KISO_BASH/);
		expect(cp.spawns).toHaveLength(0);
	});

	it("a timeout kills the tree with taskkill /T /F, never a process-group signal", async () => {
		bareWindows();
		fakeFiles.add(GIT_BASH);
		cp.autoExit = false;
		cp.answer = (file) => {
			if (/taskkill/i.test(file)) cp.last?.exit(1, null);
			return { status: 0, stdout: "" };
		};
		const kills: [number, unknown][] = [];
		vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
			kills.push([pid, sig]);
			cp.last?.exit(null, "SIGKILL");
			return true;
		}) as typeof process.kill);
		const r = await runAcceptance(CHECK[0], CHECK[1], ws(), "HEAD", 50, undefined);
		expect(r.killed).toBe("timeout");
		expect(taskkillRuns()).toHaveLength(1);
		const args = taskkillRuns()[0]!.args.map((a) => a.toUpperCase());
		expect(args).toEqual(expect.arrayContaining(["/T", "/F", "/PID", "4242"]));
		expect(kills.some(([pid]) => pid < 0)).toBe(false);
	});
});

describe("agreement: the subagent's copy of the bash rule picks what the process module picks", () => {
	const machines: { name: string; setup: () => void }[] = [
		{ name: "Git for Windows", setup: () => fakeFiles.add(GIT_BASH) },
		{ name: "the x86 install only", setup: () => fakeFiles.add(GIT_BASH_X86) },
		{
			name: "KISO_BASH over Program Files",
			setup: () => {
				vi.stubEnv("KISO_BASH", "D:\\msys64\\usr\\bin\\bash.exe");
				fakeFiles.add("D:\\msys64\\usr\\bin\\bash.exe");
				fakeFiles.add(GIT_BASH);
			},
		},
		{
			name: "KISO_BASH naming PowerShell",
			setup: () => {
				vi.stubEnv("KISO_BASH", "C:\\pwsh\\pwsh.exe");
				fakeFiles.add("C:\\pwsh\\pwsh.exe");
				fakeFiles.add(GIT_BASH);
			},
		},
		{ name: "KISO_BASH missing", setup: () => (vi.stubEnv("KISO_BASH", "D:\\gone\\bash.exe"), fakeFiles.add(GIT_BASH)) },
		{
			name: "PATH past the WSL launcher",
			setup: () => {
				vi.stubEnv("PATH", ["C:\\Windows\\System32", "C:\\git\\usr\\bin"].join(win32.delimiter));
				fakeFiles.add(WSL_LAUNCHER);
				fakeFiles.add("C:\\git\\usr\\bin\\bash.exe");
			},
		},
		{ name: "only the WSL launcher", setup: () => fakeFiles.add(WSL_LAUNCHER) },
	];

	for (const m of machines) {
		it(m.name, async () => {
			bareWindows();
			m.setup();
			let module: string;
			try {
				startCommand("true", { cwd: ws(), env: {} });
				module = cp.spawns.at(-1)!.file;
			} catch {
				module = "(refused)";
			}
			cp.spawns.length = 0;
			await runAcceptance(CHECK[0], CHECK[1], ws(), "HEAD", 5_000, undefined);
			const subagent = cp.spawns.at(-1)?.file ?? "(refused)";
			expect(subagent).toBe(module);
		});
	}
});
