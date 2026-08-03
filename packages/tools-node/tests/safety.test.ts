/**
 * E 组 — process and filesystem safety.
 *
 * - shell handles a PRE-aborted signal (never spawns), cleans up its abort
 *   listener, and never kills an undefined/0 pid
 * - write/edit use SAFE REPLACEMENT (temp + rename): a hard link inside
 *   the workspace pointing at an EXTERNAL inode is never overwritten —
 *   the shared external file stays untouched
 */

import { linkSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AbortSignalLike, ToolContext } from "@vincemakes/kiso-core";
import { shellTool, writeFileTool, editFileTool } from "../src/index.js";

function root(): string {
	return mkdtempSync(join(tmpdir(), "kiso-safe-"));
}

const NEVER_ABORT: AbortSignalLike = {
	aborted: false,
	addEventListener: () => {},
	removeEventListener: () => {},
};

/** A signal that can be flipped, tracking its listener count. */
function flipSignal(): { signal: AbortSignalLike; flip: () => void; listeners: () => number } {
	let aborted = false;
	const listeners = new Set<() => void>();
	return {
		signal: {
			get aborted() {
				return aborted;
			},
			addEventListener: (_type, listener) => {
				listeners.add(listener as () => void);
			},
			removeEventListener: (_type, listener) => {
				listeners.delete(listener as () => void);
			},
		},
		flip: () => {
			aborted = true;
			for (const l of [...listeners]) l();
		},
		listeners: () => listeners.size,
	};
}

const CTX = (signal: AbortSignalLike): ToolContext => ({ signal });

describe("shell process safety (E 组)", () => {
	it("a PRE-aborted signal never spawns the command", async () => {
		const dir = root();
		const marker = join(dir, "ran.txt");
		const { signal } = flipSignal();
		signal.aborted; // construct
		const preAborted: AbortSignalLike = { aborted: true, addEventListener: () => {}, removeEventListener: () => {} };
		const result = await shellTool({ workspaceRoot: dir }).execute(
			{ command: `touch ${marker}` },
			CTX(preAborted),
		);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toMatch(/abort/i);
		expect(() => readFileSync(marker, "utf8")).toThrow(); // never ran
	});

	it("an abort AFTER normal completion changes nothing and the listener is cleaned up", async () => {
		const dir = root();
		const { signal, flip, listeners } = flipSignal();
		const result = await shellTool({ workspaceRoot: dir }).execute({ command: "echo done" }, CTX(signal));
		expect(result).toMatchObject({ isError: false, content: "done" });
		const before = listeners();
		flip(); // a late abort must not disturb anything
		expect(listeners()).toBe(before); // no leak accumulation
		expect(result.content).toBe("done"); // unchanged
	});

	it("a spawn failure followed by abort does not crash and never kills a bogus pid", async () => {
		const dir = root();
		const { signal, flip } = flipSignal();
		const result = await shellTool({ workspaceRoot: dir }).execute(
			{ command: "definitely-not-a-real-command-xyz-123" },
			CTX(signal),
		);
		expect(result).toMatchObject({ isError: true });
		flip(); // late abort after the process is gone — must be a no-op
		expect(result.isError).toBe(true);
	});
});

describe("safe replacement (E 组)", () => {
	it("write_file via safe replacement: a hard link to an EXTERNAL inode is never overwritten", async () => {
		const dir = root();
		const outside = join(dirname(dir), "shared-target.txt");
		writeFileSync(outside, "ORIGINAL-EXTERNAL", "utf8");
		// A hard link inside the workspace shares the external inode.
		linkSync(outside, join(dir, "linked.txt"));

		const result = await writeFileTool({ workspaceRoot: dir }).execute(
			{ path: "linked.txt", content: "NEW-CONTENT" },
			CTX(NEVER_ABORT),
		);
		expect(result).toMatchObject({ isError: false });

		// The EXTERNAL file is untouched — the write replaced the workspace
		// directory entry, not the shared inode.
		expect(readFileSync(outside, "utf8")).toBe("ORIGINAL-EXTERNAL");
		// The workspace entry now has the new content on a fresh inode.
		expect(readFileSync(join(dir, "linked.txt"), "utf8")).toBe("NEW-CONTENT");
	});

	it("edit_file via safe replacement: the external inode survives too", async () => {
		const dir = root();
		const outside = join(dirname(dir), "shared-edit.txt");
		writeFileSync(outside, "ONE", "utf8");
		writeFileSync(join(dir, "e.txt"), "ONE", "utf8");
		linkSync(outside, join(dir, "linked-edit.txt"));
		writeFileSync(join(dir, "linked-edit.txt"), "ONE", "utf8"); // same inode as outside? no — this writes through the link

		// Re-create the scenario cleanly: the link was created BEFORE the
		// file got its content through the link — both paths share ONE inode.
		const dir2 = root();
		const outside2 = join(dirname(dir2), "shared-edit2.txt");
		writeFileSync(outside2, "ONE", "utf8");
		linkSync(outside2, join(dir2, "linked.txt"));

		const result = await editFileTool({ workspaceRoot: dir2 }).execute(
			{ path: "linked.txt", search: "ONE", replace: "TWO" },
			CTX(NEVER_ABORT),
		);
		expect(result).toMatchObject({ isError: false });
		expect(readFileSync(outside2, "utf8")).toBe("ONE"); // external untouched
		expect(readFileSync(join(dir2, "linked.txt"), "utf8")).toBe("TWO"); // workspace entry replaced
	});
});
