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
import { basename, join, relative, sep } from "node:path";
import { corpusSkips, layersEntering, readLayer, walkCorpus, type Layer } from "./corpus.js";
import { isMainThread, parentPort } from "node:worker_threads";
import { diskPath, isProtectedDiskPath, type ProtectedIdentity } from "./protected.js";

/** A scanned file is protected by inode (the store itself, under any name
 *  or case), or — for a name that starts like a protected one, the writer's
 *  temp file and lock — by the disk's own resolution. The resolution runs
 *  only for such a name, so an ordinary search pays nothing for it. */
function isProtectedScan(full: string, st: { readonly dev: number; readonly ino: number }, id: ProtectedIdentity): boolean {
	if (id.inodes.includes(`${st.dev}:${st.ino}`)) return true;
	const name = basename(full).toLowerCase();
	if (!id.paths.some((p) => name.startsWith(basename(p).toLowerCase()))) return false;
	return isProtectedDiskPath(diskPath(full), id);
}


/** ACI-5 — the excerpt WINDOWS THE MATCH instead of taking the line's head.
 *
 *  `line.trim().slice(0, 160)` answers "what does this line start with",
 *  and the model asked "where is my pattern". Measured over 171 real
 *  search results and 1,931 excerpt lines: 11.7% hit the 160-char cut and
 *  6.1% did not contain the pattern they matched — a hit the model cannot
 *  act on without spending a read to find out what it found.
 *
 *  A short line is returned exactly as before, markers and all absent, so
 *  the common case is byte-identical. */
const EXCERPT_RADIUS = 80;

function excerptAround(line: string, regex: RegExp): string {
	const trimmed = line.trim();
	if (trimmed.length <= EXCERPT_RADIUS * 2) return trimmed;
	// A fresh non-global copy: `lastIndex` on a shared /g regex would make
	// the excerpt depend on which line was scanned before it.
	const found = new RegExp(regex.source, regex.flags.replace("g", "")).exec(trimmed);
	const at = found ? found.index : 0;
	const hit = found ? found[0].length : 0;
	const start = Math.max(0, at - EXCERPT_RADIUS);
	const end = Math.min(trimmed.length, at + hit + EXCERPT_RADIUS);
	return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

export interface SearchRequest {
	readonly kind?: "search";
	readonly token: number;
	readonly root: string;
	/** The WORKSPACE root, which is not always the search root: a search under
	 *  `packages/runtime` must still name `packages/runtime/src/run.ts` so the
	 *  result can be handed to `read_file` unchanged. Realpath'd by the
	 *  caller, because `full` is walked from a realpath'd root and a mixed
	 *  pair produces `../..` the moment a symlink is involved. */
	readonly workspaceRoot: string;
	/** a single file to scan instead of walking `root` */
	readonly single: string | null;
	readonly pattern: string;
	readonly flags: string;
	readonly excluded: readonly string[];
	/** files never searched: kiso's credential store (protected.ts) — skipped
	 *  without a hit, matched by inode and, for a protected name, by the
	 *  disk's own resolution */
	readonly protectedIdentity?: ProtectedIdentity;
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

/** 0.47.2 — `list_dir`'s glob walk, on this thread. It walked on the main
 *  thread, synchronously: a project's name sought from a home directory held kiso
 *  for 11 s — no frame, no timer, no esc. The walk is the SAME
 *  `walkCorpus` it always was; it runs here, under the call's budget. */
export interface GlobRequest {
	readonly kind: "glob";
	readonly token: number;
	/** Both realpath'd by the caller, for the reason `SearchRequest`'s
	 *  workspace root is: a path made relative between a resolved and an
	 *  unresolved base is `../..` the moment a symlink sits between them. */
	readonly workspaceRoot: string;
	readonly walkFrom: string;
	/** the compiled glob (`globToRegExp`), as source and flags */
	readonly source: string;
	readonly flags: string;
	/** DC-49 exclude roots, workspace-relative */
	readonly excluded: readonly string[];
	readonly maxEntries: number;
	readonly maxVisited: number;
	readonly deadline: number;
}

export interface GlobReply {
	readonly kind: "glob";
	readonly token: number;
	readonly files: string[];
	readonly cutByDepth: boolean;
	readonly cutByCap: boolean;
	readonly cutByVisits: boolean;
	readonly cutByDeadline: boolean;
	readonly visited: number;
	readonly error?: string;
}

export function runGlob(req: GlobRequest): GlobReply {
	const re = new RegExp(req.source, req.flags);
	const walk = walkCorpus({
		workspaceRoot: req.workspaceRoot,
		walkFrom: req.walkFrom,
		maxEntries: req.maxEntries,
		maxVisited: req.maxVisited,
		deadline: req.deadline,
		accept: (rel) => re.test(rel),
		isExcluded: (full) => {
			const r = relative(req.workspaceRoot, full).split(sep).join("/");
			return req.excluded.some((ex) => r === ex || r.startsWith(`${ex}/`));
		},
	});
	return { kind: "glob", token: req.token, ...walk };
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
				if (req.protectedIdentity !== undefined && isProtectedScan(full, st, req.protectedIdentity)) return;
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
					// WORKSPACE-RELATIVE, not absolute: `read_file` refuses an
					// absolute path, so an absolute hit here is a result the
					// model cannot feed back without rewriting it by hand.
					if (matches.length < req.maxMatches)
						matches.push(`${relative(req.workspaceRoot, full) || basename(full)}:${i + 1}: ${excerptAround(line, regex)}`);
				}
			}
		} catch {
			// unreadable file: skipped, like before
		}
	};
	// ACI-4/ACI-8: the corpus is declared by a `.gitignore` FILE at the
	// workspace root — not by `.git`, and the walk never goes up.
	const rootLayer = readLayer(req.root);
	const declared = rootLayer !== null;
	const walk = async (dir: string, depth: number, layers: readonly Layer[]): Promise<void> => {
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
		const here = depth === 0 ? layers : layersEntering(dir, layers);
		for (const entry of entries) {
			if (outOfBudget()) return;
			const full = join(dir, entry.name);
			const isDir = entry.isDirectory();
			if (corpusSkips(declared, here, full, entry.name, isDir)) continue;
			if (isDir) {
				if (isExcluded(full)) {
					excludedDirs += 1;
					continue;
				}
				await walk(full, depth + 1, here);
			} else if (entry.isFile()) await scanFile(full);
		}
	};
	try {
		if (req.single !== null) await scanFile(req.single);
		else await walk(req.root, 0, rootLayer === null ? [] : [rootLayer]);
	} catch (err) {
		return { token: req.token, matches, totalMatches, filesSeen, skippedFiles, multiLink, unreadableDirs, excludedDirs, stopped, stoppedAt, error: (err as Error).message };
	}
	return { token: req.token, matches, totalMatches, filesSeen, skippedFiles, multiLink, unreadableDirs, excludedDirs, stopped, stoppedAt };
}

if (!isMainThread && parentPort !== null) {
	parentPort.once("message", (req: SearchRequest | GlobRequest) => {
		if (req.kind === "glob") {
			try {
				parentPort!.postMessage(runGlob(req));
			} catch (err) {
				parentPort!.postMessage({ kind: "glob", token: req.token, files: [], cutByDepth: false, cutByCap: false, cutByVisits: false, cutByDeadline: false, visited: 0, error: (err as Error).message } satisfies GlobReply);
			}
			return;
		}
		void runSearch(req).then(
			(reply) => parentPort!.postMessage(reply),
			(err: unknown) => parentPort!.postMessage({ token: req.token, matches: [], totalMatches: 0, filesSeen: 0, skippedFiles: 0, multiLink: 0, unreadableDirs: 0, excludedDirs: 0, stopped: false, stoppedAt: 0, error: (err as Error).message } satisfies SearchReply),
		);
	});
}
