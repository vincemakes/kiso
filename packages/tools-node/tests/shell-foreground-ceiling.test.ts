/**
 * ADR-0058 Amendment 15 — the foreground wait has a ceiling. With tasks
 * wired, a wait longer than the ceiling only holds the turn: the command
 * is promoted to a task there, never killed, and the model is notified
 * when it ends. The wait is min(max(foregroundMs, floor), max(ceiling,
 * floor)); the ceiling defaults to 5 min. A host may change it
 * (`limits.maxForegroundMs`, 0 = the model's value as asked). Without
 * tasks the wait is a kill timeout and is kept as asked.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "../src/process-backend.js";
import { shellTool } from "../src/index.js";

const RUNNER = fileURLToPath(new URL("../dist/task-runner.js", import.meta.url));
const backend = processTaskBackend({ runnerPath: RUNNER });

function ctx(): ToolContext {
	return { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, sessionId: "s1", executionId: "ex-1" } as unknown as ToolContext;
}

function setup(limits: { minForegroundMs?: number; maxForegroundMs?: number }) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-fgceil-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
	const shell = shellTool({ workspaceRoot: cwd, tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined), limits });
	return { manager, shell };
}

describe("ADR-0058 Amendment 15 — a long wait is lowered to the ceiling", () => {
	it("a 30-minute wait on a long command promotes at the ceiling, and the result names the wait that happened", async () => {
		const { manager, shell } = setup({ minForegroundMs: 0, maxForegroundMs: 800 });
		const t0 = Date.now();
		const r = await shell.execute({ command: "sleep 30", foregroundMs: 1_800_000 }, ctx());
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(String(r.content)).toMatch(/^still running after 800 ?ms; continued as background task t1 \(not killed/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("the deprecated timeoutMs is lowered the same way", async () => {
		const { manager, shell } = setup({ minForegroundMs: 0, maxForegroundMs: 800 });
		const r = await shell.execute({ command: "sleep 30", timeoutMs: 1_800_000 }, ctx());
		expect(String(r.content)).toMatch(/^still running after 800 ?ms; continued as background task t1/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("background with readyWhen waits for its ready line no longer than the ceiling", async () => {
		const { manager, shell } = setup({ minForegroundMs: 0, maxForegroundMs: 800 });
		const t0 = Date.now();
		const r = await shell.execute({ command: "sleep 30", background: true, readyWhen: "up", foregroundMs: 1_800_000 }, ctx());
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(String(r.content)).toMatch(/^not ready after 800 ms — no "up" in the output yet; it keeps running as background task t1/);
		await manager.stopAll();
		manager.close();
	}, 20_000);
});

describe("ADR-0058 Amendment 15 — what the ceiling does not touch", () => {
	it("a command that ends under the ceiling returns its own result", async () => {
		const { manager, shell } = setup({ minForegroundMs: 0, maxForegroundMs: 3_000 });
		const r = await shell.execute({ command: "sleep 0.5; echo done", foregroundMs: 1_800_000 }, ctx());
		expect(String(r.content)).toContain("done");
		expect(String(r.content)).not.toMatch(/background task/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("the ceiling never goes below the floor: a host's floor wins", async () => {
		const { manager, shell } = setup({ minForegroundMs: 2_500, maxForegroundMs: 300 });
		const r = await shell.execute({ command: "sleep 1; echo done", foregroundMs: 1_800_000 }, ctx());
		expect(String(r.content)).toContain("done");
		expect(String(r.content)).not.toMatch(/background task/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("a host that opts out (ceiling 0) waits as asked, as before", async () => {
		const { manager, shell } = setup({ minForegroundMs: 0, maxForegroundMs: 0 });
		const r = await shell.execute({ command: "sleep 1.5; echo done", foregroundMs: 3_000 }, ctx());
		expect(String(r.content)).toContain("done");
		expect(String(r.content)).not.toMatch(/background task/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("without tasks the wait is a kill timeout, kept as asked (no ceiling)", async () => {
		const shell = shellTool({ workspaceRoot: realpathSync(mkdtempSync(join(tmpdir(), "kiso-fgceil-nt-"))), limits: { maxForegroundMs: 300 } });
		const r = await shell.execute({ command: "sleep 1; echo done", timeoutMs: 3_000 }, ctx());
		expect(r).toMatchObject({ isError: false });
		expect(String(r.content)).toContain("done");
	}, 20_000);
});
