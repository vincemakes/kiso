/**
 * kiso coding tools — the reference toolset for Node hosts.
 *
 * Exactly-once discipline (ADR-0024): reads, listing, and search are
 * `idempotent` (safe to repeat); write, edit, and shell are NOT — the
 * kernel replays a confirmed success and blocks an interrupted attempt.
 * The CLI puts write/edit/shell behind the approval policy.
 *
 * Everything is relative to the process cwd; results are text (the model's
 * only medium). No shell flags the kernel doesn't need: `shell` carries an
 * explicit timeout and an output cap so a runaway command cannot flood the
 * context.
 *
 * the token round: reads are RANGEABLE (read_file offset/limit, default head 200
 * lines), search/list are capped (50 / 200), shell output is capped — every
 * truncation carries an actionable continuation note in the N of M form and
 * states what was dropped (deterministic per file state), so the model
 * always has a path to the full content.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
	chmodSync,
	existsSync,
	linkSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	appendFileSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";
// WR-1/WR-1A — the revision-guard primitives (unit-tested in wr1a-coda):
import { contentRevision, normalizeRevision, postEffectEscape, precondition, publishNewFile, revalidateBeforeRename } from "./wr1.js";

/**
 * TUI2-R1 (C) — THE SHELL PROGRESS SIDECAR.
 *
 * The tool contract returns output at completion; there is no
 * incremental channel, and the ① probe pinned that adding one would be
 * a core change this round may not make. So the shell tool ALSO writes
 * what it sees to a temp file, and the terminal — which is a different
 * process concern entirely — tails it. The trace-sidecar precedent
 * governs: an observation file never feeds correctness.
 *
 * Four properties make that claim true rather than hopeful:
 *
 *   1. THE FILE IS NOT DURABLE STATE. It lives in the OS temp dir, never
 *      under KISO_HOME. Recovery is computed from the event log; a file
 *      the session store has never heard of cannot reach it.
 *   2. IT IS REMOVED AT SETTLE — every settle: success, non-zero exit,
 *      timeout, abort. A kill -9 can leave one behind, which is why (3).
 *   3. IT IS TRUNCATED, NEVER APPENDED TO, AT THE START. A leftover from
 *      a killed run is cleared before the first chunk, so a ghost can
 *      never be read as this run's output.
 *   4. EVERY FILE OPERATION IS BEST-EFFORT. A full disk, a read-only
 *      temp dir, a racing remover — none may cost the command its
 *      result. A degraded sidecar costs the tail and nothing else.
 *
 * THE KEY IS DERIVED, not the executionId: finding ①c is that the
 * executionId is allocated kernel-side at the drain and is not reachable
 * from inside a tool. Both sides instead hold the two facts the key is
 * built from — the sessionId the contract already carries into execute,
 * and the command itself, which the terminal has verbatim in the running
 * cell's input.
 */
export const SHELL_PROGRESS_DIR = join(tmpdir(), "kiso-shell-progress");

/** The sidecar path for one shell call — the same path from either side,
 *  derived from facts both sides already have. A digest, so a command
 *  full of slashes and dots can never become a path. */
export function shellProgressPath(sessionId: string | undefined, command: string): string {
	const key = createHash("sha256").update(`${sessionId ?? ""} ${command}`).digest("hex").slice(0, 16);
	return join(SHELL_PROGRESS_DIR, `${key}.log`);
}

const OUTPUT_CAP = 100_000; // chars of output a tool result may carry
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
// the token round: the scoped-read defaults — read_file shows the head 200 lines
// of a large file (with an actionable continuation note, never a silent
// drop), search_text caps at 50 excerpts, list_dir at 200 entries. The
// red line: every truncation names its continuation — the model always
// has a path to the full content.
const DEFAULT_READ_LINES = 200;
/** R3: how many files a search may read before it hands the event loop
 *  back. Small enough that the 200ms motion cadence never misses a beat,
 *  large enough that the yield costs nothing on a small tree. */
const YIELD_EVERY = 64;

const MAX_SEARCH_MATCHES = 50;
const MAX_DIR_ENTRIES = 200;

/**
 * DC-54 — the bounds. The defect they close: `search_text` read every
 * file WHOLE and SYNCHRONOUSLY, so one 994 GB sparse disk image under a
 * workspace rooted at `~` stopped the event loop and never restarted it.
 *
 * Each constant answers a different unbounded thing, and all four are
 * needed — per-file bounds still leave 296,924 files to traverse under
 * `~`, and a call that traverses forever is a freeze whatever it does
 * per file. The tool must ALWAYS return.
 */
/** Skip a file larger than this. Not a PREFIX read: a partial match is a
 *  result that has to be explained, and a source file over 1 MiB is
 *  almost never what the model was looking for. */
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Stop the walk after this many files, whatever it has found. */
const SEARCH_MAX_FILES = 20_000;
/** Stop the walk after this long, whatever it has found. */
const SEARCH_MAX_MS = 10_000;
/** read_file refuses above this rather than freezing on it. The ceiling
 *  is a REFUSAL, not a truncation, because the `[rev:…]` token hashes
 *  the whole file: a revision issued over a prefix would never match the
 *  full-file hash write_file computes, and every later write would be
 *  refused as stale. No read, no revision, no lie. */
const READ_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How much of a file's head decides whether it is text. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Bytes as the refusal should say them: "128.0 MiB". */
function mib(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function cap(text: string): string {
	return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated]` : text;
}

/**
 * R-C item 2: chunked accumulation under the cap that COUNTS what it drops —
 * the shell overflow note names the dropped bytes and the recovery path
 * (the W10 continuation, made model-facing: what was dropped, how many).
 */
function capAccumulate(current: string, chunk: string): { text: string; dropped: number } {
	const room = OUTPUT_CAP - current.length;
	if (room >= chunk.length) return { text: current + chunk, dropped: 0 };
	return { text: room <= 0 ? current : current + chunk.slice(0, room), dropped: chunk.length - Math.max(room, 0) };
}

/**
 * A path that the workspace boundary refuses — never attempted, reported as
 * a precondition (the tool COULD run it, the gate refused it).
 */
export function escapeResult(reason: string): ToolResult {
	return { content: `[path denied] ${reason}`, isError: true, errorKind: "precondition" };
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve an input path strictly inside the workspace (Area 5):
 * - absolute inputs are refused (paths are workspace-relative);
 * - `..` components cannot escape because the joined path is re-checked
 *   against the canonical root;
 * - SYMLINKS cannot escape: the deepest existing ancestor is realpath'd
 *   and must stay inside the canonical root (this covers symlinked files,
 *   symlinked directories, and the parents of files to be created);
 * - returns the canonical absolute path, or throws PathEscapeError.
 */
export class PathEscapeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathEscapeError";
	}
}

export function resolveWithinRoot(root: string, input: string): string {
	if (isAbsolute(input)) {
		throw new PathEscapeError(`absolute paths are not allowed — use workspace-relative paths: ${input}`);
	}
	const rootReal = realpathSync(root);
	const candidate = resolve(root, input);

	// Walk up to the deepest EXISTING ancestor (files to be created have a
	// not-yet-existing tail), then canonicalize it.
	let ancestor = candidate;
	const missingTail: string[] = [];
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		missingTail.unshift(basename(ancestor));
		ancestor = parent;
	}
	const ancestorReal = realpathSync(ancestor);
	if (!isWithin(rootReal, ancestorReal)) {
		throw new PathEscapeError(`path escapes the workspace (${input})`);
	}
	const canonical = missingTail.length > 0 ? join(ancestorReal, ...missingTail) : ancestorReal;
	if (!isWithin(rootReal, canonical)) {
		throw new PathEscapeError(`path escapes the workspace (${input})`);
	}
	return canonical;
}

/**
 * round 10: the canonical path a tool will actually touch, as an ABSOLUTE path.
 * Symlinks in the deepest EXISTING ancestor are resolved — a file to be
 * created under a symlinked directory lands in the TARGET, not in the
 * link — and the not-yet-existing tail is re-appended. Shared by the
 * tools (which then re-verify the workspace boundary) and the CLI
 * approval UI, so the human and the tool see THE SAME path.
 */
export function canonicalTargetPath(input: string): string {
	const candidate = resolve(input);
	let ancestor = candidate;
	const missingTail: string[] = [];
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		missingTail.unshift(basename(ancestor));
		ancestor = parent;
	}
	let ancestorReal: string;
	try {
		ancestorReal = realpathSync(ancestor);
	} catch {
		return candidate; // unresolvable — show the plain resolved path
	}
	return missingTail.length > 0 ? join(ancestorReal, ...missingTail) : ancestorReal;
}

export interface WorkspaceToolsOptions {
	/** The workspace the tools may touch; everything else is refused. */
	readonly workspaceRoot: string;
	/**
	 * bootstrap #3 (finding #7): "inherit" keeps kiso's own provider credentials in
	 * the shell child's environment. DEFAULT (absent): the credentials are
	 * STRIPPED — a shell command must not inherit the agent's API keys (a
	 * nested kiso would hit the REAL provider and blow up faux e2e runs;
	 * the keys are an exposure surface for any command).
	 */
	readonly shellEnv?: "inherit";
	/**
	 * DC-54 — the bounds that keep a tool call finite. Every field is
	 * optional and defaults to the constant beside it; a host embedding
	 * kiso over an unusually large or unusually small tree can move them,
	 * and the gate can set them low enough to observe the stop.
	 */
	readonly limits?: {
		/** search_text: skip a file larger than this (default 1 MiB). */
		readonly searchMaxFileBytes?: number;
		/** search_text: stop the walk after this many files (default 20,000). */
		readonly searchMaxFiles?: number;
		/** search_text: stop the walk after this long (default 10s). */
		readonly searchMaxMs?: number;
		/** read_file: refuse a file larger than this (default 64 MiB). */
		readonly readMaxFileBytes?: number;
	};
}

/**
 * The inode-boundary policy for READS (round 8): a hard link inside the workspace
 * may point at an inode whose OTHER links live outside (e.g. /etc/passwd) —
 * reading it would silently exfiltrate external content. Policy:
 *   - regular, single-link files: read;
 *   - multi-link files whose EVERY link is inside the workspace: read;
 *   - multi-link files with ANY link outside the workspace: refused
 *     (fail-closed when the link count cannot be verified);
 *   - non-regular files (sockets, devices, fifos): refused.
 * Returns a denial reason, or null when the file is safe to read.
 */
/** DC-52 — the guard's verdict, per (dev, ino), for this process. The
 *  scan is the expensive thing; the answer is a fact about an inode and
 *  does not change under us within a call. */
const inodeVerdict = new Map<string, string | null>();

/**
 * DC-52 — BOUNDED, ASYNCHRONOUS, AND SILENT.
 *
 * This was `execFileSync("find", [root, "-xdev", "-inum", …])` with no
 * `stdio`, run once per multi-link file. Three faults in one line:
 *
 *   1. no `stdio` gives the child the PARENT'S stderr, which is the
 *      terminal — `find: …: Operation not permitted` went straight past
 *      the compositor's frame and over the composer;
 *   2. the scan is unbounded, and SYNCHRONOUS: with the workspace root
 *      at `~` a single call is tens of seconds with the event loop
 *      frozen, so `esc` does nothing and the whole product looks hung;
 *   3. it ran for `search_text` too, which returns a 160-character
 *      excerpt — a disk traversal to decide whether a line may be
 *      quoted is not a trade anyone would make.
 *
 * Now: `execFile` with a 2s budget, stderr discarded, verdict cached.
 * A scan that does not finish inside the budget is fail-closed exactly
 * as an unverifiable one always was — refused, never hung. Fault 3 is
 * answered by `search_text` not calling this at all.
 */
async function inodeReadPolicy(root: string, full: string): Promise<string | null> {
	const st = statSync(full);
	if (!st.isFile()) return `not a regular file — refusing to read (${full})`;
	if (st.nlink <= 1) return null;
	const key = `${st.dev}:${st.ino}`;
	const cached = inodeVerdict.get(key);
	if (cached !== undefined) return cached;
	// round 4: the link count is verified STRUCTURALLY, never by counting
	// newline-split text. `find -print0` emits NUL-separated paths — a file
	// named "inside\nspoof" is ONE path, not two — and every match is then
	// re-statted and checked for the EXACT dev+ino pair (an inode number
	// alone is not identity across devices). Any failure to verify every
	// link is fail-closed: the file is refused.
	// round 5(P2-3): the workspace root is CANONICALIZED before the scan —
	// find on a symlinked root would not follow the symlink into the real
	// tree, undercounting the in-workspace links and misjudging a legal
	// hard link as an external escape.
	let inside = 0;
	try {
		const rootReal = realpathSync(root);
		const { stdout: out } = await promisify(execFile)(
			"find",
			[rootReal, "-xdev", "-inum", String(st.ino), "-print0"],
			// DC-52: the child never outlives the budget, and its stderr
			// never reaches the terminal. The second is the ASYNC form's
			// own doing and is the whole reason to prefer it here:
			// `execFileSync` without an explicit `stdio` gives the child
			// the PARENT'S stderr, which is how `find: … Operation not
			// permitted` got over the composer. `execFile` pipes both
			// streams into the callback; there is nowhere for it to go.
			{ encoding: "utf8", maxBuffer: 1 << 20, timeout: INODE_SCAN_MS },
		);
		for (const path of out.split("\0")) {
			if (path === "") continue;
			try {
				const match = statSync(path);
				if (match.dev === st.dev && match.ino === st.ino) inside += 1;
			} catch {
				inside = -1; // an unverifiable match — fail closed
				break;
			}
		}
	} catch {
		inside = -1; // cannot verify — refuse (fail-closed)
	}
	const verdict =
		inside < 0 || inside < st.nlink
			? `file has hard links outside the workspace (${inside < 0 ? "unverifiable" : `${inside}/${st.nlink}`} inside) — refusing to read (${full})`
			: null;
	inodeVerdict.set(key, verdict);
	return verdict;
}

/** DC-52 — the guard's budget. A scan that outruns it is fail-closed,
 *  which is what an unverifiable scan has always been. */
const INODE_SCAN_MS = 2_000;

/** The "… N more lines" note — the actionable continuation: the exact
 *  line the next read must start at, so the model can always reach the
 *  full content in ranges (the red line). */
function moreLinesNote(nextOffset: number, remaining: number): string {
	return `\n… ${remaining} more ${remaining === 1 ? "line" : "lines"} (call again with offset=${nextOffset})`;
}

export function readFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string; offset?: number; limit?: number }> {
	return defineTool<{ path: string; offset?: number; limit?: number }>({
		name: "read_file",
		description:
			"Read a workspace file or a range (offset/limit; default: the first 200 lines, with a continuation note). The final [rev:X] line identifies the version read.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path of the file to read" },
				offset: { type: "number", description: "1-based first line to read (default: 1)" },
				limit: { type: "number", description: "Maximum number of lines to read (default: to the end of the file)" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		idempotent: true,
		// EC-1 ②: read_file is read-only, free, and local for EVERY
		// invocation — the three conditions `precommitSafe` certifies — so it
		// may start before Turn Commit when its authorization is already
		// satisfied, and it may overlap its siblings. Neither claim is a
		// safety claim: the kernel enforces both, and had this line been
		// omitted the tool would simply have been slower, never less correct.
		effects: { precommitSafe: true, concurrency: "shared" },
		promptSnippet: "read_file — whole files or offset/limit ranges, workspace-relative paths",
		promptGuidelines: ["read only the range you need — offset/limit beat whole-file reads"],
		execute: async ({ path, offset, limit }) => {
			const maxReadBytes = opts.limits?.readMaxFileBytes ?? READ_MAX_FILE_BYTES;
			try {
				const full = resolveWithinRoot(opts.workspaceRoot, path);
				const denied = await inodeReadPolicy(opts.workspaceRoot, full);
				if (denied !== null) return escapeResult(denied);
				// DC-54 — the ceiling. `read_file` had the same unbounded
				// `readFileSync` that froze `search_text`, and the same 994 GB
				// `Docker.raw` would have frozen it identically.
				//
				// It REFUSES rather than truncating, because the `[rev:…]`
				// token this tool issues hashes the whole file: a revision
				// computed over a prefix would never equal the full-file hash
				// `write_file` computes, so every later write would be refused
				// as stale. A bounded read here would buy a freeze-free read
				// at the price of a write path that silently stops working.
				const size = statSync(full).size;
				if (size > maxReadBytes) {
					return precondition(
						`read_file: ${path} is ${mib(size)} — too large to read (ceiling ${mib(maxReadBytes)}); use shell with sed/head to take a range`,
					);
				}
				// WR-1: hash the raw bytes BEFORE decoding — the revision is a
				// fact about the world, not about UTF-8 replacement semantics.
				//
				// DC-54, and this read stays SYNCHRONOUS on purpose. The
				// ruling said to make it async; the first build did, and
				// `tui2-r1-visibility` went red on an invariant worth more
				// than the microseconds: the durable log of three concurrent
				// `read_file` calls stopped being deterministic, because
				// completion order became the libuv threadpool's to decide.
				// That test compares a PTY session's log to a pipe session's
				// to prove the rollup is display-side only, and it cannot do
				// that job over a log that varies run to run.
				//
				// The freeze came from UNBOUNDED work, not from synchronous
				// work. With the ceiling above, the worst case here is a
				// 64 MiB read — about 100 ms, measured — against the 180+
				// seconds this finding is named for. Determinism is worth
				// more than that hitch.
				const bytes = readFileSync(full);
				const content = bytes.toString("utf8");
				// The lines the file DISPLAYS: a trailing newline's empty split
				// element is not a line. Line k = split[k-1], 1-based.
				const parts = content.split("\n");
				const total = content.endsWith("\n") ? parts.length - 1 : parts.length;
				const badCount = (v: unknown, name: string): string | undefined =>
					typeof v !== "number" || !Number.isInteger(v) || v < 1
						? `read_file: ${name} must be a positive integer (got ${JSON.stringify(v)})`
						: undefined;
				if (offset !== undefined) {
					const bad = badCount(offset, "offset");
					if (bad !== undefined) return { content: bad, isError: true, errorKind: "invalid_input" };
				}
				if (limit !== undefined) {
					const bad = badCount(limit, "limit");
					if (bad !== undefined) return { content: bad, isError: true, errorKind: "invalid_input" };
				}
				const start = offset ?? 1;
				if (start > total) {
					return {
						content: `read_file: offset=${start} is past the end of ${path} (${total} lines)`,
						isError: true,
						errorKind: "invalid_input",
					};
				}
				const end = limit === undefined ? total : Math.min(start + limit - 1, total);
				// DEFAULT: the head 200 lines; a larger file ends with the
				// honest continuation note (small files ≤ 200 lines are
				// byte-identical to the pre-token-round behavior).
				let text: string;
				let note = "";
				if (offset === undefined && limit === undefined) {
					text = total <= DEFAULT_READ_LINES ? content : parts.slice(0, DEFAULT_READ_LINES).join("\n");
					if (total > DEFAULT_READ_LINES) note = moreLinesNote(DEFAULT_READ_LINES + 1, total - DEFAULT_READ_LINES);
				} else {
					text = parts.slice(start - 1, end).join("\n");
					if (end < total) note = moreLinesNote(end + 1, total - end);
				}
				// The output cap's cut must STAY actionable: cut at a line
				// boundary and name the exact next offset (the generic cap()
				// would leave the model blind mid-file).
				if (text.length > OUTPUT_CAP) {
					const cut = text.lastIndexOf("\n", OUTPUT_CAP);
					if (cut > 0) {
						text = text.slice(0, cut);
						note = `\n… [output capped at ${OUTPUT_CAP} chars — continue with offset=${start + text.split("\n").length}]` + note;
					} else {
						// The first 100000 chars are one line (or a blank line
						// then one): offset ranges cannot split it — shell is
						// the only honest path.
						text = text.slice(0, OUTPUT_CAP);
						note = `\n… [a line near ${path}:${start} exceeds the ${OUTPUT_CAP}-char cap — slice it with shell]` + note;
					}
				}
				// WR-1: the revision trailer is ALWAYS the last line — after
				// every truncation/continuation note, predictable to cite. A
				// ranged read still cites the WHOLE file's revision: the guard
				// answers "did the world change since you looked", never "did
				// you look at everything".
				return { content: `${text}${note}\n[${contentRevision(bytes)}]`, isError: false };
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				return { content: `read_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function listDirTool(opts: WorkspaceToolsOptions): Tool<{ path?: string }> {
	return defineTool<{ path?: string }>({
		name: "list_dir",
		description:
			"List the entries of a directory. Omit path to list the workspace root. Capped at 200 entries with an overflow note (narrow to a subdirectory for more).",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative directory to list" } },
			additionalProperties: false,
		},
		idempotent: true,
		// EC-1 ②: read-only, free, local — see read_file above.
		effects: { precommitSafe: true, concurrency: "shared" },
		promptSnippet: "list_dir — directory entries (the workspace ls)",
		promptGuidelines: ["narrow to a subdirectory when the listing caps at 200 entries"],
		execute: async ({ path }) => {
			try {
				const dir = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
				// DC-54 — TRUNCATED BEFORE IT BUILDS. It was a `.map` over
				// EVERY entry with the 200-entry slice only after: a directory
				// of 200,000 entries built 200,000 strings to show 200 of
				// them. Milder than the `search_text` freeze and the same
				// mistake — unbounded work before the bound.
				//
				// `readdirSync`, still: same reason as read_file above. The
				// listing is one syscall whose cost is the directory's size,
				// which no bound of ours can shrink, and making it async buys
				// nothing while costing the durable log its determinism.
				const dirents = readdirSync(dir, { withFileTypes: true });
				const entries = dirents.slice(0, MAX_DIR_ENTRIES).map((e) => {
					const isDir = e.isDirectory();
					return `${isDir ? "dir " : "file"} ${e.name}${isDir ? "/" : ""}`;
				});
				let content = entries.length ? cap(entries.join("\n")) : "(empty directory)";
				if (dirents.length > MAX_DIR_ENTRIES) {
					// R-C item 2: the N of M form — the cap names its
					// continuation (narrow to a subdirectory for more).
					content += `\n… ${MAX_DIR_ENTRIES} of ${dirents.length} entries shown (narrow to a subdirectory for more)`;
				}
				return { content, isError: false };
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				return { content: `list_dir failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function searchTextTool(opts: WorkspaceToolsOptions): Tool<{ pattern: string; path?: string; caseSensitive?: boolean }> {
	return defineTool<{ pattern: string; path?: string; caseSensitive?: boolean }>({
		name: "search_text",
		description:
			"Search files under a workspace directory (recursive), or a single file, for a regular expression (the workspace grep — prefer it over shell grep/rg). Returns matching file:line excerpts, capped at 50 — an overflow note states the count of further matches (narrow the pattern to see them). Case-insensitive unless caseSensitive is true.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to search for" },
				path: { type: "string", description: "Workspace-relative directory OR file (default: workspace root)" },
				caseSensitive: { type: "boolean", description: "Match case exactly (default: false)" },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		idempotent: true,
		// EC-1 ②: read-only, free, local — see read_file above. write_file,
		// edit_file and shell deliberately declare NOTHING: they are
		// commit-required and exclusive, which is what closes the same-path
		// write race without asking their authors to remember anything.
		effects: { precommitSafe: true, concurrency: "shared" },
		promptSnippet: "search_text — regex search over workspace files",
		promptGuidelines: ["narrow the pattern when the result caps — never re-run a broad search"],
		execute: async ({ pattern, path, caseSensitive }) => {
			let root: string;
			try {
				root = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			// DC-23 (the 0.16.7 dogfood): an INVALID pattern threw raw out
			// of execute — `new RegExp` sat outside every try in this
			// function, so a bad regex was a crash rather than a result the
			// model could act on. And the "i" flag was hardcoded, so a
			// case-sensitive search was not expressible at all.
			let regex: RegExp;
			try {
				regex = new RegExp(pattern, caseSensitive === true ? "" : "i");
			} catch (err) {
				return { content: `search_text failed: invalid pattern — ${(err as Error).message}`, isError: true, errorKind: "invalid_input" };
			}
			// DC-23: a FILE is a place text lives. The tool took only a
			// directory and answered a file path with libuv's own words
			// ("ENOTDIR: not a directory, scandir <path>"), which is the
			// obvious thing to ask for — the file is already known and the
			// question is where in it something is. The real dogfood model
			// asked twice and learned nothing either time. One stat.
			let single: string | null = null;
			try {
				if (statSync(root).isFile()) single = root;
			} catch (err) {
				return { content: `search_text failed: ${path ?? "."} — ${(err as Error).message}`, isError: true, errorKind: "invalid_input" };
			}
			// The walk NEVER early-aborts on the cap: the overflow note's count
			// must be the file-true total, not a bound (the red line). The
			// depth cap and the node_modules/dotfile skip stay.
			const matches: string[] = [];
			let totalMatches = 0;
			// DC-52 — what the search did NOT look at, so the note can say so.
			let multiLink = 0;
			let unreadableDirs = 0;
			// DC-54 — the same discipline for the two new refusals, and for
			// the call budget: a silent skip is a result the model cannot
			// tell is incomplete.
			let skippedFiles = 0;
			let filesSeen = 0;
			// An explicit flag, NOT `stoppedAt > 0`: a wall-clock budget can
			// expire before the first file is scanned, and a zero-valued
			// sentinel would then read as "never stopped" — the walk would
			// still end, but silently, which is the one thing every note in
			// this function exists to prevent.
			let stopped = false;
			let stoppedAt = 0;
			const maxFileBytes = opts.limits?.searchMaxFileBytes ?? SEARCH_MAX_FILE_BYTES;
			const maxFiles = opts.limits?.searchMaxFiles ?? SEARCH_MAX_FILES;
			const deadline = Date.now() + (opts.limits?.searchMaxMs ?? SEARCH_MAX_MS);
			/** DC-54 ④ — the CALL budget. Per-file bounds are not enough:
			 *  under `~` the walk still reaches 296,924 files, and 10 seconds
			 *  of traversal with nothing on screen is the same freeze from
			 *  the outside. Whichever bound trips first stops the walk, and
			 *  the note names the continuation. */
			const outOfBudget = (): boolean => {
				if (stopped) return true;
				if (filesSeen >= maxFiles || Date.now() > deadline) {
					stopped = true;
					stoppedAt = filesSeen;
					return true;
				}
				return false;
			};
			// R3 — the walk YIELDS. It was `readdirSync` + `readFileSync` all
			// the way down inside an `async` body, which is the shape that
			// blocks Node's event loop for the whole traversal: measured at
			// 18.4 seconds over a home directory, during which no timer
			// fires, no frame paints and the `working` mark freezes solid.
			// A user reasonably reads a frozen liveness mark as a crash.
			//
			// The fix is not "make it faster" — a big tree is legitimately
			// slow. It is to stop OWNING the loop: `fs.promises.readdir`,
			// and a yield every YIELD_EVERY files.
			//
			// DC-54 corrects what this comment used to claim next — that
			// the yield also stopped "a long read stretch" monopolising the
			// loop. It never did and could not: `breathe()` runs BETWEEN
			// files, and nothing preempts a single synchronous read once
			// entered. R3 bounded the traversal; the FILE stayed unbounded
			// until DC-54 ①–③ above, and one 994 GB image was enough to
			// stop the process dead with this yield fully in place.
			let sinceYield = 0;
			const breathe = async (): Promise<void> => {
				sinceYield += 1;
				if (sinceYield < YIELD_EVERY) return;
				sinceYield = 0;
				await new Promise<void>((r) => setImmediate(r));
			};
			// DC-23: the per-file scan is its own function now, because the
			// single-file path and the walk must scan a file the SAME way —
			// same inode boundary, same cap accounting, same excerpt shape.
			// Two copies would be two answers to "what does searching this
			// file mean".
			const scanFile = async (full: string): Promise<void> => {
				if (outOfBudget()) return;
				filesSeen += 1;
				await breathe();
				try {
					// DC-52 — SEARCH DOES NOT RUN THE INODE GUARD.
					//
					// Round 8 gave search the same inode boundary read_file
					// has, and the boundary is right; what was wrong is the
					// price. The guard's verification is a `find` over the
					// whole workspace root, once per multi-link file — with
					// the root at `~` that is tens of seconds each, and it
					// ran on the owner's machine for eight minutes without
					// finishing. A search returns a 160-character excerpt of
					// a line. No excerpt is worth a disk traversal.
					//
					// So a multi-link file is SKIPPED, and counted, and the
					// count is said. That is fail-closed at zero cost: the
					// external-link case the guard exists for is refused
					// exactly as before, and the legal case is refused too,
					// which is a loss of coverage rather than of safety.
					// read_file keeps the guard (bounded, above), and that
					// is where the file's contents can actually be had.
					const st = statSync(full);
					if (st.nlink > 1) {
						multiLink += 1;
						return;
					}
					// DC-54 ① — SIZE, decided before anything is opened.
					//
					// This is the line that was missing when a workspace
					// rooted at `~` met `Docker.raw`: 994 GB went into
					// `readFileSync(full, "utf8")` and the process never came
					// back. Measured on the owner's machine, without it: a
					// 467 MB `.mov` read SUCCESSFULLY, 3,817 ms of dead loop
					// and 2.06 GB of RSS, split into 1,823,112 "lines".
					if (st.size > maxFileBytes) {
						skippedFiles += 1;
						return;
					}
					// DC-54 ② — BINARY, decided from the head alone.
					//
					// One open serves both the sniff and the read. The sniff
					// passes an explicit position, which by contract leaves
					// the handle's own position at 0, so `readFile()` below
					// still sees the whole file.
					const fh = await open(full, "r");
					let text: string;
					try {
						const headLen = Math.min(BINARY_SNIFF_BYTES, st.size);
						const head = Buffer.alloc(headLen);
						if (headLen > 0) {
							// An explicit `position` leaves the handle's own
							// position at 0, so the whole-file read below still
							// starts at byte 0. The gate proves it with a
							// needle placed PAST the sniff window: were the
							// position to advance, every line number in this
							// file's matches would be silently wrong.
							await fh.read(head, 0, headLen, 0);
							if (head.includes(0)) {
								skippedFiles += 1;
								return;
							}
						}
						// DC-54 ③ — the read is ASYNCHRONOUS. R3 made the walk
						// yield and its comment claimed that stopped a long
						// read owning the loop; it never could. `breathe()`
						// runs BETWEEN files, and nothing preempts a
						// `readFileSync` once entered. Bounded above by ①, so
						// this is at most a 1 MiB read that shares the loop.
						//
						// A file that fits inside the sniff window is already
						// entirely in `head`: reading it a second time would
						// double the syscalls for the commonest small file.
						text = (st.size <= headLen ? head : await fh.readFile()).toString("utf8");
					} finally {
						await fh.close();
					}
					for (const [i, line] of text.split("\n").entries()) {
						if (regex.test(line)) {
							totalMatches += 1;
							if (matches.length < MAX_SEARCH_MATCHES) {
								matches.push(`${full}:${i + 1}: ${line.trim().slice(0, 160)}`);
							}
						}
					}
				} catch {
					// unreadable file — skip
				}
			};
			const walk = async (dir: string, depth: number): Promise<void> => {
				if (depth > 8 || outOfBudget()) return;
				// DC-52 — a directory the OS REFUSES is skipped, not fatal.
				//
				// An unreadable FILE has always been skipped (the catch in
				// scanFile); an unreadable DIRECTORY threw out of the walk
				// and failed the whole tool. On macOS that is not an edge
				// case — `~/Library/Accounts` and its neighbours are TCC
				// protected, so a search anywhere under `~` died on one of
				// them. The asymmetry was the defect: same fact, same
				// remedy.
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
					if (entry.isDirectory()) await walk(full, depth + 1);
					else if (entry.isFile()) await scanFile(full);
				}
			};
			try {
				if (single !== null) await scanFile(single);
				else await walk(root, 0);
			} catch (err) {
				return { content: `search_text failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
			let content = matches.length ? cap(matches.join("\n")) : "(no matches)";
			// DC-52: what was NOT searched is said. A silent skip is a
			// result the model cannot tell is incomplete.
			if (multiLink > 0) content += `\n… ${multiLink} multi-link ${multiLink === 1 ? "file" : "files"} skipped (read_file verifies them individually)`;
			if (unreadableDirs > 0) content += `\n… ${unreadableDirs} unreadable ${unreadableDirs === 1 ? "directory" : "directories"} skipped`;
			// DC-54 — one merged sentence, and only when it happened. A note
			// that always fires says nothing.
			if (skippedFiles > 0 || stopped) {
				const parts: string[] = [];
				if (skippedFiles > 0) parts.push(`${skippedFiles} ${skippedFiles === 1 ? "file" : "files"} skipped (large or binary)`);
				if (stopped) parts.push(`stopped after ${stoppedAt} ${stoppedAt === 1 ? "file" : "files"} — narrow the path`);
				content += `\n… ${parts.join(" · ")}`;
			}
			if (totalMatches > matches.length) {
				// R-C item 2: the N of M form — the cap names its
				// continuation (narrow the pattern for more).
				content += `\n… ${matches.length} of ${totalMatches} matches shown (narrow the pattern for more)`;
			}
			return { content, isError: false };
		},
	});
}

export function writeFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string; content: string; expectedRevision?: string }> {
	return defineTool<{ path: string; content: string; expectedRevision?: string }>({
		name: "write_file",
		description:
			"Create or replace a whole workspace file. expectedRevision is the file's latest revision token, or \"absent\" to create a new file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file to write" },
				content: { type: "string", description: "Full new content" },
				expectedRevision: {
					type: "string",
					description: 'The latest revision token, or "absent" to create',
				},
			},
			required: ["path", "content", "expectedRevision"],
			additionalProperties: false,
		},
		promptSnippet: "write_file — create or replace a whole file",
		promptGuidelines: ["write/edit: cite the file's latest revision as expectedRevision; each successful mutation returns the next one; use \"absent\" only to create"],
		execute: async ({ path, content, expectedRevision: citedRevision }) => {
			const maxReadBytes = opts.limits?.readMaxFileBytes ?? READ_MAX_FILE_BYTES;
			// WR-1-F2: normalize every plausible copy of the token FIRST —
			// tolerance in the reader, strictness in the comparison.
			const expectedRevision = citedRevision === undefined ? undefined : normalizeRevision(citedRevision);
			let full: string;
			try {
				full = resolveWithinRoot(opts.workspaceRoot, path);
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			// WR-1 — the observed-revision stale-write guard. The decision
			// lattice runs BEFORE any bytes move; every refusal is a
			// precondition with one actionable sentence. What it proves:
			// mutation is refused when the revision at validation time
			// differs from the one the agent observed. What it does NOT
			// prove: a non-cooperating writer can still race the final
			// validation→replacement window (no portable atomic CAS over
			// rename exists) — the claim is narrowed on purpose.
			const exists = existsSync(full);
			if (expectedRevision === undefined) {
				if (exists) {
					return precondition(`write_file: ${path} already exists — read it and pass expectedRevision from the read`);
				}
			} else if (expectedRevision === "absent") {
				if (exists) {
					return precondition(`write_file: ${path} already exists — read it and pass its revision to replace it`);
				}
			} else {
				if (!exists) {
					return precondition(`write_file: ${path} no longer exists — pass expectedRevision:"absent" to create it`);
				}
				// DC-54 owed (R14) — the ceiling, before the read.
				//
				// `read_file` got this bound in 0.24.5; these two did not,
				// and they read the WHOLE file to compute a revision BEFORE
				// the comparison that would reject the call — so the freeze
				// happened on the way to the refusal rather than instead of
				// it. Same ceiling, same precondition shape, same reason: a
				// revision over a prefix could never match, so there is
				// nothing to compute and nothing to compare.
				const wSize = statSync(full).size;
				if (wSize > maxReadBytes) {
					return precondition(
						`write_file: ${path} is ${mib(wSize)} — too large to read (ceiling ${mib(maxReadBytes)}); use shell with sed/head to take a range`,
					);
				}
				const current = contentRevision(readFileSync(full));
				if (current !== expectedRevision) {
					return precondition(`write_file: ${path} changed since ${expectedRevision} — read it again and cite its [rev:…] line, then re-apply the change`);
				}
			}
			const tmp = `${full}.kiso-tmp-${process.pid}-${crypto.randomUUID()}`;
			let preservedMode: number | undefined;
			try {
				// E group: SAFE REPLACEMENT — write a temp file next to the
				// target and rename it over the directory entry. A hard link
				// inside the workspace that shares an EXTERNAL inode is
				// therefore never overwritten: rename replaces the entry,
				// not the shared inode.
				// round 8: an existing file keeps its mode — a 0755 script stays
				// 0755 after replacement (rename drops the temp's default
				// mode, so it is copied onto the temp first).
				if (exists) preservedMode = statSync(full).mode & 0o7777;
				writeFileSync(tmp, content, "utf8");
				if (preservedMode !== undefined) chmodSync(tmp, preservedMode);
				if (!exists) {
					// WR-1A ②: link(2) or refusal — atomic no-clobber, fail
					// closed. No rename fallback: "absent" is a contract.
					const refused = publishNewFile(tmp, full, path);
					if (refused !== null) return refused;
				} else {
					// WR-1A ③: the world must STILL match the citation right
					// before the replacement commits (the staging took time).
					const stale = revalidateBeforeRename(full, expectedRevision as string, "write_file", path);
					if (stale !== null) {
						unlinkSync(tmp);
						return stale;
					}
					renameSync(tmp, full);
				}
				// Post-write re-check (review finding 8): if a concurrent
				// swap turned the verified path into a symlink mid-write,
				// the write landed outside the workspace — say so instead of
				// claiming success. (The write itself cannot be undone.)
				const written = realpathSync(full);
				if (!isWithin(realpathSync(opts.workspaceRoot), written)) {
					// WR-1A ①: the rename HAPPENED — this is a post-effect
					// verification failure, fatal, never a precondition.
					return postEffectEscape("write", path);
				}
				// WR-1: the result returns the NEW revision — the model just
				// authored these bytes; a legal new world witness for chained
				// edits without a wasted re-read.
				return { content: `wrote ${path} (${content.length} chars)\n[${contentRevision(Buffer.from(content, "utf8"))}]`, isError: false };
			} catch (err) {
				// round 8: a failed write never leaves a temp file with the FULL
				// content behind — it is unlinked in every failure path.
				try {
					unlinkSync(tmp);
				} catch {
					// already renamed or never created
				}
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				return { content: `write_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function editFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string; search?: string; replace?: string; edits?: readonly { search: string; replace: string }[]; expectedRevision?: string }> {
	return defineTool<{ path: string; search?: string; replace?: string; edits?: readonly { search: string; replace: string }[]; expectedRevision?: string }>({
		name: "edit_file",
		description:
			"Edit a workspace file at its latest revision (expectedRevision). ONE of: search+replace (first exact occurrence), or edits (1-32 disjoint hunks resolved against the same snapshot, applied atomically).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file" },
				search: { type: "string", description: "Exact literal text to find (single-hunk form)" },
				replace: { type: "string", description: "Replacement text (single-hunk form)" },
				edits: {
					type: "array",
					description: "Batch form: 1-32 {search, replace} hunks, every search resolved against the SAME snapshot",
					items: {
						type: "object",
						properties: { search: { type: "string" }, replace: { type: "string" } },
						required: ["search", "replace"],
						additionalProperties: false,
					},
					minItems: 1,
					maxItems: 32,
				},
				expectedRevision: { type: "string", description: "The file's latest revision token" },
			},
			required: ["path", "expectedRevision"],
			additionalProperties: false,
		},
		promptSnippet: "edit_file — replace an exact old_string block (never rewrite whole files)",
		promptGuidelines: ["write/edit: cite the file's latest revision as expectedRevision; each successful mutation returns the next one; use \"absent\" only to create"],
		execute: async ({ path, search, replace, edits, expectedRevision: citedRevision }) => {
			const maxReadBytes = opts.limits?.readMaxFileBytes ?? READ_MAX_FILE_BYTES;
			// WR-1-F2: normalize the citation (see write_file).
			const expectedRevision = citedRevision === undefined ? undefined : normalizeRevision(citedRevision);
			// WR-1E2 — the form XOR (the draft-07 subset has no oneOf; the
			// SHAPE rule is enforced here): legacy single-hunk XOR batch.
			const single = search !== undefined || replace !== undefined;
			if (single && edits !== undefined) {
				return { content: "edit_file: pass EITHER search+replace OR edits — never both", isError: true, errorKind: "invalid_input" };
			}
			if (!single && edits === undefined) {
				return { content: "edit_file: pass search+replace, or edits (1\u201332 hunks)", isError: true, errorKind: "invalid_input" };
			}
			if (single && (search === undefined || replace === undefined)) {
				return { content: "edit_file: the single-hunk form needs BOTH search and replace", isError: true, errorKind: "invalid_input" };
			}
			if (edits !== undefined && (edits.length === 0 || edits.length > 32)) {
				return { content: `edit_file: edits must carry 1\u201332 hunks (got ${edits.length})`, isError: true, errorKind: "invalid_input" };
			}
			const hunks: readonly { search: string; replace: string }[] = edits ?? [{ search: search!, replace: replace! }];
			let full: string;
			try {
				full = resolveWithinRoot(opts.workspaceRoot, path);
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			// WR-1: edits always target an existing file — the revision is
			// not optional here, and the refusal teaches the protocol.
			if (expectedRevision === undefined) {
				return precondition(`edit_file: ${path} — pass expectedRevision from your last read (its final [rev:…] line)`);
			}
			if (expectedRevision === "absent") {
				return precondition(`edit_file cannot create files — use write_file with expectedRevision:"absent"`);
			}
			const tmp = `${full}.kiso-tmp-${process.pid}-${crypto.randomUUID()}`;
			let preservedMode: number | undefined;
			try {
				if (!existsSync(full)) {
					return precondition(`edit_file: ${path} no longer exists — it was deleted since you read it`);
				}
				// WR-1: ONE byte snapshot feeds BOTH the validation and the
				// mutation — no internal window between what was checked and
				// what was edited (the external validation→replacement window
				// remains and is the narrowed claim). Staleness reports BEFORE
				// the pattern search: the truer cause first.
				// DC-54 owed (R14) — the ceiling, before the read.
				//
				// `read_file` got this bound in 0.24.5; these two did not,
				// and they read the WHOLE file to compute a revision BEFORE
				// the comparison that would reject the call — so the freeze
				// happened on the way to the refusal rather than instead of
				// it. Same ceiling, same precondition shape, same reason: a
				// revision over a prefix could never match, so there is
				// nothing to compute and nothing to compare.
				const eSize = statSync(full).size;
				if (eSize > maxReadBytes) {
					return precondition(
						`edit_file: ${path} is ${mib(eSize)} — too large to read (ceiling ${mib(maxReadBytes)}); use shell with sed/head to take a range`,
					);
				}
				const bytes = readFileSync(full);
				const current = contentRevision(bytes);
				if (current !== expectedRevision) {
					return precondition(`edit_file: ${path} changed since ${expectedRevision} — read it again and cite its [rev:…] line, then re-apply the change`);
				}
				const text = bytes.toString("utf8");
				// WR-1E2: EVERY hunk resolves against THIS snapshot — never the
				// output of an earlier hunk. All spans are known before any
				// staging; overlaps refuse (duplicate searches both resolve
				// first-occurrence and therefore overlap — never retargeted).
				const spans: { start: number; end: number; replace: string }[] = [];
				for (let i = 0; i < hunks.length; i += 1) {
					const h = hunks[i]!;
					const at = text.indexOf(h.search);
					if (at === -1) {
						// WR-1A ④: the WORLD lacks the pattern (the input is
						// fine) and nothing ran — precondition; the note never
						// rides an edit that wrote nothing.
						return precondition(hunks.length === 1 && edits === undefined ? `edit_file: pattern not found in ${path}` : `edit_file: pattern not found in ${path} (hunk ${i + 1})`);
					}
					spans.push({ start: at, end: at + h.search.length, replace: h.replace });
				}
				const bySpan = [...spans].sort((a, b) => a.start - b.start);
				for (let i = 1; i < bySpan.length; i += 1) {
					if (bySpan[i]!.start < bySpan[i - 1]!.end) {
						return precondition(`edit_file: two hunks overlap in ${path} — make the searches disjoint`);
					}
				}
				// E group: safe replacement — never rewrite a shared external inode via a hard link.
				// round 8: the edited file keeps its mode.
				preservedMode = statSync(full).mode & 0o7777;
				// The postimage: replacements applied highest-offset-first, so
				// earlier spans never shift later coordinates — deterministic
				// under any hunk ORDER (one observed state, one postimage).
				let edited = text;
				for (const sp of [...bySpan].reverse()) {
					edited = edited.slice(0, sp.start) + sp.replace + edited.slice(sp.end);
				}
				writeFileSync(tmp, edited, "utf8");
				chmodSync(tmp, preservedMode);
				// WR-1A ③: revalidate against the citation right before the
				// replacement commits.
				const stale = revalidateBeforeRename(full, expectedRevision, "edit_file", path);
				if (stale !== null) {
					unlinkSync(tmp);
					return stale;
				}
				renameSync(tmp, full);
				const written = realpathSync(full);
				if (!isWithin(realpathSync(opts.workspaceRoot), written)) {
					// WR-1A ①: post-effect — fatal, the rename already landed.
					return postEffectEscape("edit", path);
				}
				return { content: `edited ${path}\n[${contentRevision(Buffer.from(edited, "utf8"))}]`, isError: false };
			} catch (err) {
				// round 8: a failed edit never leaves a temp file behind.
				try {
					unlinkSync(tmp);
				} catch {
					// already renamed or never created
				}
				return { content: `edit_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

/**
 * bootstrap #3 (finding #7): the explicit credential list stripped from shell
 * children — the agent's own provider surface (both families' keys, base
 * URLs, and model choices) plus the generic API-key / auth-token patterns
 * that cover other providers. Everything else in the environment passes
 * through untouched.
 */
const SHELL_STRIP_EXACT = new Set([
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"ANTHROPIC_MODEL",
	"OPENAI_MODEL",
]);

function strippedShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (SHELL_STRIP_EXACT.has(key)) continue;
		if (key.endsWith("_API_KEY") || key.endsWith("_AUTH_TOKEN")) continue;
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export function shellTool(opts: WorkspaceToolsOptions): Tool<{ command: string; timeoutMs?: number }> {
	return defineTool<{ command: string; timeoutMs?: number }>({
		name: "shell",
		description:
			"Run a shell command with the workspace as the working directory. A side effect — approval required. Fails loudly on timeout or non-zero exit.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command to run" },
				timeoutMs: { type: "number", description: "Timeout in ms (default 30000)" },
			},
			required: ["command"],
			additionalProperties: false,
		},
		promptSnippet: "shell — real system commands only (builds, tests, git)",
		promptGuidelines: ["commands run in the workspace root; on failure read the error and adjust — never repeat blindly"],
		execute: async ({ command, timeoutMs }, ctx) => {
			const timeout = timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			// E group: a PRE-aborted signal never spawns the command.
			if (ctx.signal.aborted) {
				return { content: "shell aborted before start", isError: true, errorKind: "fatal" };
			}
			return new Promise((resolvePromise) => {
				// detached: the command gets its OWN process group, so a
				// timeout/abort can kill the WHOLE TREE (children included),
				// not just the outer shell (Area 4). cwd is the workspace.
				// bootstrap #3 (finding #7): the shell child NEVER inherits kiso's own
				// provider credentials by default — only the explicit
				// shellEnv: "inherit" opt-in keeps them.
				const child = spawn(command, {
					shell: true,
					detached: true,
					cwd: opts.workspaceRoot,
					stdio: ["ignore", "pipe", "pipe"],
					env: opts.shellEnv === "inherit" ? process.env : strippedShellEnv(process.env),
				});
				let stdout = "";
				let stderr = "";
				let stdoutDropped = 0;
				let stderrDropped = 0;
				let exited = false;
				let settled = false;
				let killing = false;

				// TUI2-R1 (C): the progress sidecar — truncated at the start
				// (a kill -9 leftover is cleared, never appended to), appended
				// per chunk, removed at settle. Every operation best-effort:
				// the tail is worth nothing next to the command's result.
				const progressPath = shellProgressPath(ctx.sessionId, command);
				const progress = (chunk: string): void => {
					try {
						appendFileSync(progressPath, chunk);
					} catch {
						// a full disk, a vanished temp dir, a racing remover —
						// the tail degrades, the command does not
					}
				};
				try {
					mkdirSync(SHELL_PROGRESS_DIR, { recursive: true });
					writeFileSync(progressPath, "");
				} catch {
					// no sidecar this run — the tail simply never appears
				}
				const dropProgress = (): void => {
					try {
						rmSync(progressPath, { force: true });
					} catch {
						// the file is an observation; failing to remove one is
						// not a failure of the command that produced it
					}
				};

				const settle = (result: { content: string; isError: boolean; errorKind?: "fatal" }): void => {
					if (settled) return;
					settled = true;
					dropProgress();
					clearTimeout(timer);
					// E group: the abort listener is removed once settled — it
					// must not accumulate across runs.
					ctx.signal.removeEventListener("abort", onAbort);
					resolvePromise(result);
				};

				/**
				 * Kill the whole tree and CONFIRM it exited (rounds 8/11):
				 *
				 * 1. FREEZE the root (SIGSTOP) FIRST — a stopped shell cannot
				 *    fork new descendants while we enumerate;
				 * 2. repeatedly discover AND freeze descendants (pid-table
				 *    sweep — the only way to see a setsid()-escaped process)
				 *    until the set is STABLE (two identical scans), so the
				 *    enumeration cannot miss a mid-sweep fork;
				 * 3. SIGKILL the process group and every tracked pid;
				 * 4. poll every tracked pid to death. If ANY tracked pid is
				 *    still alive at the deadline, the verdict is NOT
				 *    "aborted"/"timed out" — it is an explicit UNCERTAIN
				 *    error naming the survivors: the side effect may have
				 *    outlived the tool, and the caller must not assume it
				 *    was killed.
				 */
				const killTree = (): Promise<{ unconfirmed: number[] }> =>
					new Promise((resolveKill) => {
						const tracked = new Set<number>();
						// round 11 (adversarial): the ROOT itself is tracked too — the
						// verdict must not read "aborted" while the root
						// survives. DOCUMENTED LIMITS: (1) a process that
						// forks between SIGSTOP delivery and the next scan,
						// setsids, and is then reparented when its parent is
						// killed can escape the enumeration entirely — it is
						// untracked and unknowable from the pid table; the
						// platform cannot confirm it. (2) if THIS process is
						// killed between the first SIGSTOP and the SIGKILL
						// sweep, the stopped descendants stay permanently
						// stopped (nobody SIGCONTs orphans) — the inherent
						// cost of freeze-first. Both limits are recorded here
						// so no claim of "the whole tree is gone" is ever
						// stronger than what the platform can prove.
						if (child.pid !== undefined && child.pid > 0) {
							tracked.add(child.pid);
							try {
								process.kill(child.pid, "SIGSTOP"); // freeze the root
							} catch {
								// already gone
							}
						}
						// Stable discovery: freeze as we go; stop when two
						// consecutive scans are identical.
						let previous = new Set<number>();
						for (let i = 0; i < 10; i++) {
							const current = new Set(descendantsOf(child.pid ?? 0));
							for (const pid of current) {
								tracked.add(pid);
								try {
									process.kill(pid, "SIGSTOP"); // freeze each descendant
								} catch {
									// already gone
								}
							}
							if (current.size === previous.size && [...current].every((pid) => previous.has(pid))) {
								break;
							}
							previous = current;
						}
						// The process group (E group: never kill an undefined/0
						// pid), which also takes the frozen root down.
						if (child.pid !== undefined && child.pid > 0) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								try {
									child.kill("SIGKILL");
								} catch {
									// already gone
								}
							}
						}
						for (const pid of tracked) {
							try {
								process.kill(pid, "SIGKILL");
							} catch {
								// already gone
							}
						}
						const confirm = (): void => {
							void waitAllDead([...tracked]).then((unconfirmed) => resolveKill({ unconfirmed }));
						};
						if (exited) {
							confirm();
							return;
						}
						const fallback = setTimeout(confirm, 2000);
						child.once("close", () => {
							clearTimeout(fallback);
							confirm();
						});
					});

				child.stdout?.on("data", (d: Buffer) => {
					const text = d.toString();
					progress(text);
					const r = capAccumulate(stdout, text);
					stdout = r.text;
					stdoutDropped += r.dropped;
				});
				child.stderr?.on("data", (d: Buffer) => {
					const text = d.toString();
					progress(text);
					const r = capAccumulate(stderr, text);
					stderr = r.text;
					stderrDropped += r.dropped;
				});
				child.on("error", (err) => {
					settle({ content: `shell failed: ${err.message}`, isError: true, errorKind: "fatal" });
				});
				child.on("close", (code) => {
					exited = true;
					if (killing) return; // the timeout/abort verdict owns the result
					// R-C item 2: the overflow note names WHAT was dropped and
					// the recovery path — a silent tail-cut would be the exact
					// destructive class this round kills (W10 made model-facing).
					const overflowNote = (dropped: number, stream: string): string =>
						dropped === 0
							? ""
							: `\n… [${stream} capped at ${OUTPUT_CAP} chars — ${dropped} more chars dropped; capture to a file and read it with read_file, or narrow the command]`;
					const combined = (
						stdout +
						overflowNote(stdoutDropped, "stdout") +
						(stderr ? `\n[stderr] ${stderr}` : "") +
						overflowNote(stderrDropped, "stderr")
					).trim();
					settle(
						code === 0
							? { content: combined || "(no output)", isError: false }
							: { content: `exit ${code}: ${combined}`, isError: true, errorKind: "fatal" },
					);
				});

				// The kernel's abort reaches the command AND its whole tree.
				// The listener is removed by settle (E group).
				const uncertainVerdict = (unconfirmed: number[]): string =>
					unconfirmed.length > 0
						? `could not confirm ${unconfirmed.length} descendant(s) exited (pids ${unconfirmed.join(", ")}) — treat the side effect as UNCERTAIN`
						: "";
				const onAbort = (): void => {
					killing = true;
					void killTree().then(({ unconfirmed }) =>
						settle({
							content: `shell aborted${uncertainVerdict(unconfirmed) ? ` — ${uncertainVerdict(unconfirmed)}` : ""}`,
							isError: true,
							errorKind: "fatal",
						}),
					);
				};
				ctx.signal.addEventListener("abort", onAbort);
				const timer = setTimeout(() => {
					killing = true;
					void killTree().then(({ unconfirmed }) =>
						settle({
							content: `shell timed out after ${timeout}ms${uncertainVerdict(unconfirmed) ? ` — ${uncertainVerdict(unconfirmed)}` : ""}`,
							isError: true,
							errorKind: "fatal",
						}),
					);
				}, timeout);
				timer.unref?.();
			});
		},
	});
}

/**
 * All live pids whose ancestor chain includes `pid`, from the pid table
 * (round 8: `ps -axo pid=,ppid=` — the ONLY way to see a setsid()-escaped
 * process, which is in its own group and invisible to a group kill).
 */
function descendantsOf(pid: number): number[] {
	if (pid <= 0) return [];
	let table: string;
	try {
		table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 1 << 20 });
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of table.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (m === null) continue;
		const child = Number(m[1]);
		const parent = Number(m[2]);
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(child);
	}
	const out: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const c of children.get(current) ?? []) {
			out.push(c);
			queue.push(c);
		}
	}
	return out;
}

/**
 * Poll the pid table until NONE of the tracked pids is alive (bounded).
 * Returns the pids still alive at the deadline — the caller MUST NOT
 * report "aborted"/"timed out" while any tracked pid survives (round 11).
 */
function waitAllDead(pids: readonly number[]): Promise<number[]> {
	if (pids.length === 0) return Promise.resolve([]);
	return new Promise((resolve) => {
		const deadline = Date.now() + 2000;
		const poll = (): void => {
			const alive: number[] = [];
			for (const pid of pids) {
				try {
					process.kill(pid, 0);
					alive.push(pid);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EPERM") alive.push(pid);
					// ESRCH — gone
				}
			}
			if (alive.length === 0 || Date.now() > deadline) return resolve(alive);
			setTimeout(poll, 50);
		};
		poll();
	});
}

/** The full coding toolset, bound to one workspace root (Area 5). */
export function createCodingTools(opts: WorkspaceToolsOptions): readonly Tool<any>[] {
	return [
		readFileTool(opts),
		listDirTool(opts),
		searchTextTool(opts),
		writeFileTool(opts),
		editFileTool(opts),
		shellTool(opts),
	];
}
