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

import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";

const OUTPUT_CAP = 100_000; // chars of output a tool result may carry
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
// the token round: the scoped-read defaults — read_file shows the head 200 lines
// of a large file (with an actionable continuation note, never a silent
// drop), search_text caps at 50 excerpts, list_dir at 200 entries. The
// red line: every truncation names its continuation — the model always
// has a path to the full content.
const DEFAULT_READ_LINES = 200;
const MAX_SEARCH_MATCHES = 50;
const MAX_DIR_ENTRIES = 200;

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
function inodeReadPolicy(root: string, full: string): string | null {
	const st = statSync(full);
	if (!st.isFile()) return `not a regular file — refusing to read (${full})`;
	if (st.nlink <= 1) return null;
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
		const out = execFileSync(
			"find",
			[rootReal, "-xdev", "-inum", String(st.ino), "-print0"],
			{ encoding: "utf8", maxBuffer: 1 << 20 },
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
	if (inside < 0 || inside < st.nlink) {
		const verified = inside < 0 ? "unverifiable" : `${inside}/${st.nlink}`;
		return `file has hard links outside the workspace (${verified} inside) — refusing to read (${full})`;
	}
	return null;
}

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
			"Read a file's content from disk (the workspace reader — prefer it over shell cat/head/tail). Relative to the workspace root. Returns the first 200 lines by default; a file with more lines appends a note with the exact count and the offset to continue from. Pass offset (1-based first line) and/or limit (line count) to read a range.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path of the file to read" },
				offset: { type: "number", description: "1-based first line to read (default: 1)" },
				limit: { type: "number", description: "Maximum number of lines to read (default: to the end of the file)" },
			},
			required: ["path"],
		},
		idempotent: true,
		promptSnippet: "read_file — whole files or offset/limit ranges, workspace-relative paths",
		promptGuidelines: ["read only the range you need — offset/limit beat whole-file reads"],
		execute: async ({ path, offset, limit }) => {
			try {
				const full = resolveWithinRoot(opts.workspaceRoot, path);
				const denied = inodeReadPolicy(opts.workspaceRoot, full);
				if (denied !== null) return escapeResult(denied);
				const content = readFileSync(full, "utf8");
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
				return { content: `${text}${note}`, isError: false };
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
		},
		idempotent: true,
		promptSnippet: "list_dir — directory entries (the workspace ls)",
		promptGuidelines: ["narrow to a subdirectory when the listing caps at 200 entries"],
		execute: async ({ path }) => {
			try {
				const dir = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
				const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
					const isDir = e.isDirectory();
					return `${isDir ? "dir " : "file"} ${e.name}${isDir ? "/" : ""}`;
				});
				let content = entries.length ? cap(entries.slice(0, MAX_DIR_ENTRIES).join("\n")) : "(empty directory)";
				if (entries.length > MAX_DIR_ENTRIES) {
					// R-C item 2: the N of M form — the cap names its
					// continuation (narrow to a subdirectory for more).
					content += `\n… ${MAX_DIR_ENTRIES} of ${entries.length} entries shown (narrow to a subdirectory for more)`;
				}
				return { content, isError: false };
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				return { content: `list_dir failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function searchTextTool(opts: WorkspaceToolsOptions): Tool<{ pattern: string; path?: string }> {
	return defineTool<{ pattern: string; path?: string }>({
		name: "search_text",
		description:
			"Search files under a workspace directory (recursive) for a regular expression (the workspace grep — prefer it over shell grep/rg). Returns matching file:line excerpts, capped at 50 — an overflow note states the count of further matches (narrow the pattern to see them).",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to search for" },
				path: { type: "string", description: "Workspace-relative root directory (default: workspace root)" },
			},
			required: ["pattern"],
		},
		idempotent: true,
		promptSnippet: "search_text — regex search over workspace files",
		promptGuidelines: ["narrow the pattern when the result caps — never re-run a broad search"],
		execute: async ({ pattern, path }) => {
			let root: string;
			try {
				root = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			const regex = new RegExp(pattern, "i");
			// The walk NEVER early-aborts on the cap: the overflow note's count
			// must be the file-true total, not a bound (the red line). The
			// depth cap and the node_modules/dotfile skip stay.
			const matches: string[] = [];
			let totalMatches = 0;
			const walk = (dir: string, depth: number): void => {
				if (depth > 8) return;
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(full, depth + 1);
					} else if (entry.isFile()) {
						try {
							// round 8: same inode boundary as read_file — a hard link
							// to an external inode is not searched. round 4 (adversarial):
							// the link count is verified against the WORKSPACE
							// root, not the search subroot — a link that lives
							// inside the workspace but outside the search dir is
							// legal and must not be silently skipped.
							if (inodeReadPolicy(opts.workspaceRoot, full) !== null) continue;
							const text = readFileSync(full, "utf8");
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
					}
				}
			};
			try {
				walk(root, 0);
			} catch (err) {
				return { content: `search_text failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
			let content = matches.length ? cap(matches.join("\n")) : "(no matches)";
			if (totalMatches > matches.length) {
				// R-C item 2: the N of M form — the cap names its
				// continuation (narrow the pattern for more).
				content += `\n… ${matches.length} of ${totalMatches} matches shown (narrow the pattern for more)`;
			}
			return { content, isError: false };
		},
	});
}

export function writeFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string; content: string }> {
	return defineTool<{ path: string; content: string }>({
		name: "write_file",
		description: "Write content to a file inside the workspace, replacing it entirely. A side effect — approval required.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file to write" },
				content: { type: "string", description: "Full new content" },
			},
			required: ["path", "content"],
		},
		promptSnippet: "write_file — write a whole file (creates parent directories)",
		execute: async ({ path, content }) => {
			let full: string;
			try {
				full = resolveWithinRoot(opts.workspaceRoot, path);
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
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
				if (existsSync(full)) preservedMode = statSync(full).mode & 0o7777;
				writeFileSync(tmp, content, "utf8");
				if (preservedMode !== undefined) chmodSync(tmp, preservedMode);
				renameSync(tmp, full);
				// Post-write re-check (review finding 8): if a concurrent
				// swap turned the verified path into a symlink mid-write,
				// the write landed outside the workspace — say so instead of
				// claiming success. (The write itself cannot be undone.)
				const written = realpathSync(full);
				if (!isWithin(realpathSync(opts.workspaceRoot), written)) {
					return escapeResult(`write escaped the workspace via a swapped path (${path})`);
				}
				return { content: `wrote ${path} (${content.length} chars)`, isError: false };
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

export function editFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string; search: string; replace: string }> {
	return defineTool<{ path: string; search: string; replace: string }>({
		name: "edit_file",
		description: "Replace the FIRST occurrence of a literal string in a workspace file. A side effect — approval required.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file" },
				search: { type: "string", description: "Exact literal text to find" },
				replace: { type: "string", description: "Replacement text" },
			},
			required: ["path", "search", "replace"],
		},
		promptSnippet: "edit_file — replace an exact old_string block (never rewrite whole files)",
		promptGuidelines: ["the search text must match the file EXACTLY — read the target first"],
		execute: async ({ path, search, replace }) => {
			let full: string;
			try {
				full = resolveWithinRoot(opts.workspaceRoot, path);
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			const tmp = `${full}.kiso-tmp-${process.pid}-${crypto.randomUUID()}`;
			let preservedMode: number | undefined;
			try {
				const text = readFileSync(full, "utf8");
				const index = text.indexOf(search);
				if (index === -1) {
					return { content: `edit_file: pattern not found in ${path}`, isError: true, errorKind: "invalid_input" };
				}
				// E group: safe replacement — never rewrite a shared external inode via a hard link.
				// round 8: the edited file keeps its mode.
				preservedMode = statSync(full).mode & 0o7777;
				writeFileSync(tmp, text.slice(0, index) + replace + text.slice(index + search.length), "utf8");
				chmodSync(tmp, preservedMode);
				renameSync(tmp, full);
				const written = realpathSync(full);
				if (!isWithin(realpathSync(opts.workspaceRoot), written)) {
					return escapeResult(`edit escaped the workspace via a swapped path (${path})`);
				}
				return { content: `edited ${path}`, isError: false };
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

				const settle = (result: { content: string; isError: boolean; errorKind?: "fatal" }): void => {
					if (settled) return;
					settled = true;
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
					const r = capAccumulate(stdout, d.toString());
					stdout = r.text;
					stdoutDropped += r.dropped;
				});
				child.stderr?.on("data", (d: Buffer) => {
					const r = capAccumulate(stderr, d.toString());
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
