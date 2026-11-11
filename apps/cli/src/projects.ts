/**
 * 0.40.0 (the owner's dogfood) — one session folder per project.
 *
 * Every session used to live in one `KISO_HOME/sessions`, and a session of
 * one project could be resumed from another. Its file tools, rooted at the
 * cwd, then pointed at the wrong tree. A session now lives in the folder of
 * the project it runs in, `KISO_HOME/projects/<enc>/`, and another project's
 * session is not in this folder by construction.
 *
 *   <enc>           the workspace realpath, every non-alphanumeric turned
 *                   into `-` (a readable name, not an identity)
 *   workspace.json  the realpath the folder belongs to — the identity. A
 *                   folder naming another realpath is never adopted; the
 *                   newcomer's name takes a `-<sha8>` suffix instead
 *   _unknown/       legacy sessions whose project could not be read
 *
 * A session's PLACEMENT is derived, never written: in a project folder, a
 * session whose profile records a workspace is `recorded`, one without is
 * `inferred` (only the one-time migration puts it there); in `_unknown`, it
 * is `unknown`. The evidence behind an inference is in the migration's
 * manifest.
 *
 * `KISO_SESSIONS_DIR` pins the folder outright (tests, bench runners, a
 * delegated child writing beside its parent), and the reverse migration's
 * marker restores the single legacy folder. Either one turns this layout
 * off, and with it every cross-project rule below.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECTS_DIR = "projects";
export const LEGACY_SESSIONS_DIR = "sessions";
export const UNKNOWN_PROJECT = "_unknown";
export const WORKSPACE_FILE = "workspace.json";
/** Written by `kiso sessions --reverse-migration`: while it exists, the
 *  single legacy folder is in force again, for this build and older ones. */
export const REVERSED_MARKER = ".migration-reversed";

/** A folder name stays well under the file system's 255-byte limit. */
const NAME_MAX = 200;

/**
 * A path as the DISK spells it — symlinks resolved and, on a
 * case-insensitive disk, the stored case. The JS realpath keeps the case it
 * was given, and `~/desktop/x` and `~/Desktop/x` must be one project, not
 * two folders. A path that no longer exists is kept as written.
 */
export function canonicalPath(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

const sha8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

export function encodeWorkspace(workspace: string): string {
	const enc = workspace.replace(/[^A-Za-z0-9]/g, "-");
	return enc.length <= NAME_MAX ? enc : `${enc.slice(0, NAME_MAX)}-${sha8(workspace)}`;
}

/** The realpath a folder belongs to; null when it records none. */
export function folderWorkspace(dir: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, WORKSPACE_FILE), "utf8")) as { readonly workspace?: unknown };
		return typeof parsed.workspace === "string" && parsed.workspace !== "" ? parsed.workspace : null;
	} catch {
		return null;
	}
}

/**
 * The folder of a workspace. A pure read: the name is the encoding unless
 * that folder already belongs to another realpath (two paths can encode
 * alike: `/a/b-c` and `/a/b/c`), and then it takes the suffix. `taken` is
 * a batch's own assignments, which are not on disk yet.
 */
export function projectDirFor(home: string, workspace: string, taken?: ReadonlyMap<string, string>): string {
	const base = join(home, PROJECTS_DIR, encodeWorkspace(workspace));
	const owner = taken?.get(base) ?? folderWorkspace(base);
	return owner === null || owner === undefined || owner === workspace ? base : `${base}-${sha8(workspace)}`;
}

export function unknownDir(home: string): string {
	return join(home, PROJECTS_DIR, UNKNOWN_PROJECT);
}

/** Make the folder and record whose it is. The write is tmp + rename, so a
 *  reader never sees half a `workspace.json`; an existing record is kept. */
export function claimProjectDir(dir: string, workspace: string | null): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (workspace === null || folderWorkspace(dir) !== null) return;
	const tmp = join(dir, `${WORKSPACE_FILE}.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify({ workspace, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
	renameSync(tmp, join(dir, WORKSPACE_FILE));
}

/** Whether the per-project layout is in force for this process. */
export function projectLayoutActive(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const pinned = env.KISO_SESSIONS_DIR;
	if (pinned !== undefined && pinned !== "") return false;
	return !existsSync(join(home, PROJECTS_DIR, REVERSED_MARKER));
}

export interface SessionFolder {
	readonly dir: string;
	/** the realpath the folder belongs to; null for `_unknown` and the
	 *  legacy folder, whose sessions have no project */
	readonly workspace: string | null;
	readonly kind: "project" | "unknown" | "legacy";
}

/** Every folder that can hold sessions: the project folders, `_unknown`,
 *  and the legacy folder while anything is left in it. Directory reads
 *  only. */
export function sessionFolders(home: string): SessionFolder[] {
	const out: SessionFolder[] = [];
	const root = join(home, PROJECTS_DIR);
	let names: string[] = [];
	try {
		names = readdirSync(root).sort();
	} catch {
		// no projects yet
	}
	for (const name of names) {
		const dir = join(root, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(name === UNKNOWN_PROJECT ? { dir, workspace: null, kind: "unknown" } : { dir, workspace: folderWorkspace(dir), kind: "project" });
	}
	const legacy = join(home, LEGACY_SESSIONS_DIR);
	if (existsSync(legacy)) out.push({ dir: legacy, workspace: null, kind: "legacy" });
	return out;
}

/** A non-empty log is a session (the listing's own rule). */
export function hasSession(dir: string, id: string): boolean {
	try {
		return statSync(join(dir, `${id}.jsonl`)).size > 0;
	} catch {
		return false;
	}
}

/** The folder holding a session, other than `except`; null when none. */
export function locateSession(home: string, id: string, except: string): SessionFolder | null {
	for (const folder of sessionFolders(home)) {
		if (folder.dir === except) continue;
		if (hasSession(folder.dir, id)) return folder;
	}
	return null;
}

/**
 * The files of one session, in the order they move: the trace, the sidecar,
 * the lock, and the log LAST. A crash part-way leaves the log where it was,
 * so the session is still listed and still moved on the next attempt; each
 * file moves only when it is at the source and absent at the target, so a
 * repeated move is a no-op.
 */
export function sessionFiles(id: string): readonly string[] {
	return [join("traces", `${id}.jsonl`), `${id}.meta.json`, `${id}.environment.json`, `${id}.lock`, `${id}.jsonl`];
}

export function moveSessionFiles(fromDir: string, toDir: string, id: string, files: readonly string[] = sessionFiles(id)): number {
	let moved = 0;
	for (const rel of files) {
		const from = join(fromDir, rel);
		const to = join(toDir, rel);
		if (!existsSync(from) || existsSync(to)) continue;
		mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
		renameSync(from, to);
		moved += 1;
	}
	return moved;
}

/**
 * Whether a lock is held by a live process. The lock file carries the
 * holder's `{pid, token}` (a legacy one, a bare pid); an empty file is the
 * released marker. The probe is conservative on purpose — a pid that exists
 * at all counts as live, a zombie included — because the only cost of a
 * false "live" is a move deferred to a later start.
 */
export function lockHeldLive(dir: string, id: string): boolean {
	let text: string;
	try {
		text = readFileSync(join(dir, `${id}.lock`), "utf8").trim();
	} catch {
		return false;
	}
	if (text === "") return false;
	let pid: number;
	try {
		const parsed = JSON.parse(text) as unknown;
		pid = typeof parsed === "number" ? parsed : Number((parsed as { readonly pid?: unknown }).pid);
	} catch {
		pid = Number(text);
	}
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether a session id may open in this project (index.ts routeSession):
 *  its own folder; refused, with where to go; or opened where it is, in
 *  another folder, with the line that says so (null: nothing to say). */
export type SessionRoute =
	| { readonly kind: "here" }
	| { readonly kind: "refused"; readonly line: string }
	| { readonly kind: "elsewhere"; readonly dir: string; readonly line: string | null };

/** A delegated child's id names its parent:
 *  `sub-<parentId>-<24 hex>-<n>-<role>`, or, before CX-1 F6 gave each
 *  delegation its own id, `sub-<parentId>-<n>-<role>`. */
export function parentOfChild(id: string): string | null {
	const m = /^sub-(.+?)(?:-[0-9a-f]{24})?-\d+-[a-z]+$/.exec(id);
	return m === null ? null : m[1]!;
}
