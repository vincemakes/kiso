import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { listDir, readPreview, readTaskLog, Refusal } from "./files.js";
import type { Space } from "./space.js";

/**
 * The read doors of the page: a Work's folder (a tree, a file, the list the
 * composer's @ picks from) and a background task's log. GET only, behind the host's guard; every path is
 * judged by files.ts, a task id only by the task manager of a session that
 * exists in the Work's folder.
 */

export const SAFE_ID = /^[A-Za-z0-9._-]+$/;

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

const AT_CAP = 2000;
const AT_SKIP = new Set([".git", "node_modules", ".kiso", "dist", "build", ".next", ".venv", "__pycache__"]);

/** The files `@` can name, as the terminal lists them: git's own list (tracked and untracked, ignores honoured), else a bounded walk; `truncated` when the cap cut it. */
export function atFiles(space: Space, extra: readonly string[] = [], stops: readonly string[] = []): { readonly files: readonly string[]; readonly truncated: boolean } {
	const own = rootFiles(space.workspace, "");
	// only a root that is still its own real path (one replaced by a symlink is refused by the file tools, so it is not listed), and the walk
	// itself leaves out the stop roots (`~/.ssh`, `~/.aws`, the kiso home ...): they are not listed and filtered out afterwards
	const roots = extra.filter((r) => {
		try {
			return realpathSync(r) === r;
		} catch {
			return false;
		}
	});
	const files = roots.reduce((all, root) => [...all, ...rootFiles(root, `${root}/`, stops)], own);
	return { files: files.slice(0, AT_CAP), truncated: files.length > AT_CAP };
}

/** One root's files, each under `prefix` (the primary's are relative; an added folder's are absolute, as the model must name them). */
function rootFiles(cwd: string, prefix: string, stops: readonly string[] = []): string[] {
	let files: string[];
	const out = stops.filter((s) => s.startsWith(`${cwd}/`)).map((s) => `:(exclude)${s.slice(cwd.length + 1)}`);
	try {
		files = execFileSync("git", ["ls-files", "-c", "-o", "--exclude-standard", ...(out.length > 0 ? ["--", ".", ...out] : [])], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24, timeout: 3000 }).split("\n").filter((p) => p !== "").map((p) => `${prefix}${p}`);
	} catch {
		files = [];
		const walk = (dir: string, prefix: string): void => {
			try {
				for (const e of readdirSync(dir, { withFileTypes: true })) {
					if (files.length > AT_CAP) return;
					if (AT_SKIP.has(e.name) || stops.includes(`${dir}/${e.name}`)) continue;
					if (e.isDirectory()) walk(`${dir}/${e.name}`, `${prefix}${e.name}/`);
					else if (e.isFile()) files.push(`${prefix}${e.name}`);
				}
			} catch {
				// an unreadable directory adds nothing
			}
		};
		walk(cwd, prefix);
	}
	return files;
}
