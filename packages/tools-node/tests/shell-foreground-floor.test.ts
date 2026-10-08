/**
 * ADR-0058 Amendment 10 — the foreground wait has a floor. With tasks
 * wired, a wait shorter than the floor only moves a command to the
 * background sooner, so the model may lengthen the wait but never shorten
 * it: the wait is max(foregroundMs, floor), and the floor is the default,
 * 60 s. A host may lower it (`limits.minForegroundMs`, 0 = today's
 * behaviour). Without tasks the wait is a kill timeout and is kept as
 * asked. The person is never held by it: ctrl+b still moves the command
 * at once.
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

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
	return { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, sessionId: "s1", executionId: "ex-1", ...extra } as unknown as ToolContext;
}

function setup(minForegroundMs?: number) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-fgfloor-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	const manager = new TaskManager({ root: join(base, "s1.tasks"), backend, pollMs: 50 });
	const opts = {
		workspaceRoot: cwd,
		tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined),
		...(minForegroundMs !== undefined ? { limits: { minForegroundMs } } : {}),
	};
	return { manager, shell: shellTool(opts) };
}

describe("ADR-0058 Amendment 10 — a short wait is raised to the floor", () => {
	it("a wait under the floor no longer promotes: the command's own result comes back in the same call", async () => {
		const { manager, shell } = setup(1_500);
		const r = await shell.execute({ command: "sleep 1; echo done", foregroundMs: 300 }, ctx());
		expect(r).toMatchObject({ isError: false });
		expect(String(r.content)).toContain("done");
		expect(String(r.content)).not.toMatch(/background task/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("with no option the floor is the default: a 300 ms wait on a 1 s command returns its result", async () => {
		const { manager, shell } = setup();
		const r = await shell.execute({ command: "sleep 1; echo done", foregroundMs: 300 }, ctx());
		expect(String(r.content)).toContain("done");
		expect(String(r.content)).not.toMatch(/background task/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("a command outliving the floor is promoted at the floor, and the result names the wait that happened", async () => {
		const { manager, shell } = setup(1_500);
		const r = await shell.execute({ command: "sleep 30", foregroundMs: 400 }, ctx());
		expect(String(r.content)).toMatch(/^still running after 1500 ?ms; continued as background task t1/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("background with readyWhen waits for its ready line up to the floor", async () => {
		const { manager, shell } = setup(5_000);
		const r = await shell.execute({ command: "sleep 1; echo up; sleep 30", background: true, readyWhen: "up", foregroundMs: 200 }, ctx());
		expect(String(r.content)).toMatch(/^started background task t1; ready — the output contains "up"/);
		await manager.stopAll();
		manager.close();
	}, 20_000);
});

describe("ADR-0058 Amendment 10 — what the floor does not touch", () => {
	it("a longer wait still wins: the model may lengthen the wait", async () => {
		const { manager, shell } = setup(500);
		const r = await shell.execute({ command: "sleep 1.5; echo done", foregroundMs: 3_000 }, ctx());
		expect(String(r.content)).toContain("done");
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("a host that opts out (floor 0) promotes at the requested wait, as before", async () => {
		const { manager, shell } = setup(0);
		const r = await shell.execute({ command: "sleep 30", foregroundMs: 300 }, ctx());
		expect(String(r.content)).toMatch(/^still running after 300 ?ms; continued as background task t1/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("the person is never held: ctrl+b moves the command at once, under any floor", async () => {
		const { manager, shell } = setup(10_000);
		const t0 = Date.now();
		const pending = shell.execute({ command: "sleep 30", foregroundMs: 300 }, ctx({ executionId: "ex-cb" } as Partial<ToolContext>));
		await new Promise((r) => setTimeout(r, 500));
		expect(manager.detach("ex-cb", "person")).toBe(true);
		const r = await pending;
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(String(r.content)).toMatch(/^moved to the background by the person; continued as background task t1/);
		await manager.stopAll();
		manager.close();
	}, 20_000);

	it("without tasks the wait is a kill timeout, kept as asked", async () => {
		const shell = shellTool({ workspaceRoot: realpathSync(mkdtempSync(join(tmpdir(), "kiso-fgfloor-nt-"))) });
		const r = await shell.execute({ command: "sleep 3", timeoutMs: 300 }, ctx());
		expect(r).toMatchObject({ isError: true });
		expect(String(r.content)).toMatch(/^shell timed out after 300ms/);
	}, 20_000);
});
