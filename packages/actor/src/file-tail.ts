/**
 * The file backend's tail reads (review R9). Both run under the writer lock on
 * every append, so both cost the last line's length, never the file's. Not
 * exported from the package index.
 */
import { fstatSync, fsyncSync, ftruncateSync, readSync } from "node:fs";
import { LogCorruptionError } from "./log.js";

/**
 * Offset of the last newline at or before `end` (exclusive), or -1. Reads
 * backwards in chunks, so the cost is the last line's length, never the file's.
 */
function newlineBefore(fd: number, end: number): number {
	const chunk = 64 * 1024;
	let offset = end;
	while (offset > 0) {
		const len = Math.min(chunk, offset);
		const buf = Buffer.alloc(len);
		offset -= len;
		readSync(fd, buf, 0, len, offset);
		const at = buf.lastIndexOf(0x0a);
		if (at !== -1) return offset + at;
	}
	return -1;
}

/** Truncate a partial last line (no trailing newline) back to the last newline. */
export function repairTornTail(fd: number): void {
	const size = fstatSync(fd).size;
	if (size === 0) return;
	const last = Buffer.alloc(1);
	readSync(fd, last, 0, 1, size - 1);
	if (last[0] === 0x0a) return;
	ftruncateSync(fd, newlineBefore(fd, size) + 1);
	fsyncSync(fd);
}

/**
 * The file's real last committed seq: the CAS anchor. Read from the FILE on
 * every append, never from a cache, but only its last line: the tail is
 * already repaired, so the file ends with a newline and the last line runs
 * from the newline before it.
 */
export function lastCommittedSeq(logId: string, fd: number): number {
	const size = fstatSync(fd).size;
	if (size === 0) return -1;
	const start = newlineBefore(fd, size - 1) + 1;
	const buf = Buffer.alloc(size - 1 - start);
	readSync(fd, buf, 0, buf.length, start);
	try {
		const seq = (JSON.parse(buf.toString("utf8")) as { seq?: unknown }).seq;
		if (typeof seq === "number") return seq;
	} catch {
		// fall through
	}
	throw new LogCorruptionError(logId, "the last committed line is not a record");
}
