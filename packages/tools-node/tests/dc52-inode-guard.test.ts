/**
 * DC-52 — the inode guard ran a FULL-ROOT `find` per multi-link file,
 * synchronously, with its stderr wired to the terminal.
 *
 * The owner started kiso in `~`. The model issued three parallel
 * `search_text` calls; two settled in half a second and the third never
 * finished. Eight minutes later the process table still held
 *
 *     find /Users/vinve -xdev -inum 2899861 -print0
 *
 * under kiso's own pid, on the same tty, in the foreground process
 * group — and the terminal was filling with `find: …: Operation not
 * permitted`. No shell tool was ever called; the session log has none.
 *
 * Three faults, one line of code:
 *
 *   1. `execFileSync` with no `stdio` gives the child the PARENT'S
 *      stderr, which is the terminal — straight past the compositor's
 *      frame, over the composer.
 *   2. The scan is unbounded AND synchronous. With the workspace root at
 *      `~` one call is tens of seconds, one per multi-link file, and the
 *      event loop is frozen throughout — which is why `esc` did nothing
 *      and the `thinking…` row sat there: the whole process was stopped.
 *   3. A directory the OS refuses (TCC, `~/Library/Accounts`) threw out
 *      of the walk and failed the entire tool, where an unreadable FILE
 *      is merely skipped.
 *
 * The ruling: **search_text does not run the guard at all.** A search
 * returns a 160-character excerpt of a line; a disk traversal to decide
 * whether it may is not a trade anyone would make. Multi-link files are
 * skipped and counted, which is fail-closed at zero cost. read_file
 * keeps the guard, bounded and asynchronous.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, searchTextTool } from "../src/index.js";

const ctx = {} as never;

/** A workspace with the two shapes that broke: a HARD-LINKED file, and
 *  a directory the process may not read. */
/** A 0o000 directory outlives the test: the run's TMPDIR teardown
 *  cannot remove it and the whole suite dies at cleanup. Every locked
 *  directory is registered and unlocked when the file is done. */
const locked: string[] = [];
afterAll(() => {
	for (const d of locked) {
		try {
			chmodSync(d, 0o755);
		} catch {
			// already gone — nothing to restore
		}
	}
});

function workspace(): { root: string; denied: string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-dc52-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "plain.ts"), "const NEEDLE = 1;\n", "utf8");
	writeFileSync(join(root, "src", "linked.ts"), "const NEEDLE = 2;\n", "utf8");
	linkSync(join(root, "src", "linked.ts"), join(root, "src", "alias.ts"));
	const denied = join(root, "locked");
	mkdirSync(denied, { recursive: true });
	writeFileSync(join(denied, "inside.ts"), "const NEEDLE = 3;\n", "utf8");
	chmodSync(denied, 0o000);
	locked.push(denied);
	return { root, denied };
}

/** Everything the process writes to its own stderr while `fn` runs —
 *  the surface the `find:` noise arrived on. A child that inherits the
 *  fd bypasses this, so the PTY leg is what proves the whole claim; this
 *  proves the half that is observable in-process. */
async function capturingStderr<T>(fn: () => Promise<T>): Promise<{ out: T; stderr: string }> {
	const real = process.stderr.write.bind(process.stderr);
	let seen = "";
	(process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
		seen += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	try {
		return { out: await fn(), stderr: seen };
	} finally {
		(process.stderr as { write: unknown }).write = real;
	}
}

describe("DC-52 — search_text is bounded, quiet, and survives a locked directory", () => {
	it("a hard-linked file does not cost a disk traversal — it is skipped and COUNTED", async () => {
		const { root } = workspace();
		const started = Date.now();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "NEEDLE" }, ctx);
		const took = Date.now() - started;
		expect(out.isError, out.content).toBe(false);
		// the plain file is found; the linked pair is not searched
		expect(out.content).toContain("plain.ts");
		expect(out.content, "the multi-link file was searched anyway").not.toContain("linked.ts");
		expect(out.content, "the skip is silent — the model cannot tell it was incomplete").toMatch(/multi-link files? skipped/);
		// the guard's own scan took tens of seconds on the owner's machine;
		// a search over four small files must not be near that
		expect(took, `the search took ${took}ms — the traversal is still there`).toBeLessThan(3000);
	});

	it("a directory the OS refuses is SKIPPED and counted — it does not fail the tool", async () => {
		const { root } = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "NEEDLE" }, ctx);
		expect(out.isError, "an unreadable directory failed the whole search").toBe(false);
		expect(out.content).toContain("plain.ts");
		expect(out.content, "the unreadable directory is not accounted for").toMatch(/unreadable director/);
	});

	it("NOTHING reaches the process's own stderr — the terminal is the compositor's", async () => {
		const { root } = workspace();
		const { out, stderr } = await capturingStderr(() => searchTextTool({ workspaceRoot: root }).execute({ pattern: "NEEDLE" }, ctx));
		expect(out.isError).toBe(false);
		expect(stderr, `the search wrote to stderr: ${JSON.stringify(stderr.slice(0, 200))}`).toBe("");
	});
});

describe("DC-52 — read_file keeps the guard, bounded", () => {
	it("a hard-linked file is refused, and the refusal arrives promptly", async () => {
		const { root } = workspace();
		const started = Date.now();
		const out = await readFileTool({ workspaceRoot: root }).execute({ path: "src/linked.ts" }, ctx);
		const took = Date.now() - started;
		// fail-closed is unchanged: two links, one of them inside, and the
		// guard cannot prove the other is too within its budget.
		expect(out.content).toMatch(/hard links|refusing to read/);
		expect(took, `the guard took ${took}ms — it is meant to be bounded`).toBeLessThan(5000);
	});

	it("…and an ordinary file is read, with nothing on stderr", async () => {
		const { root } = workspace();
		const { out, stderr } = await capturingStderr(() => readFileTool({ workspaceRoot: root }).execute({ path: "src/plain.ts" }, ctx));
		expect(out.content).toContain("NEEDLE");
		expect(stderr).toBe("");
	});
});
