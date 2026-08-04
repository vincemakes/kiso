/**
 * E1 — the runtime's extension layer: loadExtensions + AgentSession
 * integration.
 *
 * The loader imports each *.mjs file's default export (an extension or a
 * factory) and fails LOUDLY on a bad file or a duplicate name — the file
 * names appear in the error. AgentSession config accepts extensions: their
 * tools join the registry (a collision with a built-in name is a startup
 * error at agent creation), their hooks compose AFTER the agent's own
 * (既有先行), and their approvals enter the loop's policy chain.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import { createAgent, loadExtensions, SessionStore } from "../src/index.js";

function extDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ext-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeExt(dir: string, file: string, content: string): string {
	const path = join(dir, file);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("E1: loadExtensions", () => {
	it("an absent directory is the normal no-extensions case — []", async () => {
		expect(await loadExtensions(join(tmpdir(), "kiso-no-such-dir-xyz"))).toEqual([]);
	});

	it("loads every *.mjs file's default export, sorted by name", async () => {
		const dir = extDir();
		writeExt(dir, "b.mjs", `export default { name: "bee", approvals: [{ decide: () => ({ action: "ask" }) }] };`);
		writeExt(dir, "a.mjs", `export default { name: "aye" };`);
		const exts = await loadExtensions(dir);
		expect(exts.map((e) => e.name)).toEqual(["aye", "bee"]);
	});

	it("accepts a factory default export", async () => {
		const dir = extDir();
		writeExt(dir, "f.mjs", `export default () => ({ name: "factory" });`);
		expect((await loadExtensions(dir))[0]?.name).toBe("factory");
	});

	it("a bad file fails LOUDLY with the file name", async () => {
		const dir = extDir();
		writeExt(dir, "broken.mjs", `export default 42;`);
		await expect(loadExtensions(dir)).rejects.toThrow(/broken\.mjs/);
	});

	it("a syntax-broken file fails LOUDLY with the file name", async () => {
		const dir = extDir();
		writeExt(dir, "oops.mjs", `export default { name: `);
		await expect(loadExtensions(dir)).rejects.toThrow(/oops\.mjs/);
	});

	it("a duplicate extension name fails LOUDLY listing the names", async () => {
		const dir = extDir();
		writeExt(dir, "one.mjs", `export default { name: "dup" };`);
		writeExt(dir, "two.mjs", `export default { name: "dup" };`);
		await expect(loadExtensions(dir)).rejects.toThrow(/duplicate extension name "dup"/);
	});
});

describe("E1: AgentSession integration", () => {
	const readTool = (name = "read_file"): Tool =>
		defineTool({
			name,
			description: "r",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "ok", isError: false }),
		});

	it("extension tools join the registry and are callable; a built-in collision is a startup error", async () => {
		const dir = extDir();
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [readTool()],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "x1", name: "ext_tool", input: {} }, { type: "stop", reason: "tool_use" }] },
			]),
			extensions: [
				{
					name: "ext",
					tools: [defineTool({
						name: "ext_tool",
						description: "e",
						parameters: { type: "object", properties: {} },
						execute: async () => ({ content: "from-ext", isError: false }),
					})],
				},
			],
		});
		const session = await agent.session({ id: "s1" });
		const out: Event[] = [];
		for await (const ev of session.run("go")) out.push(ev);
		expect(out.some((e) => e.type === "tool_result" && e.content === "from-ext")).toBe(true);

		// A collision with a built-in tool name is rejected at agent creation.
		expect(
			() =>
				createAgent({
					model: "faux",
					store: new SessionStore(extDir()),
					tools: [readTool()],
					extensions: [{ name: "clash", tools: [readTool("read_file")] }],
				}),
		).toThrow(/already registered: read_file/i);
	});

	it("extension hooks compose AFTER the agent's own (既有先行)", async () => {
		const order: string[] = [];
		const dir = extDir();
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [readTool()],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			hooks: { onEvent: async () => { order.push("existing"); } },
			extensions: [{ name: "ext", hooks: { onEvent: async () => { order.push("ext"); } } }],
		});
		const session = await agent.session({ id: "s2" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		// For every observed event the existing hook runs FIRST.
		expect(order.slice(0, 4)).toEqual(["existing", "ext", "existing", "ext"]);
	});

	it("extension approvals enter the policy chain — a deny is recorded with decidedBy = the extension", async () => {
		const dir = extDir();
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [readTool()],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "s1", name: "read_file", input: { path: "x" } }, { type: "stop", reason: "tool_use" }] },
			]),
			extensions: [
				{
					name: "no-reads",
					approvals: [{ decide: () => ({ action: "deny", reason: "reads not allowed" }) }],
				},
			],
		});
		const session = await agent.session({ id: "s3" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		const decided = session.log.all.find((e) => e.type === "permission_decided");
		expect(decided).toMatchObject({ decision: "denied", reason: "reads not allowed", decidedBy: "no-reads" });
	});
});
