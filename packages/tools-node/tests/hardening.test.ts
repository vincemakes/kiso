/**
 * 八 — failure-path hardening for the coding tools.
 *
 * - shell kills a setsid()-escaped descendant (invisible to a process-group
 *   kill) and CONFIRMS every tracked descendant exited before returning;
 * - write/edit preserve the existing file's mode and never leave a
 *   .kiso-tmp-* file with full sensitive content behind on any failure;
 * - read_file enforces the inode-boundary policy: regular files read,
 *   multi-link files whose every link is inside the workspace read,
 *   multi-link files with any link OUTSIDE are refused, non-regular files
 *   (fifo) are refused.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AbortSignalLike, ToolContext } from "@kiso/core";
import { canonicalTargetPath, editFileTool, readFileTool, searchTextTool, shellTool, writeFileTool } from "../src/index.js";

function root(): string {
	return mkdtempSync(join(tmpdir(), "kiso-hard-"));
}

const NEVER_ABORT: AbortSignalLike = {
	aborted: false,
	addEventListener: () => {},
	removeEventListener: () => {},
};

const CTX = (signal: AbortSignalLike = NEVER_ABORT): ToolContext => ({ signal });

/** Count live processes whose command line contains the marker. */
function liveWith(marker: string): number {
	const ps = execFileSync("ps", ["-axo", "args"], { encoding: "utf8" });
	return ps.split("\n").filter((l) => l.includes(marker) && !l.includes("grep")).length;
}

describe("shell: the whole tree dies (八)", () => {
	it(
		"a setsid()-escaped descendant is killed and CONFIRMED exited",
		async () => {
			const dir = root();
			const marker = `sleep 8127`;
			// The command escapes its process group via setsid(): a plain
			// group kill would miss it — only the pid-table sweep finds it.
			// `& wait` keeps the outer shell alive AND forces a fork, so the
			// python is a plain child (never a group leader) and setsid()
			// succeeds on macOS.
			const promise = shellTool({ workspaceRoot: dir }).execute(
				{ command: `python3 -c "import os; os.setsid(); os.system('${marker}')" & wait` },
				CTX({
					aborted: false,
					addEventListener: (_t, listener) => setTimeout(() => (listener as () => void)(), 800),
					removeEventListener: () => {},
				}),
			);
			const result = await promise;
			expect(result).toMatchObject({ isError: true });
			expect(result.content).toMatch(/abort/i);
			// The escaped descendant is gone — confirmed, not assumed.
			await new Promise((r) => setTimeout(r, 500));
			expect(liveWith(marker)).toBe(0);
		},
		15_000,
	);
});

describe("write/edit: mode and temp hygiene (八)", () => {
	it("write_file preserves the existing mode — 0755 stays 0755", async () => {
		const dir = root();
		const target = join(dir, "script.sh");
		writeFileSync(target, "old", "utf8");
		chmodSync(target, 0o755);
		const result = await writeFileTool({ workspaceRoot: dir }).execute(
			{ path: "script.sh", content: "new content" },
			CTX(),
		);
		expect(result).toMatchObject({ isError: false });
		expect(statSync(target).mode & 0o7777).toBe(0o755);
	});

	it("edit_file preserves the mode too", async () => {
		const dir = root();
		const target = join(dir, "script.sh");
		writeFileSync(target, "ONE", "utf8");
		chmodSync(target, 0o711);
		const result = await editFileTool({ workspaceRoot: dir }).execute(
			{ path: "script.sh", search: "ONE", replace: "TWO" },
			CTX(),
		);
		expect(result).toMatchObject({ isError: false });
		expect(statSync(target).mode & 0o7777).toBe(0o711);
	});

	it("a FAILED write (rename onto a directory) leaves no .kiso-tmp-* with the content behind", async () => {
		const dir = root();
		mkdirSync(join(dir, "blocked"), { recursive: true });
		const result = await writeFileTool({ workspaceRoot: dir }).execute(
			{ path: "blocked", content: "TOP-SECRET-CONTENT" },
			CTX(),
		);
		expect(result).toMatchObject({ isError: true });
		expect(readdirSync(dir).filter((f) => f.includes(".kiso-tmp-"))).toEqual([]);
		// And nothing anywhere in the workspace carries the secret in a temp.
		for (const entry of readdirSync(dir)) {
			if (entry.includes(".kiso-tmp-")) expect(readFileSync(join(dir, entry), "utf8")).not.toContain("TOP-SECRET");
		}
	});

	it("a FAILED edit (unwritable directory) leaves no .kiso-tmp-* behind", async () => {
		const dir = root();
		const target = join(dir, "e.txt");
		writeFileSync(target, "ONE TWO", "utf8");
		chmodSync(dir, 0o555); // temp creation now fails
		const result = await editFileTool({ workspaceRoot: dir }).execute(
			{ path: "e.txt", search: "ONE", replace: "TWO" },
			CTX(),
		);
		chmodSync(dir, 0o755);
		expect(result).toMatchObject({ isError: true });
		expect(readdirSync(dir).filter((f) => f.includes(".kiso-tmp-"))).toEqual([]);
	});
});

describe("read_file inode boundary (八)", () => {
	it("refuses a hard link to an inode whose links live OUTSIDE the workspace", async () => {
		const dir = root();
		const outside = join(dirname(dir), "external-secret.txt");
		writeFileSync(outside, "TOP-SECRET", "utf8");
		linkSync(outside, join(dir, "linked.txt"));
		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "linked.txt" }, CTX());
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(result.content).toMatch(/hard link/);
		expect(result.content).not.toContain("TOP-SECRET"); // nothing leaked
	});

	it("reads a multi-link file whose EVERY link is inside the workspace", async () => {
		const dir = root();
		const a = join(dir, "a.txt");
		writeFileSync(a, "shared-content", "utf8");
		linkSync(a, join(dir, "b.txt"));
		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "a.txt" }, CTX());
		expect(result).toMatchObject({ isError: false, content: "shared-content" });
	});

	it("reads an ordinary single-link file", async () => {
		const dir = root();
		writeFileSync(join(dir, "plain.txt"), "hello", "utf8");
		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "plain.txt" }, CTX());
		expect(result).toMatchObject({ isError: false, content: "hello" });
	});

	it("refuses non-regular file types (a fifo)", async () => {
		const dir = root();
		execFileSync("mkfifo", [join(dir, "pipe")]);
		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "pipe" }, CTX());
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(result.content).toMatch(/not a regular file/);
	});

	it("第四轮: a hard link named with a NEWLINE cannot fool the link count — read_file refuses and leaks nothing", async () => {
		const dir = root();
		const outside = join(dirname(dir), "external-newline-secret.txt");
		writeFileSync(outside, "NEWLINE-TOP-SECRET", "utf8");
		// The in-workspace link's name contains "\n" — newline-splitting the
		// find output would count ONE path as TWO and pass the boundary.
		const spoof = join(dir, "inside\nspoof");
		linkSync(outside, spoof);

		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "inside\nspoof" }, CTX());
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(result.content).toMatch(/hard link/);
		expect(result.content).not.toContain("NEWLINE-TOP-SECRET"); // nothing leaked
	});

	it("第四轮: search_text applies the same newline-proof boundary and leaks nothing", async () => {
		const dir = root();
		const outside = join(dirname(dir), "external-search-secret.txt");
		writeFileSync(outside, "SEARCH-SECRET-MARKER", "utf8");
		linkSync(outside, join(dir, "inside\nspoof"));

		const result = await searchTextTool({ workspaceRoot: dir }).execute(
			{ pattern: "SEARCH-SECRET-MARKER" },
			CTX(),
		);
		expect(result).toMatchObject({ isError: false });
		expect(String(result.content)).not.toContain("SEARCH-SECRET-MARKER"); // never read
	});

	it("第四轮: a multi-link file whose every link is INSIDE the workspace still reads (even with odd names)", async () => {
		const dir = root();
		const a = join(dir, "a.txt");
		writeFileSync(a, "internal-shared", "utf8");
		linkSync(a, join(dir, "b\nline.txt")); // a second inside link with a newline name
		const result = await readFileTool({ workspaceRoot: dir }).execute({ path: "a.txt" }, CTX());
		expect(result).toMatchObject({ isError: false, content: "internal-shared" });
	});
});

describe("canonicalTargetPath (十)", () => {
	it("a file to be created under a SYMLINKED directory resolves to the REAL target", async () => {
		const dir = root();
		const realDir = join(realpathSync(dir), "real-dir"); // /var → /private/var on macOS
		mkdirSync(realDir, { recursive: true });
		symlinkSync(realDir, join(dir, "link-dir"));
		const canonical = canonicalTargetPath(join(dir, "link-dir", "new-file.txt"));
		expect(canonical).toBe(join(realDir, "new-file.txt")); // the TARGET, not the link
	});

	it("an existing file through a symlink resolves to the real file", async () => {
		const dir = root();
		const real = join(realpathSync(dir), "real.txt");
		writeFileSync(real, "x", "utf8");
		symlinkSync(real, join(dir, "link.txt"));
		expect(canonicalTargetPath(join(dir, "link.txt"))).toBe(real);
	});

	it("a plain path is resolved as-is", async () => {
		const dir = root();
		expect(canonicalTargetPath(join(dir, "plain.txt"))).toBe(join(realpathSync(dir), "plain.txt"));
	});
});
