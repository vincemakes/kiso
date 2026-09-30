/**
 * ADR-0058 §6 — the process task backend: it spawns a task's runner.
 *
 * It satisfies the runtime's `TaskBackend` structurally — tools-node takes
 * no dependency on the runtime; the host hands this backend to the
 * runtime's TaskManager, and the compiler checks the fit there.
 *
 * The runner is detached (its own session and process group) and unref'd:
 * kiso's exit or death does not take it along. A clean exit stops tasks
 * through the manager, deliberately.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processStartTime } from "./process.js";

export interface ProcessTaskBackendOptions {
	/** The runner script. Default: the one shipped beside this module. */
	readonly runnerPath?: string;
	/** How long the runner has to record itself. Default 10 s. */
	readonly startTimeoutMs?: number;
}

export interface ProcessTaskBackend {
	spawn(spec: { readonly dir: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<void>;
	identify(pid: number, startedAt: string): "verified" | "gone" | "unverifiable";
	signalStop(pid: number): void;
}

export function processTaskBackend(options: ProcessTaskBackendOptions = {}): ProcessTaskBackend {
	const runnerPath = options.runnerPath ?? fileURLToPath(new URL("./task-runner.js", import.meta.url));
	return {
		async spawn({ dir, env }) {
			const clean: Record<string, string> = {};
			for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
			const child = spawn(process.execPath, [runnerPath, dir], { detached: true, windowsHide: true, stdio: "ignore", env: clean });
			child.unref();
			const journal = join(dir, "journal.jsonl");
			const deadline = Date.now() + (options.startTimeoutMs ?? 10_000);
			while (Date.now() < deadline) {
				if (existsSync(journal) && readFileSync(journal, "utf8").includes('"type":"runner_started"')) return;
				await new Promise((r) => setTimeout(r, 15));
			}
			throw new Error(`the task runner did not record itself within ${options.startTimeoutMs ?? 10_000} ms (${dir})`);
		},
		identify(pid, startedAt) {
			try {
				process.kill(pid, 0);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EPERM") return "gone";
			}
			// The pid is live. Only its OS start time says whose it is: equal to
			// the recorded one — the runner; another — a stranger holds the
			// pid; none readable (now, or recorded as "") — unverifiable,
			// which is never taken for the runner (ADR-0058 §6: "when identity
			// cannot be verified, the verdict is the gone row").
			const id = processStartTime(pid);
			if (id.kind === "gone") return "gone";
			if (id.kind === "unknown" || startedAt === "") return "unverifiable";
			return id.startedAt === startedAt ? "verified" : "gone";
		},
		signalStop(pid) {
			// win32: process.kill is TerminateProcess — the runner would die
			// before its stop runs. The journal's stop_requested record, written
			// before this call, is the channel there; the runner watches it.
			if (process.platform === "win32") return;
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// already gone
			}
		},
	};
}
