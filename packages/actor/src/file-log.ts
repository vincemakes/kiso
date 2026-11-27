/**
 * ADR-0064 § 2.3 — the file backend: one JSONL file per log at
 * `<root>/<logId>.jsonl`, with the session store's discipline (store.ts):
 *
 * - the single writer holds the identity-confirmed link lock (ADR-0050),
 *   re-verified at every append; a displaced writer refuses, never writes;
 * - the torn tail is repaired before every append; committed lines are
 *   never truncated;
 * - the CAS compares against the FILE's last committed seq, not a cache;
 * - an append resolves only after an async fsync, under the writer lock,
 *   one at a time (the 0.56.0 durability rule); a new file's directory is
 *   fsynced too;
 * - load is strict: a partial last line is the only tolerated damage.
 *
 * The host chooses `root`; there is no default (tenancy is the host's).
 */
import { appendFileSync, closeSync, constants, fstatSync, fsync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeLockAdapter, LockedError, type LockAdapter, type LockHandle } from "@vincemakes/kiso-runtime/internal";
import { lastCommittedSeq, repairTornTail } from "./file-tail.js";
import { checkLine, LogCorruptionError, LogLockedError, LogPoisonedError, StaleRevisionError, validLogId, type AppendLog, type AppendLogBackend, type LogLine } from "./log.js";

const WINDOWS = process.platform === "win32";

export class FileLogBackend<T> implements AppendLogBackend<T> {
	readonly #root: string;
	readonly #lock: LockAdapter;

	constructor(root: string, opts: { readonly lockAdapter?: LockAdapter } = {}) {
		this.#root = root;
		this.#lock = opts.lockAdapter ?? nativeLockAdapter;
	}

	#path(logId: string): string {
		if (!validLogId(logId)) throw new Error(`invalid log id: ${logId}`);
		return join(this.#root, `${logId}.jsonl`);
	}

	async read(logId: string): Promise<readonly LogLine<T>[]> {
		const path = this.#path(logId);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return parseLines<T>(logId, text);
	}

	async writer(logId: string): Promise<AppendLog<T>> {
		const path = this.#path(logId);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		let handle: LockHandle;
		try {
			handle = await this.#lock.acquire(`${path}.lock`, logId, () => {});
		} catch (error) {
			if (error instanceof LockedError) throw new LogLockedError(logId);
			throw error;
		}
		let fd: number;
		try {
			// Windows: a handle opened for append can be neither flushed nor
			// truncated (FlushFileBuffers and SetEndOfFile need the write access
			// append mode drops), so the log opens read-write there and every
			// append writes at the end, as the session store does (store.ts).
			fd = openSync(path, WINDOWS ? constants.O_RDWR | constants.O_CREAT : "a+", 0o600);
			repairTornTail(fd);
			fsyncDir(dirname(path));
		} catch (error) {
			handle.release();
			throw error;
		}
		let lines: LogLine<T>[];
		try {
			lines = parseLines<T>(logId, readFileSync(path, "utf8"));
		} catch (error) {
			closeSync(fd);
			handle.release();
			throw error;
		}
		return new FileLog<T>(logId, fd, handle, lines);
	}
}

class FileLog<T> implements AppendLog<T> {
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;
	/** A write or its fsync failed: what reached the disk is unknown, so this writer never appends again. */
	#poisoned: unknown = undefined;

	constructor(
		readonly logId: string,
		readonly fd: number,
		readonly handle: LockHandle,
		readonly committed: LogLine<T>[],
	) {}

	lines(): readonly LogLine<T>[] {
		return this.committed;
	}

	get revision(): number {
		return this.committed.length - 1;
	}

	append(expectedRevision: number, event: T): Promise<number> {
		const run = this.#queue.then(() => this.#appendOnce(expectedRevision, event));
		this.#queue = run.catch(() => {});
		return run;
	}

	async #appendOnce(expectedRevision: number, event: T): Promise<number> {
		if (this.#closed) throw new Error(`log ${this.logId} is closed`);
		if (this.#poisoned !== undefined) throw new LogPoisonedError(this.logId, this.#poisoned);
		if (!this.handle.verify()) throw new LogLockedError(this.logId);
		repairTornTail(this.fd);
		const actual = lastCommittedSeq(this.logId, this.fd);
		if (actual !== expectedRevision || actual !== this.revision) throw new StaleRevisionError(expectedRevision, actual);
		const line: LogLine<T> = { seq: actual + 1, ts: Date.now(), event };
		try {
			const text = `${JSON.stringify(line)}\n`;
			// The lock makes this the only writer, so the end is where the line goes.
			if (WINDOWS) writeSync(this.fd, text, fstatSync(this.fd).size);
			else appendFileSync(this.fd, text);
			await new Promise<void>((resolve, reject) => fsync(this.fd, (error) => (error === null ? resolve() : reject(error))));
		} catch (error) {
			// The line may be on disk without being durable or in `committed`.
			// Permanent poison, as in the session store: refuse every later
			// append with this cause, never a misleading stale revision. A new
			// writer re-reads the file and repairs its tail.
			this.#poisoned = error;
			throw new LogPoisonedError(this.logId, error);
		}
		this.committed.push(line);
		return line.seq;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#queue;
		closeSync(this.fd);
		this.handle.release();
	}
}

function parseLines<T>(logId: string, text: string): LogLine<T>[] {
	const raw = text.split("\n");
	raw.pop(); // after the last newline: "" when clean, a torn fragment otherwise (tolerated)
	return raw.map((l, i) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(l);
		} catch {
			throw new LogCorruptionError(logId, `line ${i} does not parse`);
		}
		return checkLine(logId, parsed, i) as LogLine<T>;
	});
}

function fsyncDir(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Some platforms refuse a directory fsync; the file's own fsync still holds.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
