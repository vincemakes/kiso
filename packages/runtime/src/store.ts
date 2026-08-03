/**
 * SessionStore — append-only JSONL durability, identity-safe (A 组).
 *
 * One file per session: `<root>/<id>.jsonl`, lines of
 * `{"runId": string, "ts": number, "event": Event}`. A sibling `<id>.lock`
 * carries `{"pid": number, "token": string}` — the random owner TOKEN is
 * what makes lock release safe: only the instance whose token still
 * matches may unlink (a foreign close can never steal another writer's
 * lock).
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
 * - close() releases only the lock this instance holds; closeAll()
 *   releases every held lock, including the case where the lock was
 *   acquired but opening the JSONL failed;
 * - load is strict (A 组 round 1): a partial final line is the only
 *   tolerated damage; everything else throws StoreCorruptionError.
 */

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
	/** sessionId → the owner token THIS instance wrote (and may unlink). */
	readonly #locks = new Map<string, string>();
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
	 * Take the single-writer lock (O_EXCL) with a random owner token. A
	 * stale lock (dead pid) is taken over; a live writer's lock is a loud
	 * error. The takeover race between two contenders is tolerated: the
	 * loser's unlink ENOENT retries the acquire.
	 */
	private acquireLock(sessionId: string): void {
		if (this.#locks.has(sessionId)) return;
		const lockPath = this.lockPathFor(sessionId);
		const token = crypto.randomUUID();
		try {
			const fd = openSync(lockPath, "wx");
			writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
			fsyncSync(fd);
			closeSync(fd);
			this.#locks.set(sessionId, token);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			let holder: { pid?: number; token?: string } | null = null;
			try {
				holder = parseLock(readFileSync(lockPath, "utf8"));
			} catch {
				holder = null; // unreadable lock — treat as stale
			}
			if (holder?.pid !== undefined && isAlive(holder.pid)) {
				throw new Error(`session ${sessionId} is locked by another writer (pid ${holder.pid})`);
			}
			// 二: takeover is IDENTITY-CONFIRMED, never a blind delete. The
			// stale lock is renamed AWAY atomically; then we verify that what
			// we moved is the SAME lock we read. If a rival created a live
			// lock in between, the rename moved THAT — we restore it and
			// retry (the live lock is never deleted).
			const tomb = `${lockPath}.takeover-${crypto.randomUUID()}`;
			try {
				renameSync(lockPath, tomb);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					// A concurrent recovery already took it over — retry.
					return this.acquireLock(sessionId);
				}
				throw err;
			}
			let moved: { pid?: number; token?: string } | null = null;
			try {
				moved = parseLock(readFileSync(tomb, "utf8"));
			} catch {
				moved = null;
			}
			// Identity confirmed: the moved lock has the same token AND pid as
			// the one we read. A rival's live lock has a different token.
			const sameIdentity =
				moved !== null &&
				(moved.token ?? null) === (holder?.token ?? null) &&
				(moved.pid ?? null) === (holder?.pid ?? null);
			if (!sameIdentity) {
				// We moved a DIFFERENT lock (a live one) — put it back.
				try {
					renameSync(tomb, lockPath);
				} catch {
					// the rival already re-created it — drop the tomb
					unlinkSync(tomb);
				}
				return this.acquireLock(sessionId);
			}
			unlinkSync(tomb); // our stale lock — now gone
			this.acquireLock(sessionId);
		}
	}

	/**
	 * Release OUR lock only: read the lock back and unlink only when the
	 * owner token still matches. A lock another instance took over is left
	 * alone (foreign-close protection).
	 */
	private releaseLock(sessionId: string): void {
		const token = this.#locks.get(sessionId);
		if (token === undefined) return;
		try {
			const lock = JSON.parse(readFileSync(this.lockPathFor(sessionId), "utf8")) as { token?: string };
			if (lock.token === token) {
				unlinkSync(this.lockPathFor(sessionId));
			}
		} catch {
			// already gone
		}
		this.#locks.delete(sessionId);
	}

	// ── append: lock, open, repair, CAS, write, fsync ────────────────────

	/** Write-ahead: durable (written + fsynced) before returning. */
	append(sessionId: string, runId: string, event: Event): void {
		if (this.#closed.has(sessionId)) {
			throw new Error(`session store is closed for ${sessionId}`);
		}
		this.pathFor(sessionId); // id validated before ANY file side effect
		this.acquireLock(sessionId);
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
		for (const id of new Set([...this.#fds.keys(), ...this.#locks.keys()])) {
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
 * Parse a lock file: modern JSON {pid, token} or the legacy bare-pid
 * string. Legacy locks have no token — a takeover can still verify the
 * pid (the moved file's pid must match the one we read).
 */
function parseLock(raw: string): { pid?: number; token?: string } | null {
	try {
		return JSON.parse(raw) as { pid?: number; token?: string };
	} catch {
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isFinite(pid) ? { pid } : null;
	}
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
