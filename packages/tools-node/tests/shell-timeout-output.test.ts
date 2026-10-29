/**
 * A timeout or an abort carries the output captured so far, under the normal
 * caps and truncation notes. The verdict used to be the bare "shell timed out
 * after Nms": whatever the command had already printed was dropped, though it
 * had been captured. The uncertain-side-effect wording is unchanged and comes
 * first; the output follows.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { shellTool } from "../src/index.js";

function ctx(signal?: AbortSignal): ToolContext {
	const s = signal ?? { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
	return { signal: s, sessionId: "s1", executionId: "ex-1" } as unknown as ToolContext;
}
function setup() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-timeout-out-")));
	const cwd = join(base, "ws");
	mkdirSync(cwd);
	return shellTool({ workspaceRoot: cwd });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a timeout and an abort carry the output captured so far", () => {
	it("a genuine hang: the timeout names what the command printed before it stalled, stderr included", async () => {
		const shell = setup();
		const r = await shell.execute({ command: "echo partial-out; echo partial-err >&2; sleep 30", timeoutMs: 800 }, ctx());
		expect(r.isError).toBe(true);
		const text = String(r.content);
		expect(text).toMatch(/^shell timed out after 800ms/);
		expect(text).toContain("partial-out");
		expect(text).toContain("[stderr] partial-err");
	}, 20_000);

	it("an abort carries it too", async () => {
		const shell = setup();
		const ac = new AbortController();
		const pending = shell.execute({ command: "echo before-abort; sleep 30", timeoutMs: 20_000 }, ctx(ac.signal));
		await sleep(600);
		ac.abort();
		const r = await pending;
		expect(String(r.content)).toMatch(/^shell aborted/);
		expect(String(r.content)).toContain("before-abort");
	}, 20_000);

	it("the output cap and its truncation note survive the timeout verdict", async () => {
		const shell = setup();
		const r = await shell.execute({ command: "head -c 150000 /dev/zero | tr '\\0' x; sleep 30", timeoutMs: 1_500 }, ctx());
		const text = String(r.content);
		expect(text).toMatch(/^shell timed out after 1500ms/);
		expect(text).toMatch(/stdout capped at 100000 chars — \d+ more chars dropped/);
		expect(text.length).toBeLessThan(101_000 + 600);
	}, 20_000);

	it("a timeout with nothing printed is the old message, byte for byte", async () => {
		const shell = setup();
		const r = await shell.execute({ command: "sleep 30", timeoutMs: 600 }, ctx());
		expect(r.content).toBe("shell timed out after 600ms");
	}, 20_000);
});
