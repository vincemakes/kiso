/**
 * LockAdapter — the cross-process single-writer lock contract (R-G 0.1.47,
 * ADR-0050).
 *
 * The default adapter is the identity-confirmed link lock — a pure Node
 * mechanism. Node's stdlib has no advisory-lock primitive (the round-4
 * python3 flock helper is the dependency this round retires), so possession
 * of `<id>.lock` is decided by atomic filesystem operations, and the file
 * itself carries the holder's identity.
 *
 * The protocol (the decision path is synchronous — no awaits between the
 * read and the act):
 *
 * acquire — read the identity; if it is absent or names a dead pid (fresh
 *   path / dead holder / stale residue): rename the path away (atomic —
 *   exactly one contender wins), re-read what was moved, and if it differs
 *   from what was judged (a rival's LIVE file got moved) abort the takeover
 *   and restore-or-keep. Then write MY identity to a temp file, fsync it,
 *   and LINK it at the final path (atomic create-if-absent). The link is
 *   the only way the final path ever exists — a kill can never leave an
 *   empty or half-written lock (see the fsync note below). A live foreign
 *   identity refuses immediately; a live identity naming OUR OWN process is
 *   a same-process writer's residue (round 5) and is retried until its
 *   release or the cap.
 *
 * verify — possession is re-checked at every append: the file must still
 *   name this handle's pid AND token. Failure is a STRICT refusal — no
 *   retry, no wait heuristic (ADR-0050: the guard must be reason-able; a
 *   displaced holder fails honestly and the session resumes from a fresh
 *   store — never two writers).
 *
 * release — rename my file away, confirm it is mine, leave the EMPTY
 *   released marker (the path is never deleted — a contender must be able
 *   to read it), remove the tombstone. A moved rival's file is
 *   restored-or-kept, never clobbered.
 *
 * The fsync-before-link order is LOAD-BEARING: the temp file is fully
 * written AND fsynced before the final name is linked, so a power loss can
 * never produce an empty or half-written file at the final path — the
 * inode's data is durable before the name exists. The final path itself
 * needs no directory fsync: if the name is lost in a crash, the holder
 * died with it, and the residue is acquirable (ADR-0050 §crash-durability).
 *
 * The identity FILE format is the cross-version channel (unchanged from
 * round 4): modern `{"pid": number, "token": string}`, legacy bare-pid
 * (string or JSON number), empty (the released marker / a legacy-format
 * writer's create window), half-written (crash residue). A legacy-format
 * writer sees a live modern identity and refuses to take over; we refuse a
 * live foreign legacy pid. Empty and half-written files are taken over as
 * residue — under the documented QUARANTINE upgrade contract (round 5
 * P1-4), no live legacy holder exists to be split (ADR-0050 §migration).
 *
 * Hard-link dependence: linkSync requires a link-capable filesystem
 * (macOS/Linux/Windows NTFS). EPERM/ENOTSUP is an honest
 * LockUnavailableError carrying the errno — never a silent degradation to
 * a weaker scheme (that would re-open the empty-file window, ADR-0050).
 *
 * Test-only affordances (KISO_LOCK_TEST_* env, default off): the race
 * gates (native-lock-race.test.ts) freeze a contender between the read and
 * the rename-away, and between the rename-away and the verify, via fixed
 * pauses plus SIGSTOP/SIGCONT, and locate the freeze points via
 * ready-marker files (ADR-0050 §test affordances).
 */

import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** A live foreign writer owns the lock — never taken over. */
export class LockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LockedError";
	}
}

/** The mechanism cannot operate (fs/link failure) — never a lock conflict. */
export class LockUnavailableError extends Error {
	constructor(reason: string) {
		super(`session locking unavailable: ${reason}`);
		this.name = "LockUnavailableError";
	}
}

export interface LockHandle {
	readonly pid: number;
	readonly token: string;
	/** True iff the lock file at the path still names THIS identity. */
	verify(): boolean;
	/** Idempotent release; the path is left as the empty released marker. */
	release(): void;
}

export interface LockAdapter {
	readonly name: string;
	/**
	 * Take (or take over) the lock at lockPath. Rejects with LockedError
	 * when a live foreign writer owns it (or the same-process-residue retry
	 * cap is hit), LockUnavailableError when the mechanism cannot operate.
	 * cancelled() is invoked at each retry decision and may throw to abort
	 * the acquisition (the store's lifecycle barrier).
	 */
	acquire(lockPath: string, sessionId: string, cancelled: () => void): Promise<LockHandle>;
}

/**
 * ADR-0050 Amendment 1 (Finding R-I-1): the liveness probe is
 * state-aware. A dead holder can linger in the process table after a
 * kill — the exiting state (STAT E on macOS: the kill landing while a
 * pty syscall is blocked, the dead session's terminal left open) or an
 * un-reaped zombie (STAT Z). POSIX reports BOTH alive to kill(pid, 0)
 * (they exist until reaped), so the takeover refused a holder that can
 * never execute another session write. Both states are probed and
 * judged DEAD. A probe failure (unreadable state) maintains the
 * pre-amendment behavior — alive, the fail-safe refusal (prefer a false
 * refusal over a double-write). Live-process semantics and the PID-reuse
 * rules do not move: a live foreign writer is still refused.
 *
 * ADR-0050 Amendment 2 (Finding R-I-p-3): the state letters are matched
 * ANYWHERE in the state string, not as the first character. The
 * exit-path linger's ps output is "?E" — the first character is the
 * no-controlling-terminal marker "?", with the E sitting AFTER it — so
 * first-character matching judged the finding's own documented shape
 * alive. The ps state alphabet (macOS + Linux) has no flag letters
 * "E"/"Z": an occurrence anywhere is the process-state code, and the
 * holder is dead.
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
	const state = processState(pid);
	// A null state (probe failure) keeps the pre-amendment behavior —
	// judged alive, the fail-safe refusal.
	return state === null || (!state.includes("E") && !state.includes("Z"));
}

/**
 * The process state via `ps -o state= -p <pid>` (macOS/Linux) — the
 * whole state string (a multi-char string like "Ss+" or "?E" is a
 * combined flag set; the E/Z process-state codes may sit after the "?"
 * no-tty marker or other flag letters, so the matching in isAlive scans
 * the whole string). An empty or unreadable state — the process
 * vanished between the kill and the probe, or ps itself failed —
 * returns null; isAlive's fail-safe branch then judges the holder alive
 * (the pre-amendment behavior).
 */
function processState(pid: number): string | null {
	try {
		const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return state.length > 0 ? state : null;
	} catch {
		return null;
	}
}

/**
 * Read a lock file's holder identity (round 4 formats, unchanged — the
 * cross-version channel). Empty, unreadable, or half-written locks have no
 * identity: they are residue, taken over (ADR-0050 §migration).
 */
function readLockIdentity(lockPath: string): { pid?: number; token?: string } | null {
	let raw: string;
	try {
		raw = readFileSync(lockPath, "utf8");
	} catch {
		return null;
	}
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		parsed = trimmed; // half-written JSON — try as a bare pid
	}
	if (typeof parsed === "number" && Number.isInteger(parsed)) {
		return { pid: parsed }; // JSON.parse("123") — a legacy bare pid
	}
	if (typeof parsed === "string") {
		const pid = Number.parseInt(parsed, 10);
		return Number.isFinite(pid) ? { pid } : null;
	}
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const v = parsed as Record<string, unknown>;
		return {
			...(typeof v.pid === "number" ? { pid: v.pid } : {}),
			...(typeof v.token === "string" ? { token: v.token } : {}),
		};
	}
	return null;
}

function sameIdentity(
	a: { pid?: number; token?: string } | null,
	b: { pid?: number; token?: string } | null,
): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return a.pid === b.pid && (a.token ?? null) === (b.token ?? null);
}

function unavailable(err: unknown): LockUnavailableError {
	const e = err as NodeJS.ErrnoException;
	return new LockUnavailableError(`${e.code ?? "?"}: ${e.message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class NativeLockHandle implements LockHandle {
	readonly pid: number;
	readonly token: string;
	readonly #lockPath: string;
	readonly #tombstone: string;
	#released = false;

	constructor(lockPath: string, tombstone: string, identity: { pid: number; token: string }) {
		this.#lockPath = lockPath;
		this.#tombstone = tombstone;
		this.pid = identity.pid;
		this.token = identity.token;
	}

	verify(): boolean {
		if (this.#released) return false;
		const now = readLockIdentity(this.#lockPath);
		return now !== null && now.pid === this.pid && now.token === this.token;
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		try {
			renameSync(this.#lockPath, this.#tombstone);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing of ours at the path
			// A fs-level failure: fall back to clearing in place (advisory
			// best effort — a missing marker can only wedge same-process
			// residue, never split a writer).
			try {
				writeFileSync(this.#lockPath, "");
			} catch {
				// advisory only
			}
			return;
		}
		const moved = readLockIdentity(this.#tombstone);
		if (moved !== null && moved.pid === this.pid && moved.token === this.token) {
			// Mine. Leave the EMPTY released marker — the path is never
			// deleted (a contender must be able to read it; the
			// storage-identity suite pins it) — created ONLY-if-absent, so
			// a rival that linked in the window keeps its lock untouched.
			try {
				const fd = openSync(this.#lockPath, "wx");
				closeSync(fd);
			} catch (err) {
				// EEXIST → a rival's lock stands; anything else → advisory.
			}
			try {
				unlinkSync(this.#tombstone);
			} catch {
				// the stray tombstone is inert
			}
			return;
		}
		// A rival's file was moved (the displacement cascade, ADR-0050
		// §residual) — restore-or-keep, never clobber: link it back
		// only-if-absent; on EEXIST the path already carries a newer lock
		// and the moved file stays at its distinct name (inert residue).
		try {
			linkSync(this.#tombstone, this.#lockPath);
		} catch {
			// EEXIST or fs failure — inert
		}
	}
}

class NativeLock implements LockAdapter {
	readonly name = "link-lock";

	async acquire(lockPath: string, sessionId: string, cancelled: () => void): Promise<LockHandle> {
		const pid = process.pid;
		const token = randomUUID();
		// The staging name is PER-ATTEMPT: a later rename-away in the same
		// acquire must never atomically overwrite an earlier attempt's
		// abandoned staging (that would clobber the displacement residue,
		// ADR-0050 §residual). tmp/tombstone are unique per acquire and are
		// always cleaned or inert.
		const tmp = `${lockPath}.tmp-${pid}-${token}`;
		const tombstone = `${lockPath}.tomb-${pid}-${token}`;
		// Test-only affordances (ADR-0050 §test affordances): the cascade
		// gate freezes a contender at the two decision points.
		const readyDir = process.env.KISO_LOCK_TEST_READY_DIR;
		const readPause = Number(process.env.KISO_LOCK_TEST_PAUSE_READ_MS ?? 0) || 0;
		const takeoverPause = Number(process.env.KISO_LOCK_TEST_PAUSE_TAKEOVER_MS ?? 0) || 0;

		for (let attempt = 0; ; attempt++) {
			cancelled();
			const staging = `${lockPath}.staging-${pid}-${token}-${attempt}`;
			const seen = readLockIdentity(lockPath);
			if (seen === null || seen.pid === undefined || !isAlive(seen.pid)) {
				// Fresh path, dead holder, or stale residue — take it over
				// by identity confirmation: rename-away → verify → link.
				if (readyDir !== undefined) writeFileSync(join(readyDir, `read-${pid}`), "");
				if (readPause > 0) await sleep(readPause);
				let moved = false;
				try {
					renameSync(lockPath, staging);
					moved = true;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable(err);
					// ENOENT — the path is already absent; proceed to the link.
				}
				if (moved) {
					if (readyDir !== undefined) writeFileSync(join(readyDir, `takeover-${pid}`), "");
					if (takeoverPause > 0) await sleep(takeoverPause);
					const s = readLockIdentity(staging);
					if (!sameIdentity(s, seen)) {
						// The path was replaced between my read and my rename
						// — a RIVAL'S LIVE file was moved. Abort the takeover:
						// restore-or-keep (link back only-if-absent; on EEXIST
						// the moved file is abandoned — inert residue at its
						// distinct name, ADR-0050 §residual).
						try {
							linkSync(staging, lockPath);
						} catch (err) {
							if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(err);
						}
						continue;
					}
				}
				// Write my identity fully, fsync it, THEN link — the
				// load-bearing order (ADR-0050 §crash-durability): the final
				// path can never exist empty or half-written, even across a
				// power loss.
				try {
					const fd = openSync(tmp, "w");
					try {
						writeFileSync(fd, JSON.stringify({ pid, token }), "utf8");
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
					linkSync(tmp, lockPath);
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code;
					if (code === "EEXIST") {
						// A rival linked first — retry from a fresh read.
						try {
							unlinkSync(tmp);
						} catch {
							// the stray is inert
						}
						continue;
					}
					throw unavailable(err);
				}
				try {
					unlinkSync(tmp);
				} catch {
					// the stray is inert
				}
				// The takeover succeeded — our identity owns the path, and the
				// verified-dead file we moved away may be cleaned up (its
				// name is distinct; unlinking it can never touch the lock
				// path). Only the EEXIST-abandoned staging of a FAILED
				// takeover lingers — the displacement fingerprint.
				if (moved) {
					try {
						unlinkSync(staging);
					} catch {
						// the stray is inert
					}
				}
				return new NativeLockHandle(lockPath, tombstone, { pid, token });
			}
			if (seen.pid === pid && seen.token !== undefined) {
				// Same-process writer's residue (round 5): another store in
				// THIS process holds the lock — it will release; retry until
				// it does (never a spurious self-conflict). A legacy
				// bare-pid lock naming our own process is refused like any
				// live foreign owner.
				if (attempt >= 25) throw new LockedError(`session ${sessionId} is locked by another writer`);
				await sleep(20);
				continue;
			}
			throw new LockedError(`session ${sessionId} is locked by another writer (pid ${seen.pid})`);
		}
	}
}

/** The default adapter: the identity-confirmed link lock (ADR-0050). */
export const nativeLockAdapter: LockAdapter = new NativeLock();
