/**
 * SessionStore — append-only JSONL durability, identity-safe (A 组).
 *
 * One file per session: `<root>/<id>.jsonl`, lines of
 * `{"runId": string, "ts": number, "event": Event}`. The single-writer
 * lock (第四轮) is an EXCLUSIVE KERNEL flock on `<id>.lock`, held by a
 * dedicated helper process:
 *
 * - the kernel arbitrates every race — a contender can never remove or
 *   overwrite a live holder's lock, because there is nothing to remove;
 *   the lock simply exists while the helper lives and vanishes with it;
 * - the lock file ALSO carries `{"pid": number, "token": string}` written
 *   by the holder, as a best-effort guard for OLD-format writers (whose
 *   O_EXCL pidfile scheme does not honor flock). 第五轮(P1-4): this guard
 *   is NOT a seamless rolling upgrade — an old writer that created an
 *   empty lock file before writing its pid creates a split-brain window
 *   that a pidfile read cannot close. The documented upgrade contract is
 *   QUARANTINE: stop every old-format process, THEN start the new
 *   version. A dead/empty/unreadable legacy lock is otherwise harmless —
 *   flock ignores content, and the kernel lock is what matters;
 * - `close()` releases only THIS instance's helper; `closeAll()` every
 *   held helper — a foreign close can never release another writer's
 *   kernel lock (flock is tied to the helper's open file description).
 *
 * Consistency contract (A 组):
 * - every id is validated BEFORE any file side effect (append, close,
 *   load, lock paths);
 * - append runs an expected-last-seq CAS against the file's REAL last
 *   committed seq: a stale preloaded handle writing a duplicate seq is
 *   refused with StaleWriterError — and the run that fed it terminates,
 *   so the in-memory EventLog never continues past a rejected write;
 * - the torn tail is repaired before EVERY append, and committed records
 *   (newline-terminated) are never truncated;
 * - load is strict (A 组 round 1): a partial final line is the only
 *   tolerated damage; everything else throws StoreCorruptionError.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	readSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isKisoEvent, type Event } from "@kiso/core";

/** History that does not parse as a contiguous kiso trajectory. */
export class StoreCorruptionError extends Error {
	constructor(message: string) {
		super(`session store corruption: ${message}`);
		this.name = "StoreCorruptionError";
	}
}

/** A write that would duplicate or skip a seq — the handle is stale. */
export class StaleWriterError extends Error {
	constructor(expected: number, got: number) {
		super(`stale session handle: expected seq ${expected}, got ${got} — reload the session`);
		this.name = "StaleWriterError";
	}
}

/** A durable record: the run that produced it, and the event itself. */
export interface StoreRecord {
	readonly runId: string;
	readonly ts: number;
	readonly event: Event;
}

export interface SessionMeta {
	readonly id: string;
	readonly title: string;
	readonly events: number;
	readonly runs: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Session ids become file names — keep them host-safe. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class SessionStore {
	readonly root: string;
	readonly #fds = new Map<string, number>();
	/** sessionId → the lock helper process THIS instance spawned. */
	readonly #lockHelpers = new Map<string, ChildProcess>();
	/** 第四轮(对抗): serialize concurrent acquireLock calls ON this instance —
	 *  two racing appends must not spawn two helpers and fight each other. */
	readonly #lockAcquiring = new Map<string, Promise<void>>();
	/** 第五轮(P1-1): serialize the WHOLE append critical section per session on
	 *  this instance — lock check → CAS → write → fsync. A rejected write
	 *  propagates to every append queued behind it, so a concurrent write can
	 *  never land after a stale failure (which would fork memory and disk). */
	readonly #appendQueues = new Map<string, Promise<void>>();
	readonly #closed = new Set<string>();

	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
		fsyncDir(root);
	}

	// ── paths and the cross-process lock ─────────────────────────────────

	private pathFor(sessionId: string): string {
		if (!ID_PATTERN.test(sessionId)) {
			throw new Error(`invalid session id: ${sessionId}`);
		}
		return join(this.root, `${sessionId}.jsonl`);
	}

	private lockPathFor(sessionId: string): string {
		return join(this.root, `${sessionId}.lock`);
	}

	/**
	 * Take the single-writer lock (第四轮): an EXCLUSIVE kernel flock held
	 * by a dedicated helper process. The KERNEL arbitrates every race —
	 * there is no stale lock to delete and no takeover to race: a
	 * contender either gets the flock (the previous holder is gone) or it
	 * fails. The lock file also carries the holder's identity so an OLD-format
	 * writer (which does not honor flock) still sees a live owner and
	 * refuses to take over — a best-effort guard, NOT a seamless rolling
	 * upgrade (第五轮 P1-4): the documented upgrade contract is quarantine —
	 * stop every old-format process, then start the new version.
	 * No recursion, no deletion, no window between NEW-format writers.
	 */
	private async acquireLock(sessionId: string): Promise<void> {
		// 第五轮(P1-2): the lock is held only while the helper PROCESS is
		// alive — flock is bound to the helper's lifetime. A dead helper's
		// entry must never be trusted as "locked".
		if (this.lockHeld(sessionId)) return;
		const inFlight = this.#lockAcquiring.get(sessionId);
		if (inFlight !== undefined) return inFlight;
		const attempt = this.#acquireLockOnce(sessionId).finally(() => this.#lockAcquiring.delete(sessionId));
		this.#lockAcquiring.set(sessionId, attempt);
		return attempt;
	}

	/** 第五轮(P1-2): true only while the helper process is alive. */
	private lockHeld(sessionId: string): boolean {
		const child = this.#lockHelpers.get(sessionId);
		if (child === undefined || child.pid === undefined || child.pid <= 0) return false;
		return isAlive(child.pid);
	}

	async #acquireLockOnce(sessionId: string): Promise<void> {
		const lockPath = this.lockPathFor(sessionId);
		for (let attempt = 0; ; attempt++) {
			const child = spawn("python3", ["-c", LOCK_HELPER_SCRIPT, lockPath], {
				stdio: ["pipe", "pipe", "ignore"],
			});
			const verdict = await helperVerdict(child);
			if (verdict === "LOCKED") {
				// The kernel flock is ours. One last compatibility gate: an
				// OLD-format writer (which does not honor flock) may still
				// be alive — its lock file names it. Refuse, and release
				// the flock (the helper dies). A MODERN lock (with a token)
				// naming OUR OWN process is a same-process writer's residue
				// (第四轮: the file is advisory; the flock is the authority).
				const legacy = readLockIdentity(lockPath);
				if (legacy?.pid !== undefined && isAlive(legacy.pid) && (legacy.token === undefined || legacy.pid !== process.pid)) {
					child.kill();
					throw new Error(`session ${sessionId} is locked by another writer (pid ${legacy.pid})`);
				}
				// Record our identity in the file: irrelevant to flock, but
				// an OLD-format contender reads it and refuses to take over
				// a live writer's lock.
				try {
					writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }));
				} catch {
					// the file itself is advisory — the kernel lock holds
				}
				this.#lockHelpers.set(sessionId, child);
				// 第五轮(P1-2): the helper's death removes the entry — the
				// flock dies with the process; a later append re-acquires
				// (and fails honestly if a rival holds the flock now).
				child.on("exit", () => {
					if (this.#lockHelpers.get(sessionId) === child) {
						this.#lockHelpers.delete(sessionId);
					}
				});
				return;
			}
			child.kill();
			if (verdict === "SPAWN_FAILED") {
				// 第四轮(对抗): the helper could not start (python3 missing) —
				// an HONEST error, never a fake lock conflict.
				throw new Error(
					`session locking unavailable: the flock helper (python3) failed to start for ${sessionId}`,
				);
			}
			// BUSY: either a live modern writer, or a holder that is just
			// exiting (its helper is dying). A FOREIGN live writer's identity
			// is in the file — refuse at once. A MODERN lock (with a token)
			// naming OUR OWN process is a same-process writer — it will
			// release its helper; retry until it does (第四轮: never a
			// spurious self-conflict). A legacy bare-pid lock naming our own
			// process is still a live foreign owner and is refused.
			const legacy = readLockIdentity(lockPath);
			if (legacy?.pid !== undefined && isAlive(legacy.pid) && (legacy.token === undefined || legacy.pid !== process.pid)) {
				throw new Error(`session ${sessionId} is locked by another writer (pid ${legacy.pid})`);
			}
			if (attempt >= 25) {
				throw new Error(`session ${sessionId} is locked by another writer`);
			}
			// 第五轮(P1-3): a close() that landed while we waited ends the
			// acquisition immediately — no 500ms wait, no lock at all.
			if (this.#closed.has(sessionId)) {
				throw new Error(`session store is closed for ${sessionId}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	/**
	 * Release OUR lock only: kill OUR helper. The kernel releases the
	 * flock with the helper's death; the identity file is CLEARED so a
	 * same-process successor is never mistaken for a live legacy owner —
	 * the flock is the authority, the file is advisory (第四轮).
	 */
	private releaseLock(sessionId: string): void {
		const child = this.#lockHelpers.get(sessionId);
		if (child === undefined) return;
		this.#lockHelpers.delete(sessionId);
		// 第四轮(对抗): the identity is cleared BEFORE the helper dies — a
		// contender that acquires the flock in the release gap writes its
		// own identity AFTER our clear, so it is never wiped by us (the
		// file is advisory; the kernel flock is the authority).
		try {
			writeFileSync(this.lockPathFor(sessionId), "");
		} catch {
			// advisory only
		}
		child.kill();
	}

	// ── append: lock, open, repair, CAS, write, fsync ────────────────────

	/** Write-ahead: durable (written + fsynced) before returning. */
	async append(sessionId: string, runId: string, event: Event): Promise<void> {
		if (this.#closed.has(sessionId)) {
			throw new Error(`session store is closed for ${sessionId}`);
		}
		this.pathFor(sessionId); // id validated before ANY file side effect
		// 第五轮(P1-1): the WHOLE critical section is serialized per session
		// on this instance — and a rejection PROPAGATES to every append
		// queued behind it: a concurrent write can never land after a
		// stale failure that poisoned the session.
		const previous = this.#appendQueues.get(sessionId) ?? Promise.resolve();
		const run = previous.then(() => this.#appendOnce(sessionId, runId, event));
		this.#appendQueues.set(sessionId, run);
		try {
			await run;
		} finally {
			if (this.#appendQueues.get(sessionId) === run) {
				this.#appendQueues.delete(sessionId);
			}
		}
	}

	async #appendOnce(sessionId: string, runId: string, event: Event): Promise<void> {
		// 第五轮(P1-3): close() may have returned while we waited — the
		// lifecycle barrier is re-checked after the lock acquisition.
		if (this.#closed.has(sessionId)) {
			throw new Error(`session store is closed for ${sessionId}`);
		}
		await this.acquireLock(sessionId);
		if (this.#closed.has(sessionId)) {
			// The lock was acquired AFTER close() returned — release it and
			// fail; nothing of this instance may outlive close().
			this.releaseLock(sessionId);
			throw new Error(`session store is closed for ${sessionId}`);
		}
		let fd: number;
		try {
			fd = this.fd(sessionId);
		} catch (err) {
			// The lock was acquired but the JSONL could not be opened:
			// release the lock — it must not leak (A 组).
			this.releaseLock(sessionId);
			throw err;
		}
		repairTornTail(fd);
		// Expected-last-seq CAS against the file's REAL last committed seq
		// (A 组): a stale preloaded handle cannot write a duplicate seq.
		const last = lastCommittedSeq(fd);
		const expected = (last ?? -1) + 1;
		if (event.seq !== expected) {
			throw new StaleWriterError(expected, event.seq);
		}
		appendFileSync(fd, `${JSON.stringify({ runId, ts: Date.now(), event })}\n`);
		fsyncSync(fd);
		// 第五轮(P1-3): a close() that landed during the write must not
		// leave our helper behind.
		if (this.#closed.has(sessionId)) {
			this.releaseLock(sessionId);
		}
	}

	/**
	 * Open (creating if needed) the session file. The torn tail is repaired
	 * here AND before every append — an in-process append failure cannot
	 * poison the next one. The parent directory is fsynced so the file's
	 * existence survives a crash.
	 */
	private fd(sessionId: string): number {
		const existing = this.#fds.get(sessionId);
		if (existing !== undefined) return existing;

		const path = this.pathFor(sessionId);
		const fd = openSync(path, "a+");
		repairTornTail(fd);
		fsyncDir(dirname(path));
		this.#fds.set(sessionId, fd);
		return fd;
	}

	// ── load: strict replay ──────────────────────────────────────────────

	/**
	 * Replay a session's log. The ONLY tolerated damage is a partial final
	 * line (a crash mid-write): it is dropped and the contiguous prefix is
	 * returned. Anything else — mid-file garbage, valid JSON that is not a
	 * kiso record, a seq that is not 0..N — throws StoreCorruptionError.
	 */
	load(sessionId: string): StoreRecord[] {
		const path = this.pathFor(sessionId);
		if (!existsSync(path)) return [];
		const raw = readFileSync(path, "utf8");
		const lines = raw.split("\n");
		const nonEmpty: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] !== "") nonEmpty.push(i);
		}
		// 二: a line WITHOUT a trailing newline is NOT committed — whether
		// or not it happens to parse. load and append must agree: append's
		// torn-tail repair truncates exactly what load refuses to return.
		const tolerantTail = !raw.endsWith("\n");
		const records: StoreRecord[] = [];
		for (let k = 0; k < nonEmpty.length; k++) {
			const line = lines[nonEmpty[k]!]!;
			const isLast = k === nonEmpty.length - 1;
			if (isLast && tolerantTail) break; // uncommitted — drop it
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new StoreCorruptionError(`line ${nonEmpty[k]! + 1} is not JSON`);
			}
			if (!isRecord(parsed)) {
				throw new StoreCorruptionError(`line ${nonEmpty[k]! + 1} is not a session record`);
			}
			records.push(parsed);
		}

		for (let i = 0; i < records.length; i++) {
			const seq = records[i]!.event.seq;
			if (seq !== i) {
				throw new StoreCorruptionError(`seq discontinuity: expected ${i}, got ${seq}`);
			}
		}
		return records;
	}

	has(sessionId: string): boolean {
		return existsSync(this.pathFor(sessionId));
	}

	list(): SessionMeta[] {
		const metas: SessionMeta[] = [];
		for (const entry of readdirSync(this.root)) {
			if (!entry.endsWith(".jsonl")) continue;
			const id = entry.slice(0, -".jsonl".length);
			const records = this.load(id);
			if (records.length === 0) continue;
			const first = records[0]!.event;
			metas.push({
				id,
				title:
					first.type === "user_input" && typeof first.content === "string"
						? first.content.slice(0, 60)
						: "(no prompt)",
				events: records.length,
				runs: new Set(records.map((r) => r.runId)).size,
				createdAt: records[0]?.ts ?? 0,
				updatedAt: records.at(-1)?.ts ?? 0,
			});
		}
		return metas.sort((a, b) => a.id.localeCompare(b.id));
	}

	// ── lifecycle ────────────────────────────────────────────────────────

	/** Release a session's fd and OUR writer lock. Idempotent. */
	close(sessionId: string): void {
		this.pathFor(sessionId); // id validated before ANY file side effect
		const fd = this.#fds.get(sessionId);
		if (fd !== undefined) {
			closeSync(fd);
			this.#fds.delete(sessionId);
		}
		this.releaseLock(sessionId);
		this.#closed.add(sessionId);
	}

	/** Release every held fd and lock, including locks whose JSONL open failed. */
	closeAll(): void {
		for (const id of new Set([...this.#fds.keys(), ...this.#lockHelpers.keys()])) {
			this.close(id);
		}
	}
}

function isRecord(value: unknown): value is StoreRecord {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.runId === "string" && typeof v.ts === "number" && isKisoEvent(v.event);
}

/**
 * Read a lock file's holder identity (第四轮). Formats:
 *   modern:  {"pid": 123, "token": "..."}
 *   legacy:  a bare pid — either the STRING "123" or, because
 *            JSON.parse("123") yields the NUMBER 123, the number itself.
 *            Neither may be mistaken for an object without a pid.
 * Empty, unreadable, or half-written locks have no identity — the kernel
 * flock supersedes them (there is nothing to refuse, and nothing to
 * delete).
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

/**
 * The lock helper: a python3 process that takes an EXCLUSIVE flock on the
 * lock path and HOLDS it until it dies (its stdin is closed / it is
 * killed). The kernel releases the flock with the helper — the lock is
 * tied to the open file description, so a dead helper can never leave a
 * stale lock behind, and no contender can ever remove a live one.
 * python3's `fcntl` module provides flock on both macOS and Linux.
 */
const LOCK_HELPER_SCRIPT = [
	"import fcntl, os, sys",
	"fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o644)",
	"try:",
	"    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
	"except OSError:",
	"    print('BUSY', flush=True)",
	"    sys.exit(0)",
	"print('LOCKED', flush=True)",
	"try:",
	"    while sys.stdin.buffer.read(1):",
	"        pass",
	"except Exception:",
	"    pass",
].join("\n");

/** The helper's first stdout line: "LOCKED" or anything else = busy/dead. */
function helperVerdict(child: ChildProcess): Promise<string> {
	return new Promise((resolve) => {
		let buf = "";
		let settled = false;
		const done = (verdict: string): void => {
			if (settled) return;
			settled = true;
			child.stdout?.removeAllListeners();
			// The helper is a LOCK DAEMON: it must never keep the parent's
			// event loop alive (a finished store exits cleanly), and when the
			// parent DOES exit the pipes close, the helper's read hits EOF,
			// the helper exits, and the kernel releases the flock. The child
			// process handle, its stdin hold, and its verdict channel are all
			// unref'd — the lock outlives nothing the parent does not.
			const unref = (s: unknown): void => (s as { unref?: () => void })?.unref?.();
			unref(child);
			unref(child.stdin);
			unref(child.stdout);
			resolve(verdict);
		};
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl !== -1) done(buf.slice(0, nl).trim());
		});
		child.stdout?.on("end", () => done(buf.trim()));
		child.stdout?.on("error", () => done("FAILED"));
		child.on("error", () => done("FAILED")); // python3 missing etc.
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * If the file does not end with a newline, truncate to the last complete
 * line (or 0) — the torn-tail repair. Runs on open AND before every append,
 * so an in-process append failure cannot poison the next one.
 */
function repairTornTail(fd: number): void {
	const size = fstatSync(fd).size;
	if (size === 0) return;
	const last = Buffer.alloc(1);
	readSync(fd, last, 0, 1, size - 1);
	if (last[0] === 0x0a) return; // ends cleanly
	const lastNewline = lastNewlineOffset(fd, size);
	ftruncateSync(fd, lastNewline + 1);
	fsyncSync(fd);
}

/** Offset of the last '\n' in the file, or -1 when none exists. */
function lastNewlineOffset(fd: number, size: number): number {
	const chunk = 64 * 1024;
	let offset = size;
	while (offset > 0) {
		const readLen = Math.min(chunk, offset);
		const buf = Buffer.alloc(readLen);
		offset -= readLen;
		readSync(fd, buf, 0, readLen, offset);
		const idx = buf.lastIndexOf(0x0a);
		if (idx !== -1) return offset + idx;
	}
	return -1;
}

/**
 * The seq of the file's last COMMITTED (newline-terminated) record —
 * the CAS anchor. Grows the tail read until the last record parses.
 */
function lastCommittedSeq(fd: number): number | undefined {
	const size = fstatSync(fd).size;
	if (size === 0) return undefined;
	let chunk = 4096;
	while (true) {
		const readLen = Math.min(chunk, size);
		const buf = Buffer.alloc(readLen);
		readSync(fd, buf, 0, readLen, size - readLen);
		const lines = buf
			.toString("utf8")
			.split("\n")
			.filter((l) => l.trim() !== "");
		if (lines.length > 0) {
			try {
				const parsed = JSON.parse(lines[lines.length - 1]!) as { event?: { seq?: unknown } };
				if (typeof parsed?.event?.seq !== "number") {
					throw new Error("not a record");
				}
				return parsed.event.seq;
			} catch {
				if (readLen >= size) {
					throw new StoreCorruptionError("cannot determine the last committed seq — the tail is not a record");
				}
				chunk *= 2;
				continue;
			}
		}
		if (readLen >= size) return undefined;
		chunk *= 2;
	}
}

/** Durability of directory entries: fsync the directory itself. */
function fsyncDir(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Some platforms refuse dir fsync; the file-level fsync still holds.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export type { Event };
