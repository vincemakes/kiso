/**
 * SessionStore — append-only JSONL durability, crash-safe (Area 1).
 *
 * One file per session: `<root>/<id>.jsonl`, lines of
 * `{"runId": string, "ts": number, "event": Event}`. A sibling `<id>.lock`
 * file is the cross-process single-writer lock (O_EXCL create, pid inside;
 * a dead pid's lock is stale and taken over).
 *
 * Durability contract:
 * - `append` fsyncs the file BEFORE it returns (write-ahead);
 * - a crash mid-write leaves a partial tail line; the next append repairs
 *   it (truncate to the last complete newline) UNDER THE LOCK, so new JSON
 *   is never concatenated onto a fragment;
 * - `load` is strict: a partial LAST line is the only tolerated damage;
 *   mid-file garbage, valid-JSON-but-not-a-record lines, and seq
 *   discontinuities throw `StoreCorruptionError` — history is never
 *   silently read as a prefix;
 * - the session directory is fsynced after creation, so a new session
 *   survives a crash of the machine, not just the process.
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
	readonly #locks = new Set<string>();
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

	/** Take the single-writer lock (O_EXCL). Stale locks (dead pid) are
	 *  taken over; a live writer's lock is a loud error, not a queue. */
	private acquireLock(sessionId: string): void {
		if (this.#locks.has(sessionId)) return;
		const lockPath = this.lockPathFor(sessionId);
		try {
			const fd = openSync(lockPath, "wx");
			writeFileSync(fd, String(process.pid));
			fsyncSync(fd);
			closeSync(fd);
			this.#locks.add(sessionId);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			let holder: number | null = null;
			try {
				holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
			} catch {
				holder = null; // unreadable lock — treat as stale
			}
			if (holder !== null && isAlive(holder)) {
				throw new Error(`session ${sessionId} is locked by another writer (pid ${holder})`);
			}
			unlinkSync(lockPath); // stale — the holder died without releasing
			this.acquireLock(sessionId);
		}
	}

	// ── append: lock, repair, write, fsync ───────────────────────────────

	/** Write-ahead: durable (written + fsynced) before returning. */
	append(sessionId: string, runId: string, event: Event): void {
		if (this.#closed.has(sessionId)) {
			throw new Error(`session store is closed for ${sessionId}`);
		}
		this.acquireLock(sessionId);
		const fd = this.fd(sessionId);
		appendFileSync(fd, `${JSON.stringify({ runId, ts: Date.now(), event })}\n`);
		fsyncSync(fd);
	}

	/**
	 * Open (creating if needed) the session file, repairing a torn tail
	 * FIRST: if the file does not end with a newline, truncate to the last
	 * complete newline — under the writer lock, so no other writer can be
	 * mid-append. The parent directory is fsynced so the file's existence
	 * survives a crash.
	 */
	private fd(sessionId: string): number {
		const existing = this.#fds.get(sessionId);
		if (existing !== undefined) return existing;

		const path = this.pathFor(sessionId);
		const fd = openSync(path, "a+");
		const size = fstatSync(fd).size;
		if (size > 0) {
			const lastNewline = lastNewlineOffset(fd, size);
			if (lastNewline !== size - 1) {
				// The file ends in a fragment: truncate to the last \n
				// (or 0 when there is none) before anything is appended.
				ftruncateSync(fd, lastNewline + 1);
				fsyncSync(fd);
			}
		}
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
		// The torn tail is the last NON-EMPTY fragment; only it may be damaged.
		const nonEmpty: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] !== "") nonEmpty.push(i);
		}
		// A torn tail is a PARTIAL line — the file ends without a newline.
		// A complete final line (ends with \n) that is garbage is corruption,
		// never silently dropped.
		const tolerantTail = !raw.endsWith("\n");
		const records: StoreRecord[] = [];
		for (let k = 0; k < nonEmpty.length; k++) {
			const line = lines[nonEmpty[k]!]!;
			const isLast = k === nonEmpty.length - 1;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				if (isLast && tolerantTail) break; // torn tail — the one tolerated damage
				throw new StoreCorruptionError(`line ${nonEmpty[k]! + 1} is not JSON`);
			}
			if (!isRecord(parsed)) {
				if (isLast && tolerantTail) break; // a truncated object that happens to parse
				throw new StoreCorruptionError(`line ${nonEmpty[k]! + 1} is not a session record`);
			}
			records.push(parsed);
		}

		// seq must be exactly 0..N — a gap or duplicate is a lost or
		// forged event, and array length must never mask it.
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

	/** Release a session's fd and writer lock. Idempotent. */
	close(sessionId: string): void {
		const fd = this.#fds.get(sessionId);
		if (fd !== undefined) {
			closeSync(fd);
			this.#fds.delete(sessionId);
		}
		this.#locks.delete(sessionId);
		this.#closed.add(sessionId);
		try {
			unlinkSync(this.lockPathFor(sessionId));
		} catch {
			// already gone
		}
	}

	closeAll(): void {
		for (const id of [...this.#fds.keys()]) this.close(id);
	}
}

function isRecord(value: unknown): value is StoreRecord {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.runId === "string" && typeof v.ts === "number" && isKisoEvent(v.event);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
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
