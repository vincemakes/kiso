/**
 * CX-1 F4 — the search walk-and-match, on its own thread.
 *
 * `search_text` compiles a model-supplied regex and runs it per line;
 * a catastrophic pattern (`(a+)+$` on 33 characters) blocks the event
 * loop, and no budget check, timer or abort can run (audit F4). The
 * walk lives here, in a `worker_threads` Worker the main thread can
 * TERMINATE: the deadline and the abort signal both kill it. The root
 * is resolved and confined on the main side (`resolveWithinRoot`); this
 * side only walks under it, with the same skip rules as before (dot
 * paths, node_modules, depth 8, excluded dirs, binary sniff, per-file
 * bytes, per-call files).
 *
 * Messages: the parent posts one `SearchRequest`; the worker answers
 * one `SearchReply` and exits. A call token rides both ways so a late
 * message from a superseded worker is ignored.
 */

import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";

export interface SearchRequest {
	readonly token: number;
	readonly root: string;
	/** a single file to scan instead of walking `root` */
	readonly single: string | null;
	readonly pattern: string;
	readonly flags: string;
	readonly excluded: readonly string[];
	readonly maxFileBytes: number;
	readonly maxFiles: number;
	/** the call's wall-clock deadline (epoch ms): the walk stops COOPERATIVELY
	 *  between files and reports its counters (the DC-54 note); the host's
	 *  terminate is the backstop for the one thing that cannot cooperate —
	 *  a regex that never returns */
	readonly deadline: number;
	readonly maxMatches: number;
	readonly sniffBytes: number;
}

export interface SearchReply {
	readonly token: number;
	readonly matches: string[];
	readonly totalMatches: number;
	readonly filesSeen: number;
	readonly skippedFiles: number;
	readonly multiLink: number;
	readonly unreadableDirs: number;
	readonly excludedDirs: number;
	readonly stopped: boolean;
	readonly stoppedAt: number;
	readonly error?: string;
}

export async function runSearch(req: SearchRequest): Promise<SearchReply> {
	const regex = new RegExp(req.pattern, req.flags);
	const matches: string[] = [];
	let totalMatches = 0;
	let filesSeen = 0;
	let skippedFiles = 0;
	let multiLink = 0;
	let unreadableDirs = 0;
	let excludedDirs = 0;
	let stopped = false;
	let stoppedAt = 0;
	const isExcluded = (full: string): boolean => {
		const r = relative(req.root, full);
		return req.excluded.some((ex) => r === ex || r.startsWith(`${ex}/`));
	};
	const outOfBudget = (): boolean => {
		if (stopped) return true;
		if (filesSeen >= req.maxFiles || Date.now() > req.deadline) {
			stopped = true;
			stoppedAt = filesSeen;
			return true;
		}
		return false;
	};
	const scanFile = async (full: string): Promise<void> => {
		if (outOfBudget()) return;
		filesSeen += 1;
		try {
			const fh = await open(full, "r");
			let text: string;
			try {
				const st = await fh.stat();
				if (st.nlink > 1) {
					multiLink += 1;
					return;
				}
				if (st.size > req.maxFileBytes) {
					skippedFiles += 1;
					return;
				}
				const headLen = Math.min(req.sniffBytes, st.size);
				const head = Buffer.alloc(headLen);
				if (headLen > 0) {
					await fh.read(head, 0, headLen, 0);
					if (head.includes(0)) {
						skippedFiles += 1;
						return;
					}
				}
				text = (st.size <= headLen ? head : await fh.readFile()).toString("utf8");
			} finally {
				await fh.close();
			}
			for (const [i, line] of text.split("\n").entries()) {
				if (regex.test(line)) {
					totalMatches += 1;
					if (matches.length < req.maxMatches) matches.push(`${full}:${i + 1}: ${line.trim().slice(0, 160)}`);
				}
			}
		} catch {
			// unreadable file: skipped, like before
		}
	};
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 8 || outOfBudget()) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") {
				unreadableDirs += 1;
				return;
			}
			throw err;
		}
		for (const entry of entries) {
			if (outOfBudget()) return;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (isExcluded(full)) {
					excludedDirs += 1;
					continue;
				}
				await walk(full, depth + 1);
			} else if (entry.isFile()) await scanFile(full);
		}
	};
	try {
		if (req.single !== null) await scanFile(req.single);
		else await walk(req.root, 0);
	} catch (err) {
		return { token: req.token, matches, totalMatches, filesSeen, skippedFiles, multiLink, unreadableDirs, excludedDirs, stopped, stoppedAt, error: (err as Error).message };
	}
	return { token: req.token, matches, totalMatches, filesSeen, skippedFiles, multiLink, unreadableDirs, excludedDirs, stopped, stoppedAt };
}

if (!isMainThread && parentPort !== null) {
	parentPort.once("message", (req: SearchRequest) => {
		void runSearch(req).then(
			(reply) => parentPort!.postMessage(reply),
			(err: unknown) => parentPort!.postMessage({ token: req.token, matches: [], totalMatches: 0, filesSeen: 0, skippedFiles: 0, multiLink: 0, unreadableDirs: 0, excludedDirs: 0, stopped: false, stoppedAt: 0, error: (err as Error).message } satisfies SearchReply),
		);
	});
}
