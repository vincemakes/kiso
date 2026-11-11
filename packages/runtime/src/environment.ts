/**
 * A Work's added folders (ADR-0058 Amendment 19): one small file per session, `<id>.environment.json`.
 *
 * It is apart from `<id>.meta.json` on purpose: the sidecar's writers replace the whole file with no lock, and a rename in one
 * process could write back a list read a moment earlier. This file has one writer, under its own short lock.
 *
 * The file tools read it on every call, so nothing holds a stale copy. It decides what the file tools may reach and nothing else:
 * what the model has been told is the conversation's business, and authorisation never reads the conversation.
 *
 * A damaged file, or one of a version this kiso does not know, honours no added folder: the workspace keeps working.
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

const VERSION = 1;
/** A holder writes a few hundred bytes; a lock older than this is a crash's residue. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

export const ENVIRONMENT_NOTE_HEAD = "Environment update from kiso (a fact about this session, not a request from the person)";

/** The line a host puts before a person's next message after a change, kept out of the bubble and the title. Best effort. */
export const isEnvironmentNote = (text: string): boolean => text.startsWith(ENVIRONMENT_NOTE_HEAD);

/** A folder that cannot be added or removed, in words for the person. */
export class EnvironmentRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnvironmentRefusedError";
	}
}

export const environmentFile = (id: string): string => `${id}.environment.json`;

export interface EnvironmentState {
	readonly added: readonly string[];
	/** the file is there and cannot be honoured; `added` is empty */
	readonly damaged: boolean;
}

export function readEnvironment(root: string, id: string): EnvironmentState {
	let raw: string;
	try {
		raw = readFileSync(join(root, environmentFile(id)), "utf8");
	} catch (err) {
		return { added: [], damaged: (err as NodeJS.ErrnoException).code !== "ENOENT" };
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown; added?: unknown };
		if (parsed.version !== VERSION || !Array.isArray(parsed.added) || !parsed.added.every((p) => typeof p === "string" && isAbsolute(p))) return { added: [], damaged: true };
		return { added: parsed.added as string[], damaged: false };
	} catch {
		return { added: [], damaged: true };
	}
}

const within = (root: string, target: string): boolean => {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function withLock<T>(path: string, work: () => T): T {
	const lock = `${path}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
			} catch {
				// gone between the two calls: the next attempt takes it
			}
			if (Date.now() > deadline) throw new EnvironmentRefusedError("this Work's folders are being changed elsewhere: try again");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
		return work();
	} finally {
		rmSync(lock, { force: true });
	}
}

function replace(path: string, added: readonly string[]): void {
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify({ version: VERSION, added })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const dir = openSync(dirname(path), "r");
	try {
		fsyncSync(dir);
	} catch {
		// a platform whose directories cannot be flushed (Windows): the rename stands
	} finally {
		closeSync(dir);
	}
}

function update(root: string, id: string, change: (added: readonly string[]) => readonly string[]): readonly string[] {
	const path = join(root, environmentFile(id));
	return withLock(path, () => {
		const now = readEnvironment(root, id);
		if (now.damaged) throw new EnvironmentRefusedError(`this Work's folder list cannot be read: remove ${path} to start it again`);
		const next = change(now.added);
		replace(path, next);
		return next;
	});
}

/** Add `folder` to the Work. `primary` is where it started; `stops` are folders the new reach never enters. */
export function addFolder(root: string, id: string, options: { readonly primary: string; readonly folder: string; readonly stops: readonly string[] }): readonly string[] {
	let real: string;
	try {
		real = realpathSync(options.folder);
		if (!statSync(real).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new EnvironmentRefusedError(`${options.folder} is not a folder on this computer`);
	}
	const realOrSelf = (p: string): string => {
		try {
			return realpathSync(p);
		} catch {
			return p;
		}
	};
	if (options.stops.map(realOrSelf).some((stop) => within(stop, real))) throw new EnvironmentRefusedError(`${real} can't be added: the file tools do not reach this folder`);
	const primary = realOrSelf(options.primary);
	if (real === primary) throw new EnvironmentRefusedError("this is already the Work's primary folder");
	return update(root, id, (added) => {
		if (added.includes(real)) throw new EnvironmentRefusedError("this folder is already in the Work");
		if ([primary, ...added.map(realOrSelf)].some((r) => within(r, real) || within(real, r))) throw new EnvironmentRefusedError("a folder inside, or containing, another of the Work's folders can't be added");
		return [...added, real];
	});
}

export function removeFolder(root: string, id: string, folder: string): readonly string[] {
	return update(root, id, (added) => {
		if (!added.includes(folder)) throw new EnvironmentRefusedError("this folder is not in the Work");
		return added.filter((p) => p !== folder);
	});
}

/** A fork takes the parent's current list. */
export function copyEnvironment(root: string, from: string, to: string): void {
	const source = join(root, environmentFile(from));
	if (existsSync(source)) copyFileSync(source, join(root, environmentFile(to)));
}
