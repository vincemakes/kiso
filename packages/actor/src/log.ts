/**
 * ADR-0064 § 2.3 — the storage contract. An append-only log: one writer per
 * log, a sequence CAS on every append, a strict load. A backend stores events
 * opaquely; what an event means is the reducer's business, never the store's.
 *
 * `revision` is the last committed seq (-1 for an empty log). An append names
 * the revision it was decided on and is refused when the log has moved.
 */

export type LogLine<T> = { readonly seq: number; readonly ts: number; readonly event: T };

/** The single writer of one log. */
export interface AppendLog<T> {
	/** The committed lines, as of open plus this writer's own appends. */
	lines(): readonly LogLine<T>[];
	readonly revision: number;
	/** Durable before it resolves. StaleRevisionError when `expectedRevision` is not the log's last committed seq. */
	append(expectedRevision: number, event: T): Promise<number>;
	/** Release this writer only. */
	close(): Promise<void>;
}

export interface AppendLogBackend<T> {
	/** Take the single writer of `logId`, creating the log if absent. LogLockedError if another writer holds it. */
	writer(logId: string): Promise<AppendLog<T>>;
	/** Read without writing; a log that does not exist reads as no lines. */
	read(logId: string): Promise<readonly LogLine<T>[]>;
}

export class StaleRevisionError extends Error {
	constructor(expected: number, actual: number) {
		super(`stale revision: appended against ${expected}, the log is at ${actual}`);
		this.name = "StaleRevisionError";
	}
}

/**
 * Another writer holds the log. With the file backend's native lock
 * (ADR-0050), a live holder in another process is refused at once and a dead
 * one is taken over. A holder in THIS process is a writer that will release,
 * so the adapter retries it 25 times, 20 ms apart, before refusing: about
 * 0.5 s, 0.76 s measured on the conformance run.
 */
export class LogLockedError extends Error {
	constructor(logId: string) {
		super(`log ${logId} has another writer`);
		this.name = "LogLockedError";
	}
}

/** A write or its fsync failed; this writer refuses every later append. Close it and open a new writer. */
export class LogPoisonedError extends Error {
	constructor(logId: string, cause: unknown) {
		super(`log ${logId} writer is poisoned by a failed write: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.name = "LogPoisonedError";
	}
}

export class LogCorruptionError extends Error {
	constructor(logId: string, message: string) {
		super(`log ${logId} is corrupt: ${message}`);
		this.name = "LogCorruptionError";
	}
}

/** Log ids become paths: segments of host-safe characters, joined by "/". */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
export function validLogId(logId: string): boolean {
	return logId.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

/** Strict shape of one stored line: contiguous seq from 0, a number ts, an object event. */
export function checkLine(logId: string, raw: unknown, index: number): LogLine<unknown> {
	const v = raw as { seq?: unknown; ts?: unknown; event?: unknown } | null;
	if (typeof v !== "object" || v === null || v.seq !== index || typeof v.ts !== "number" || typeof v.event !== "object" || v.event === null) {
		throw new LogCorruptionError(logId, `line ${index} is not a record at seq ${index}`);
	}
	return { seq: index, ts: v.ts, event: v.event };
}
