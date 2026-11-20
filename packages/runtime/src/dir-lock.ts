import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * A lock across processes: a directory made atomically. A holder that died leaves it behind; one older than `staleMs` is
 * taken over. The take-over is a rename to a name of the taker's own, so of two waiters that both saw it stale only one moves
 * it; a taker that moved a lock which turns out fresh (another waiter took over and made a new one between the look and the
 * rename) puts it back (finding G3: removing it in place could delete another holder's live lock).
 */
export const LOCK_STALE_MS = 10_000;

/** Move a stale lock out of the way. True when it is gone (moved, or already gone); false when it is live. */
export function takeOverStale(lock: string, staleMs = LOCK_STALE_MS): boolean {
	let age: number;
	try {
		age = Date.now() - statSync(lock).mtimeMs;
	} catch {
		return true; // it went between the two calls
	}
	if (age <= staleMs) return false;
	const aside = `${lock}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		renameSync(lock, aside);
	} catch {
		return true; // another waiter moved it first
	}
	try {
		if (Date.now() - statSync(aside).mtimeMs <= staleMs) {
			renameSync(aside, lock); // a live lock: put it back for its holder
			return false;
		}
	} catch {
		// it is ours to remove
	}
	rmSync(aside, { recursive: true, force: true });
	return true;
}

function tryLock(lock: string, staleMs: number): boolean {
	try {
		mkdirSync(lock);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		takeOverStale(lock, staleMs);
		return false;
	}
}

const release = (lock: string): void => rmSync(lock, { recursive: true, force: true });

/** Hold `lock` while `fn` runs, waiting `waitMs` between tries; `busy` is thrown after `tries` attempts. */
export async function withDirLock<T>(lock: string, fn: () => T, busy: () => Error, tries = 300, waitMs = 10): Promise<T> {
	for (let i = 0; !tryLock(lock, LOCK_STALE_MS); i++) {
		if (i >= tries) throw busy();
		await new Promise((r) => setTimeout(r, waitMs));
	}
	try {
		return fn();
	} finally {
		release(lock);
	}
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/** The same, for a caller that cannot wait asynchronously: it blocks for at most `tries` × `waitMs`. */
export function withDirLockSync<T>(lock: string, fn: () => T, busy: () => Error, tries = 300, waitMs = 10): T {
	for (let i = 0; !tryLock(lock, LOCK_STALE_MS); i++) {
		if (i >= tries) throw busy();
		Atomics.wait(pause, 0, 0, waitMs);
	}
	try {
		return fn();
	} finally {
		release(lock);
	}
}
