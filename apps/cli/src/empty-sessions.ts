/**
 * DC-60 — the empty sessions an older kiso left behind.
 *
 * Until DC-60 every process that opened a session wrote its sidecar (and,
 * through the start-up recovery, a trace) whether or not anything ever
 * happened in it: a started-and-closed kiso, a /resume that went nowhere, a
 * delegated child that failed before its first turn. Each left a sidecar
 * with no log, and each showed up in /resume as a card with no summary.
 * The owner's disk held 28 on 2026-09-23.
 *
 * `kiso sessions --prune-empty` lists them. With `--yes` it MOVES them to
 * the Trash — never deletes — keeping each project folder's name, so a
 * mistake is a drag back. A session whose lock names a live process is
 * skipped: something is using it right now.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface EmptySession {
	/** The session folder (a project folder, or the legacy sessions dir). */
	readonly dir: string;
	readonly id: string;
	/** The files that name it, relative to `dir`. */
	readonly files: readonly string[];
}

export interface EmptyScan {
	readonly empty: readonly EmptySession[];
	/** Empty by the files, but a live process holds the lock. */
	readonly inUse: number;
}

const SIDECAR = ".meta.json";

/** A lock whose pid answers signal 0 belongs to a running process. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockPid(path: string): number | null {
	try {
		const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Every session in `dirs` with a sidecar and no log. Reads only. */
export function findEmptySessions(dirs: readonly string[], alive: (pid: number) => boolean = pidAlive): EmptyScan {
	const empty: EmptySession[] = [];
	let inUse = 0;
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(SIDECAR)) continue;
			const id = name.slice(0, -SIDECAR.length);
			if (names.includes(`${id}.jsonl`)) continue;
			const lock = `${id}.lock`;
			if (names.includes(lock)) {
				const pid = lockPid(join(dir, lock));
				if (pid !== null && alive(pid)) {
					inUse += 1;
					continue;
				}
			}
			const files = [name];
			if (names.includes(lock)) files.push(lock);
			if (existsSync(join(dir, "traces", `${id}.jsonl`))) files.push(join("traces", `${id}.jsonl`));
			empty.push({ dir, id, files });
		}
	}
	return { empty, inUse };
}

/** The platform's Trash: ~/.Trash on macOS, kiso's own folder on Windows
 *  (its Recycle Bin is not a folder a program moves files into), the
 *  freedesktop one elsewhere. */
export function defaultTrashRoot(kisoHome: string): string {
	if (process.platform === "darwin") return join(homedir(), ".Trash");
	if (process.platform === "win32") return join(kisoHome, "trash");
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
}

/** Move the sessions into one new folder under `trashRoot`, keeping each
 *  session folder's name; returns that folder. Never deletes: a file that
 *  cannot be renamed across devices is copied, then unlinked. */
export function moveToTrash(sessions: readonly EmptySession[], trashRoot: string, now: Date = new Date()): string {
	const target = join(trashRoot, `kiso-empty-sessions-${now.toISOString().replace(/[:.]/g, "-")}`);
	for (const s of sessions) {
		for (const file of s.files) {
			const to = join(target, basename(s.dir), file);
			mkdirSync(join(to, ".."), { recursive: true });
			try {
				renameSync(join(s.dir, file), to);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
				copyFileSync(join(s.dir, file), to);
				unlinkSync(join(s.dir, file));
			}
		}
	}
	return target;
}
