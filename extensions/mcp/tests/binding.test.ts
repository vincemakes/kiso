/**
 * Tool binding at the bridge: every tool carries a digest of its contract (server, name, input schema),
 * and `liveDigest(name)` re-asks the SERVER what the tool is now, so a program can refuse a call whose
 * contract changed after the program was admitted. A digest proves the declaration is unchanged; it
 * cannot prove the server's behaviour is (stated in kiso-doc/design-tool-binding-2026-10-10.md).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import createMcpExtension from "../dist/kiso-mcp.mjs";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "bench", "mcp-ptc", "server.mjs");
async function until(test: () => boolean, ms: number): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 20)); } return test(); }

describe("MCP bridge: tool digests", () => {
	it("every server tool has a stable digest; a changed schema changes it; liveDigest sees the change the cached tool cannot", async () => {
		const ext = await createMcpExtension({ servers: { studio: { command: process.execPath, args: [SERVER], env: { MCP_TOOLS: "13", MCP_DRIFT_AFTER: "1" } } } });
		try {
			expect(await until(() => ext.connecting !== true && (ext.tools ?? []).length > 5, 10000)).toBe(true);
			const tool = (n: string) => (ext.tools as { name: string; digest?: string; execute: (i: unknown, c: unknown) => Promise<unknown> }[]).find((t) => t.name === `mcp__studio__${n}`)!;
			const before = tool("add_subject").digest;
			expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(tool("create_project").digest).not.toBe(before);
			expect(await ext.liveDigest("mcp__studio__add_subject")).toBe(before); // nothing changed yet
			await tool("create_project").execute({ name: "x", budget_credits: 10 }, { signal: new AbortController().signal }); // 1st call: the drift trigger
			await tool("create_project").execute({ name: "y", budget_credits: 10 }, { signal: new AbortController().signal }); // drift happens on the call after the 1st
			expect(await ext.liveDigest("mcp__studio__add_subject")).not.toBe(before); // the server now says something else
			expect(await ext.liveDigest("mcp__studio__create_project")).toBe(tool("create_project").digest); // unrelated tools unchanged
			expect(tool("add_subject").digest).toBe(before); // the bridge's own copy is the admitted one
			expect(await ext.liveDigest("mcp__nobody__x")).toBeUndefined();
		} finally { await ext.dispose?.(); }
	}, 30_000);
});
