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

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type Tool } from "@kiso/core";

const OUTPUT_CAP = 100_000; // chars of output a tool result may carry
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

function cap(text: string): string {
	return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated]` : text;
}

export function readFileTool(): Tool<{ path: string }> {
	return defineTool<{ path: string }>({
		name: "read_file",
		description: "Read a file's content from disk. Relative paths resolve against the working directory.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Path of the file to read" } },
			required: ["path"],
		},
		idempotent: true,
		execute: async ({ path }) => {
			try {
				const content = readFileSync(resolve(path), "utf8");
				return { content: cap(content), isError: false };
			} catch (err) {
				return { content: `read_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function listDirTool(): Tool<{ path?: string }> {
	return defineTool<{ path?: string }>({
		name: "list_dir",
		description: "List the entries of a directory. Omit path to list the working directory.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Directory to list" } },
		},
		idempotent: true,
		execute: async ({ path }) => {
			try {
				const dir = resolve(path ?? ".");
				const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
					const isDir = e.isDirectory();
					return `${isDir ? "dir " : "file"} ${e.name}${isDir ? "/" : ""}`;
				});
				return { content: entries.length ? cap(entries.join("\n")) : "(empty directory)", isError: false };
			} catch (err) {
				return { content: `list_dir failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function searchTextTool(): Tool<{ pattern: string; path?: string }> {
	return defineTool<{ pattern: string; path?: string }>({
		name: "search_text",
		description:
			"Search files under a directory (recursive) for a regular expression. Returns matching file:line excerpts, capped.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to search for" },
				path: { type: "string", description: "Root directory (default: working directory)" },
			},
			required: ["pattern"],
		},
		idempotent: true,
		execute: async ({ pattern, path }) => {
			const root = resolve(path ?? ".");
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

export function writeFileTool(): Tool<{ path: string; content: string }> {
	return defineTool<{ path: string; content: string }>({
		name: "write_file",
		description: "Write content to a file, replacing it entirely. A side effect — approval required.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File to write" },
				content: { type: "string", description: "Full new content" },
			},
			required: ["path", "content"],
		},
		execute: async ({ path, content }) => {
			try {
				writeFileSync(resolve(path), content, "utf8");
				return { content: `wrote ${path} (${content.length} chars)`, isError: false };
			} catch (err) {
				return { content: `write_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function editFileTool(): Tool<{ path: string; search: string; replace: string }> {
	return defineTool<{ path: string; search: string; replace: string }>({
		name: "edit_file",
		description: "Replace the FIRST occurrence of a literal string in a file. A side effect — approval required.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				search: { type: "string", description: "Exact literal text to find" },
				replace: { type: "string", description: "Replacement text" },
			},
			required: ["path", "search", "replace"],
		},
		execute: async ({ path, search, replace }) => {
			const full = resolve(path);
			try {
				const text = readFileSync(full, "utf8");
				const index = text.indexOf(search);
				if (index === -1) {
					return { content: `edit_file: pattern not found in ${path}`, isError: true, errorKind: "invalid_input" };
				}
				writeFileSync(full, text.slice(0, index) + replace + text.slice(index + search.length), "utf8");
				return { content: `edited ${path}`, isError: false };
			} catch (err) {
				return { content: `edit_file failed: ${(err as Error).message}`, isError: true, errorKind: "fatal" };
			}
		},
	});
}

export function shellTool(): Tool<{ command: string; timeoutMs?: number }> {
	return defineTool<{ command: string; timeoutMs?: number }>({
		name: "shell",
		description:
			"Run a shell command in the working directory. A side effect — approval required. Fails loudly on timeout or non-zero exit.",
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
			return new Promise((resolvePromise) => {
				const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				let done = false;

				const finish = (result: { content: string; isError: boolean; errorKind?: "fatal" }) => {
					if (done) return;
					done = true;
					child.kill("SIGKILL");
					resolvePromise(result);
				};

				child.stdout?.on("data", (d: Buffer) => {
					stdout = cap(stdout + d.toString());
				});
				child.stderr?.on("data", (d: Buffer) => {
					stderr = cap(stderr + d.toString());
				});
				child.on("error", (err) => {
					finish({ content: `shell failed: ${err.message}`, isError: true, errorKind: "fatal" });
				});
				child.on("close", (code) => {
					const combined = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
					finish(
						code === 0
							? { content: combined || "(no output)", isError: false }
							: { content: `exit ${code}: ${combined}`, isError: true, errorKind: "fatal" },
					);
				});

				// The kernel's abort reaches the command (Phase D).
				if (ctx.signal) {
					ctx.signal.addEventListener("abort", () => {
						finish({ content: "shell aborted", isError: true, errorKind: "fatal" });
					});
				}
				const timer = setTimeout(() => {
					finish({ content: `shell timed out after ${timeout}ms`, isError: true, errorKind: "fatal" });
				}, timeout);
				timer.unref?.();
			});
		},
	});
}

export const CODING_TOOLS: readonly Tool<any>[] = [
	readFileTool(),
	listDirTool(),
	searchTextTool(),
	writeFileTool(),
	editFileTool(),
	shellTool(),
];
