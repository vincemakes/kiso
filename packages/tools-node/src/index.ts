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
import { defineTool, type Tool, type ToolResult } from "@kiso/core";

const OUTPUT_CAP = 100_000; // chars of output a tool result may carry
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

function cap(text: string): string {
	return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated]` : text;
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

export interface WorkspaceToolsOptions {
	/** The workspace the tools may touch; everything else is refused. */
	readonly workspaceRoot: string;
}

/**
 * The inode-boundary policy for READS (八): a hard link inside the workspace
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
	let inside = 0;
	try {
		const out = execFileSync("find", [root, "-inum", String(st.ino)], { encoding: "utf8", maxBuffer: 1 << 20 });
		inside = out.trim() === "" ? 0 : out.trim().split("\n").length;
	} catch {
		inside = 0; // cannot verify — refuse (fail-closed)
	}
	if (inside < st.nlink) {
		return `file has ${st.nlink - inside} hard link(s) outside the workspace — refusing to read (${full})`;
	}
	return null;
}

export function readFileTool(opts: WorkspaceToolsOptions): Tool<{ path: string }> {
	return defineTool<{ path: string }>({
		name: "read_file",
		description: "Read a file's content from disk. Relative to the workspace root.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative path of the file to read" } },
			required: ["path"],
		},
		idempotent: true,
		execute: async ({ path }) => {
			try {
				const full = resolveWithinRoot(opts.workspaceRoot, path);
				const denied = inodeReadPolicy(opts.workspaceRoot, full);
				if (denied !== null) return escapeResult(denied);
				const content = readFileSync(full, "utf8");
				return { content: cap(content), isError: false };
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
		description: "List the entries of a directory. Omit path to list the workspace root.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative directory to list" } },
		},
		idempotent: true,
		execute: async ({ path }) => {
			try {
				const dir = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
				const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
					const isDir = e.isDirectory();
					return `${isDir ? "dir " : "file"} ${e.name}${isDir ? "/" : ""}`;
				});
				return { content: entries.length ? cap(entries.join("\n")) : "(empty directory)", isError: false };
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
			"Search files under a workspace directory (recursive) for a regular expression. Returns matching file:line excerpts, capped.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to search for" },
				path: { type: "string", description: "Workspace-relative root directory (default: workspace root)" },
			},
			required: ["pattern"],
		},
		idempotent: true,
		execute: async ({ pattern, path }) => {
			let root: string;
			try {
				root = resolveWithinRoot(opts.workspaceRoot, path ?? ".");
			} catch (err) {
				if (err instanceof PathEscapeError) return escapeResult(err.message);
				throw err;
			}
			const regex = new RegExp(pattern, "i");
			const matches: string[] = [];
			const walk = (dir: string, depth: number): void => {
				if (depth > 8 || matches.length > 200) return;
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(full, depth + 1);
					} else if (entry.isFile()) {
						try {
							// 八: same inode boundary as read_file — a hard link
							// to an external inode is not searched.
							if (inodeReadPolicy(root, full) !== null) continue;
							const text = readFileSync(full, "utf8");
							for (const [i, line] of text.split("\n").entries()) {
								if (regex.test(line)) {
									matches.push(`${full}:${i + 1}: ${line.trim().slice(0, 160)}`);
									if (matches.length >= 200) return;
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
			return { content: matches.length ? cap(matches.join("\n")) : "(no matches)", isError: false };
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
				// E 组: SAFE REPLACEMENT — write a temp file next to the
				// target and rename it over the directory entry. A hard link
				// inside the workspace that shares an EXTERNAL inode is
				// therefore never overwritten: rename replaces the entry,
				// not the shared inode.
				// 八: an existing file keeps its mode — a 0755 script stays
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
				// 八: a failed write never leaves a temp file with the FULL
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
				// E 组: safe replacement — never rewrite a shared external inode via a hard link.
				// 八: the edited file keeps its mode.
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
				// 八: a failed edit never leaves a temp file behind.
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
		execute: async ({ command, timeoutMs }, ctx) => {
			const timeout = timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			// E 组: a PRE-aborted signal never spawns the command.
			if (ctx.signal.aborted) {
				return { content: "shell aborted before start", isError: true, errorKind: "fatal" };
			}
			return new Promise((resolvePromise) => {
				// detached: the command gets its OWN process group, so a
				// timeout/abort can kill the WHOLE TREE (children included),
				// not just the outer shell (Area 4). cwd is the workspace.
				const child = spawn(command, {
					shell: true,
					detached: true,
					cwd: opts.workspaceRoot,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let exited = false;
				let settled = false;
				let killing = false;

				const settle = (result: { content: string; isError: boolean; errorKind?: "fatal" }): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					// E 组: the abort listener is removed once settled — it
					// must not accumulate across runs.
					ctx.signal.removeEventListener("abort", onAbort);
					resolvePromise(result);
				};

				/**
				 * Kill the whole tree and CONFIRM it exited (八): the process
				 * group covers the shell and its in-group children, but a
				 * descendant that called setsid() has its own group — only the
				 * pid table can find it. Every tracked descendant is killed and
				 * polled to death before the tool returns.
				 */
				const killTree = (): Promise<void> =>
					new Promise((resolveKill) => {
						const tracked = new Set<number>();
						// 1. The pid-table sweep FIRST, while the child is still
						//    alive — its descendants are still traceable.
						for (const pid of descendantsOf(child.pid ?? 0)) {
							tracked.add(pid);
							try {
								process.kill(pid, "SIGKILL");
							} catch {
								// already gone
							}
						}
						// 2. The process group (E 组: never kill an undefined/0
						//    pid), which also takes the direct shell down.
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
						if (exited) {
							resolveKill();
							return;
						}
						const fallback = setTimeout(resolveKill, 2000);
						child.once("close", () => {
							clearTimeout(fallback);
							// 3. 八: the timeout/abort verdict is not final until
							//    EVERY tracked descendant has actually exited.
							void waitAllDead([...tracked]).then(() => resolveKill());
						});
					});

				child.stdout?.on("data", (d: Buffer) => {
					stdout = cap(stdout + d.toString());
				});
				child.stderr?.on("data", (d: Buffer) => {
					stderr = cap(stderr + d.toString());
				});
				child.on("error", (err) => {
					settle({ content: `shell failed: ${err.message}`, isError: true, errorKind: "fatal" });
				});
				child.on("close", (code) => {
					exited = true;
					if (killing) return; // the timeout/abort verdict owns the result
					const combined = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
					settle(
						code === 0
							? { content: combined || "(no output)", isError: false }
							: { content: `exit ${code}: ${combined}`, isError: true, errorKind: "fatal" },
					);
				});

				// The kernel's abort reaches the command AND its whole tree.
				// The listener is removed by settle (E 组).
				const onAbort = (): void => {
					killing = true;
					void killTree().then(() =>
						settle({ content: "shell aborted", isError: true, errorKind: "fatal" }),
					);
				};
				ctx.signal.addEventListener("abort", onAbort);
				const timer = setTimeout(() => {
					killing = true;
					void killTree().then(() =>
						settle({ content: `shell timed out after ${timeout}ms`, isError: true, errorKind: "fatal" }),
					);
				}, timeout);
				timer.unref?.();
			});
		},
	});
}

/**
 * All live pids whose ancestor chain includes `pid`, from the pid table
 * (八: `ps -axo pid=,ppid=` — the ONLY way to see a setsid()-escaped
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

/** Poll the pid table until NONE of the tracked pids is alive (bounded). */
function waitAllDead(pids: readonly number[]): Promise<void> {
	if (pids.length === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const deadline = Date.now() + 2000;
		const poll = (): void => {
			for (const pid of pids) {
				try {
					process.kill(pid, 0);
					if (Date.now() > deadline) return resolve();
					setTimeout(poll, 50);
					return;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EPERM") {
						if (Date.now() > deadline) return resolve();
						setTimeout(poll, 50);
						return;
					}
					// ESRCH — gone
				}
			}
			resolve();
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
