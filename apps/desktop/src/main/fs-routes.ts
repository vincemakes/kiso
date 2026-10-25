import { realpathSync } from "node:fs";
import { listDir, readPreview, readTaskLog, Refusal } from "./files.js";
import type { Space } from "./space.js";

/**
 * The read doors of the desktop page: a Work's folder (a tree, a file) and a
 * background task's log. GET only, behind the host's guard; every path is
 * judged by files.ts, a task id only by the task manager of a session that
 * exists in the Work's folder.
 */

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function deskRead(url: URL, space: Space): { readonly status: number; readonly body: unknown } {
	try {
		const rel = url.searchParams.get("path") ?? "";
		if (url.pathname === "/desk/task-log") {
			const session = url.searchParams.get("session") ?? "";
			const task = url.searchParams.get("task") ?? "";
			if (!SAFE_ID.test(session) || !SAFE_ID.test(task) || !space.store.ids().includes(session)) throw new Refusal(404, "no such task");
			const info = space.tasks.managerFor(session).list().find((t) => t.id === task);
			if (info === undefined) throw new Refusal(404, "no such task");
			return { status: 200, body: readTaskLog(info.outputPath) };
		}
		let root: string;
		try {
			root = realpathSync(space.workspace);
		} catch {
			throw new Refusal(404, "the folder is gone");
		}
		return { status: 200, body: url.pathname === "/desk/fs/tree" ? listDir(root, rel) : readPreview(root, rel) };
	} catch (error) {
		if (error instanceof Refusal) return { status: error.status, body: { code: "refused", message: error.message } };
		return { status: 500, body: { code: "internal", message: "unreadable" } };
	}
}
