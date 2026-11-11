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

import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { LockedError, nativeLockAdapter, type LockHandle } from "./lock-adapter.js";

const VERSION = 1;
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

/**
 * The list's own lock: the session store's identity-confirmed link lock (ADR-0050), never taken from a live holder and released
 * only by its owner. A dead holder is taken over by the adapter's rules; a live one is waited for briefly, then refused in words.
 */
async function withLock<T>(path: string, id: string, work: () => T): Promise<T> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle: LockHandle;
	for (;;) {
		try {
			handle = await nativeLockAdapter.acquire(`${path}.lock`, id, () => undefined);
			break;
		} catch (err) {
			if (!(err instanceof LockedError) || Date.now() > deadline) {
				throw err instanceof LockedError ? new EnvironmentRefusedError("this Work's folders are being changed elsewhere: try again") : err;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
	}
	try {
		if (!handle.verify()) throw new EnvironmentRefusedError("this Work's folders are being changed elsewhere: try again");
		return work();
	} finally {
		handle.release();
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
	// the rename is the commit: from here a failure must not be reported as one. A platform whose directories cannot be opened or
	// flushed (Windows) keeps the rename.
	try {
		const dir = openSync(dirname(path), "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} catch {
		// the change stands
	}
}

function update(root: string, id: string, change: (added: readonly string[]) => readonly string[]): Promise<readonly string[]> {
	const path = join(root, environmentFile(id));
	return withLock(path, id, () => {
		const now = readEnvironment(root, id);
		if (now.damaged) throw new EnvironmentRefusedError(`this Work's folder list cannot be read: remove ${path} to start it again`);
		const next = change(now.added);
		replace(path, next);
		return next;
	});
}

/** Add `folder` to the Work. `primary` is where it started; `stops` are folders the new reach never enters. */
export async function addFolder(root: string, id: string, options: { readonly primary: string; readonly folder: string; readonly stops: readonly string[] }): Promise<readonly string[]> {
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

export async function removeFolder(root: string, id: string, folder: string): Promise<readonly string[]> {
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
