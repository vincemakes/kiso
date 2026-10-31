/**
 * Background tasks (ADR-0058) for the web app's sessions.
 *
 * THE ONE FILE that reaches behind the public surface: the TaskManager and
 * its journal types are exported only from `@vincemakes/kiso-runtime/internal`
 * today. scripts/check-imports.mjs allows exactly this file to do so, and
 * the spike report proposes the root export that removes the exception.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { TaskManager, type TaskInfo } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend, type ShellTasks } from "@vincemakes/kiso-tools-node";
import type { TaskRow } from "../shared/frames.js";

export type { TaskInfo };
export { TaskManager };

export interface TaskHub {
	/** The `tasks` option of the coding tools: one manager per session. */
	readonly shellTasks: (sessionId: string | undefined) => ShellTasks | undefined;
	/** The manager itself, for `session.useTasks` and the frames. */
	readonly managerFor: (sessionId: string) => TaskManager;
	/** Stop every task the process owns and release the pollers. */
	readonly close: () => Promise<void>;
}

export function createTaskHub(storeRoot: string): TaskHub {
	// the runner is started with process.execPath: the host is plain node, so the runner is too
	const backend = processTaskBackend();
	const managers = new Map<string, TaskManager>();
	const managerFor = (sessionId: string): TaskManager => {
		let manager = managers.get(sessionId);
		if (manager === undefined) {
			manager = new TaskManager({ root: join(storeRoot, `${sessionId}.tasks`), backend });
			manager.observe();
			managers.set(sessionId, manager);
		}
		return manager;
	};
	return {
		// the manager satisfies ShellTasks structurally (tools-node takes no runtime dependency)
		shellTasks: (sessionId) => (sessionId === undefined ? undefined : (managerFor(sessionId) as unknown as ShellTasks)),
		managerFor,
		close: async () => {
			for (const manager of managers.values()) {
				await manager.stopAll("exit", 2_000, "moved");
				manager.close();
			}
		},
	};
}

/** A task's state in a person's words (the terminal's `/tasks` wording). */
export function stateLabel(task: TaskInfo): string {
	const s = task.state;
	switch (s.kind) {
		case "starting":
			return "starting";
		case "not_run":
			return "never ran";
		case "running":
			return task.stoppedBy !== undefined ? "stopping" : s.ready ? "ready" : "running";
		case "unknown":
			return "lost track";
		case "ended":
			if (s.stopped) return "stopped";
			if (s.error !== undefined) return "failed to start";
			return s.exitCode === 0 ? "exited 0" : s.exitCode !== null ? `failed ${s.exitCode}` : `ended ${s.signal ?? ""}`.trim();
	}
}

/** The last lines of a task's output file (read from its end, never whole). */
function tailOf(path: string, lines = 4): string[] {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, 2048);
			const buf = Buffer.alloc(length);
			readSync(fd, buf, 0, length, size - length);
			return buf.toString("utf8").split("\n").filter((l) => l !== "").slice(-lines);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

export function rowsOf(manager: TaskManager, now = Date.now()): TaskRow[] {
	return manager.list().map((t) => ({
		id: t.id,
		label: stateLabel(t),
		command: t.command.split("\n")[0]!,
		startedAt: t.startedAt,
		endedAt: t.endedAt ?? null,
		elapsedMs: (t.endedAt ?? now) - t.startedAt,
		tail: tailOf(t.outputPath),
	}));
}
