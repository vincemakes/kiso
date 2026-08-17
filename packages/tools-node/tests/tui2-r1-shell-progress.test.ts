/**
 * TUI2-R1 slice ④ — T-V3 (the writer half): the shell progress sidecar.
 *
 * The ① probe established that the tool contract has no incremental
 * channel and cannot be given one this round. The sidecar is the
 * observation-only answer, and its whole safety argument is that it is
 * NOT durable state:
 *
 *   - it lives in the OS temp dir, never under KISO_HOME. Recovery reads
 *     the event log and nothing else; a file the store has never heard
 *     of cannot change a recovery plan.
 *   - it is removed at settle — success, failure, timeout or abort.
 *   - every write and every removal is best-effort: a full disk, a
 *     read-only temp dir, a racing remover — none of them may cost the
 *     command its result. A degraded sidecar costs exactly one thing:
 *     the tail is not shown.
 *   - the key is DERIVED (sessionId + command), because the executionId
 *     is not reachable from inside a tool (finding ①c).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_PROGRESS_DIR, shellProgressPath, shellTool } from "../src/index.js";

const tool = shellTool({ workspaceRoot: process.cwd() });
const ctx = (sessionId?: string): { signal: AbortSignal; sessionId?: string } => ({
	signal: new AbortController().signal,
	...(sessionId === undefined ? {} : { sessionId }),
});

afterEach(() => {
	rmSync(SHELL_PROGRESS_DIR, { recursive: true, force: true });
});

describe("TUI2-R1 T-V3 — the shell progress sidecar (the writer)", () => {
	it("the key is derived from sessionId + command, and the file lives OUTSIDE the session store", () => {
		const a = shellProgressPath("s1", "npm test");
		const b = shellProgressPath("s1", "npm test");
		const c = shellProgressPath("s2", "npm test");
		const d = shellProgressPath("s1", "npm run build");
		expect(a).toBe(b); // both sides derive the same path from the same facts
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
		expect(dirname(a)).toBe(SHELL_PROGRESS_DIR);
		expect(SHELL_PROGRESS_DIR.startsWith(tmpdir())).toBe(true);
		// the key is a digest — a command with slashes never becomes a path
		expect(shellProgressPath("s1", "cat ../../etc/passwd")).toMatch(/[0-9a-f]{16}\.log$/);
	});

	it("output APPEARS in the sidecar while the command runs, and the file is GONE at settle", async () => {
		const command = "printf 'first\\n'; sleep 0.5; printf 'second\\n'";
		const path = shellProgressPath("s-live", command);
		const call = tool.execute({ command }, ctx("s-live"));
		await new Promise((r) => setTimeout(r, 250));
		// mid-run: the first line is observable — this is the whole feature
		expect(existsSync(path), "the sidecar exists mid-run").toBe(true);
		const mid = readFileSync(path, "utf8");
		expect(mid).toContain("first");
		expect(mid).not.toContain("second");
		const result = await call;
		expect(result.isError).toBe(false);
		// settled: the observation file is gone, the RESULT carries it all
		expect(existsSync(path), "the sidecar is removed at settle").toBe(false);
		expect(result.content).toContain("first");
		expect(result.content).toContain("second");
	});

	it("a FAILING command removes its sidecar too — settle is settle, whatever the verdict", async () => {
		const command = "printf 'partial\\n'; exit 3";
		const path = shellProgressPath("s-fail", command);
		const result = await tool.execute({ command }, ctx("s-fail"));
		expect(result.isError).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("a TIMED-OUT command removes its sidecar too", async () => {
		const command = "printf 'starting\\n'; sleep 5";
		const path = shellProgressPath("s-timeout", command);
		const result = await tool.execute({ command, timeoutMs: 300 }, ctx("s-timeout"));
		expect(result.isError).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("a STALE sidecar from a killed run is overwritten, never appended to — a kill -9 leftover cannot resurface", async () => {
		const command = "printf 'fresh\\n'";
		const path = shellProgressPath("s-stale", command);
		mkdirSync(SHELL_PROGRESS_DIR, { recursive: true });
		writeFileSync(path, "GHOST FROM A KILLED RUN\n", "utf8");
		const call = tool.execute({ command }, ctx("s-stale"));
		await call;
		expect(existsSync(path)).toBe(false);
		// and during the run it never carried the ghost: the writer clears
		// the file before the first chunk (asserted by re-running with a
		// slow command so the mid-run read is observable)
		const slow = "printf 'fresh\\n'; sleep 0.4";
		const slowPath = shellProgressPath("s-stale", slow);
		mkdirSync(SHELL_PROGRESS_DIR, { recursive: true });
		writeFileSync(slowPath, "GHOST FROM A KILLED RUN\n", "utf8");
		const running = tool.execute({ command: slow }, ctx("s-stale"));
		await new Promise((r) => setTimeout(r, 200));
		expect(readFileSync(slowPath, "utf8")).not.toContain("GHOST");
		await running;
	});

	it("a DEGRADED sidecar never costs the command its result — an unwritable dir is silent", async () => {
		// the sidecar dir replaced by a FILE: every mkdir/append throws
		rmSync(SHELL_PROGRESS_DIR, { recursive: true, force: true });
		mkdirSync(dirname(SHELL_PROGRESS_DIR), { recursive: true });
		writeFileSync(SHELL_PROGRESS_DIR, "not a directory", "utf8");
		try {
			const result = await tool.execute({ command: "printf 'still works\\n'" }, ctx("s-degraded"));
			expect(result.isError).toBe(false);
			expect(result.content).toContain("still works");
		} finally {
			rmSync(SHELL_PROGRESS_DIR, { force: true });
		}
	});

	it("a session-less call still works — the key degrades, the command does not", async () => {
		const result = await tool.execute({ command: "printf 'anon\\n'" }, ctx());
		expect(result.isError).toBe(false);
		expect(result.content).toContain("anon");
		expect(existsSync(join(SHELL_PROGRESS_DIR, "nothing.log"))).toBe(false);
	});
});
