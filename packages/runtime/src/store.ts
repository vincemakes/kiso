/**
 * SessionStore — append-only JSONL durability, identity-safe (A group).
 *
 * One file per session: `<root>/<id>.jsonl`, lines of
 * `{"runId": string, "ts": number, "event": Event}`. The single-writer
 * lock (R-G 0.1.47, ADR-0050) is the native identity-confirmed LINK LOCK
 * on `<id>.lock` — no helper process, no python3. Possession is decided by
 * atomic filesystem operations (see lock-adapter.ts for the full protocol
 * and the residual family):
 *
 * - the final path exists ONLY by linking a fully-written and fsynced
 *   identity file (atomic create-if-absent) — a kill can never leave an
 *   empty or half-written lock; dead holders are taken over by identity
 *   confirmation (rename-away → verify → link), never by deletion;
 * - the file carries `{"pid": number, "token": string}`; the holder's
 *   possession is RE-CHECKED at every append (the file must still name its
 *   pid AND token) and a failure is a strict refusal — no retry, no wait
 *   heuristic: a displaced holder fails honestly and the session resumes
 *   from a fresh store, never two writers (ADR-0050 §residual);
 * - the identity format is the cross-version channel (round 4 formats
 *   unchanged). A dead/empty/unreadable legacy lock is residue and is
 *   taken over — the documented upgrade contract is QUARANTINE (round 5
 *   P1-4): stop every old-format process, THEN start the new version
 *   (ADR-0050 §migration);
 * - the mechanism is an injection point: `new SessionStore(root, {
 *   lockAdapter })` — the interface is the extension point, and the
 *   default adapter is `nativeLockAdapter` (ADR-0050);
 * - `close()` releases only THIS instance's handle; `closeAll()` every
 *   held handle — a foreign close can never release another writer's
 *   lock. Release leaves the EMPTY released marker; the path is never
 *   deleted.
 *
 * Consistency contract (A group):
 * - every id is validated BEFORE any file side effect (append, close,
 *   load, lock paths);
 * - append runs an expected-last-seq CAS against the file's REAL last
 *   committed seq: a stale preloaded handle writing a duplicate seq is
 *   refused with StaleWriterError — and the run that fed it terminates,
 *   so the in-memory EventLog never continues past a rejected write;
 * - the torn tail is repaired before EVERY append, and committed records
 *   (newline-terminated) are never truncated;
 * - load is strict (A group round 1): a partial final line is the only
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
	readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isKisoEvent, type Event } from "@vincemakes/kiso-core";
import {
	LockedError,
	nativeLockAdapter,
	type LockAdapter,
	type LockHandle,
} from "./lock-adapter.js";

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

/** REL-0152-D6 — a session is named by its first REQUEST, not its first
 *  word.
 *
 *  This used to take `records[0]` unconditionally, so a session was
 *  titled by whatever the user opened with. Three of the owner's five
 *  sessions opened with a greeting, and the picker showed three
 *  identical rows separated only by a timestamp they had to decode.
 *  RD1B-F9 made ids unique; unique is not meaningful.
 *
 *  A greeting is skipped only when something follows it — a session that
 *  is genuinely nothing but "hello" is still titled "hello", because the
 *  alternative is naming it "(no prompt)" when a prompt plainly exists.
 *  No model call: this is a scan of the turns already on disk. */
const GREETING = /^\s*(hi|hey|hello|yo|你好|您好|哈罗|嗨|ping|test|测试)[\s!.,?！。，？~]*$/i;

function titleOf(records: readonly StoreRecord[]): string {
	const asked = records
		.map((r) => r.event as { type: string; content?: unknown })
		.filter((e) => e.type === "user_input" && typeof e.content === "string")
		.map((e) => (e.content as string).trim())
		.filter((t) => t !== "");
	if (asked.length === 0) return "(no prompt)";
	const substantive = asked.find((t) => !GREETING.test(t));
	return (substantive ?? asked[0]!).slice(0, 60);
}

export class SessionStore {
	readonly root: string;
	readonly #fds = new Map<string, number>();
	/** sessionId → the lock handle THIS instance holds (ADR-0050). */
	readonly #lockHandles = new Map<string, LockHandle>();
	readonly #lockAdapter: LockAdapter;
	/** round 4 (adversarial): serialize concurrent acquireLock calls ON this instance —
	 *  two racing appends must not issue two acquisitions and fight each other. */
	readonly #lockAcquiring = new Map<string, Promise<void>>();
	/** round 5(P1-1): serialize the WHOLE append critical section per session on
	 *  this instance — lock check → CAS → write → fsync. A rejected write
	 *  propagates to every append queued behind it, so a concurrent write can
	 *  never land after a stale failure (which would fork memory and disk). */
	readonly #appendQueues = new Map<string, Promise<void>>();
	readonly #closed = new Set<string>();

	constructor(root: string, opts?: { lockAdapter?: LockAdapter }) {
		this.root = root;
		this.#lockAdapter = opts?.lockAdapter ?? nativeLockAdapter;
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
	 * Take the single-writer lock (R-G 0.1.47, ADR-0050): the identity-
	 * confirmed link lock (see lock-adapter.ts). The adapter decides
	 * possession by atomic filesystem operations; a dead holder is taken
	 * over by identity confirmation (rename-away → verify → link), a live
	 * foreign writer refuses. No recursion, no deletion, no window between
	 * writers. The adapter's `cancelled` callback throws the store's closed
	 * message so a close() that landed mid-acquisition aborts it
	 * immediately (round 5 P1-3).
	 */
	private async acquireLock(sessionId: string): Promise<void> {
		// round 5(P1-2): a lock is held only while THIS instance's handle is
		// held — a displaced/dead lock must never be trusted as "locked".
		if (this.lockHeld(sessionId)) return;
		const inFlight = this.#lockAcquiring.get(sessionId);
		if (inFlight !== undefined) return inFlight;
		const attempt = this.#acquireLockOnce(sessionId).finally(() => this.#lockAcquiring.delete(sessionId));
		this.#lockAcquiring.set(sessionId, attempt);
		return attempt;
	}

	/** round 5(P1-2): true only while THIS instance holds its handle. */
	private lockHeld(sessionId: string): boolean {
		return this.#lockHandles.has(sessionId);
	}

	async #acquireLockOnce(sessionId: string): Promise<void> {
		const lockPath = this.lockPathFor(sessionId);
		const handle = await this.#lockAdapter.acquire(lockPath, sessionId, () => {
			if (this.#closed.has(sessionId)) {
				throw new Error(`session store is closed for ${sessionId}`);
			}
		});
		// round 5(P1-3): a close() that landed while we waited ends the
		// acquisition immediately — no lock outlives the instance.
		if (this.#closed.has(sessionId)) {
			handle.release();
			throw new Error(`session store is closed for ${sessionId}`);
		}
		this.#lockHandles.set(sessionId, handle);
	}

	/**
	 * Release OUR lock only: release OUR handle (the adapter leaves the
	 * empty released marker at the path — never a deletion). A foreign
	 * close can never release another writer's lock (ADR-0050).
	 */
	private releaseLock(sessionId: string): void {
		const handle = this.#lockHandles.get(sessionId);
		if (handle === undefined) return;
		this.#lockHandles.delete(sessionId);
		handle.release();
	}

	// ── append: lock, open, repair, CAS, write, fsync ────────────────────

	/** Write-ahead: durable (written + fsynced) before returning. */
	async append(sessionId: string, runId: string, event: Event): Promise<void> {
		if (this.#closed.has(sessionId)) {
			throw new Error(`session store is closed for ${sessionId}`);
		}
		this.pathFor(sessionId); // id validated before ANY file side effect
		// round 5(P1-1): the WHOLE critical section is serialized per session
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
		// round 5(P1-3): close() may have returned while we waited — the
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
		// R-G 0.1.47 (ADR-0050): possession is RE-CHECKED at every append —
		// the file must still name this handle's pid AND token. A displaced
		// holder's next append SELF-REFUSES honestly (strict refusal, no
		// retry): never a lockless write, never a second writer.
		const handle = this.#lockHandles.get(sessionId);
		if (handle === undefined || !handle.verify()) {
			throw new LockedError(`session ${sessionId} is locked by another writer`);
		}
		let fd: number;
		try {
			fd = this.fd(sessionId);
		} catch (err) {
			// The lock was acquired but the JSONL could not be opened:
			// release the lock — it must not leak (A group).
			this.releaseLock(sessionId);
			throw err;
		}
		repairTornTail(fd);
		// Expected-last-seq CAS against the file's REAL last committed seq
		// (A group): a stale preloaded handle cannot write a duplicate seq.
		const last = lastCommittedSeq(fd);
		const expected = (last ?? -1) + 1;
		if (event.seq !== expected) {
			throw new StaleWriterError(expected, event.seq);
		}
		appendFileSync(fd, `${JSON.stringify({ runId, ts: Date.now(), event })}\n`);
		fsyncSync(fd);
		// round 5(P1-3): a close() that landed during the write must not
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
		// round 2: a line WITHOUT a trailing newline is NOT committed — whether
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
			metas.push({
				id,
				title: titleOf(records),
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
		for (const id of new Set([...this.#fds.keys(), ...this.#lockHandles.keys()])) {
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
