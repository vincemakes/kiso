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
import { defineTool, type Adapter, type Event, type Message, type Tool, type UserMessage } from "@vincemakes/kiso-core";
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

const readTool = (name = "read_file"): Tool =>
	defineTool({
		name,
		description: "r",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "ok", isError: false }),
	});

describe("E1: AgentSession integration", () => {
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

	it("an extension's compaction config produces a microcompacted boundary event", async () => {
		// No session microcompact is set, so the FIRST extension providing a
		// compaction config supplies the loop's microcompact (keepResults: 1
		// keeps only the newest 1 compactable result — two big reads cross
		// the tiny threshold and the boundary fires on the second iteration).
		const dir = extDir();
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [defineTool({
				name: "read_file",
				description: "r",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "x".repeat(400), isError: false }),
			})],
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "a.ts" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "r2", name: "read_file", input: { path: "b.ts" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			extensions: [{ name: "compacter", compaction: { thresholdTokens: 50, keepResults: 1 } }],
		});
		const session = await agent.session({ id: "s-cmp" });
		const out: Event[] = [];
		for await (const ev of session.run("go")) out.push(ev);
		expect(out.some((e) => e.type === "microcompacted")).toBe(true); // yielded
		const boundary = session.log.all.find((e) => e.type === "microcompacted");
		expect(boundary).toBeDefined();
		expect(boundary).toMatchObject({ beforeSeq: expect.any(Number) });
	});
});

describe("裁决 A (E1 ask 语义修正): no extensions — the static policy still governs", () => {
	it("the CLI's static default deny for unknown tools is untouched — denial, never a pause", async () => {
		// 条款1 regression: with NO extension policies the static automated
		// policy (the CLI's PermissionPolicy shape: default deny) still
		// answers for tools without a rule — byte-for-byte the pre-ask-fix
		// behavior. The ask re-routing must not leak into extension-less runs.
		const dir = extDir();
		let paused = false;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [readTool()],
			permissionPolicy: { rules: [], default: "deny" }, // the CLI's unknown-tool shape
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "x" } }, { type: "stop", reason: "tool_use" }] },
			]),
			hooks: { onPause: async () => { paused = true; } },
		});
		const session = await agent.session({ id: "ruling-a1" });
		const out: Event[] = [];
		for await (const ev of session.run("go")) out.push(ev);
		const result = out.find((e) => e.type === "tool_result");
		expect(result?.content).toContain("[Permission denied] no policy rule for read_file");
		expect(out.some((e) => e.type === "permission_requested")).toBe(false); // never paused
		expect(paused).toBe(false);
		expect(out.some((e) => e.type === "permission_decided")).toBe(false); // the static hook writes no verdict event
	});
});

describe("E2 (收尾): extension systemPrompt appends", () => {
	/** A minimal adapter that captures the REQUEST it was given — the
	 *  systemPrompt is invisible in the CLI, so the runtime layer IS the
	 *  topmost entry for this surface (the spec's stated deviation). */
	const promptSpyAdapter = (onStream: (options: { systemPrompt?: string }) => void): Adapter => ({
		stream(options) {
			onStream(options);
			return (async function* () {
				yield { type: "stop", reason: "end_turn", seq: 0 };
			})();
		},
	});

	const promptOf = async (extensions: { name: string; append?: string }[]): Promise<string | undefined> => {
		let seen: string | undefined;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(extDir()),
			tools: [readTool()],
			systemPrompt: "BASE PROMPT",
			adapter: promptSpyAdapter((o) => {
				seen = o.systemPrompt;
			}),
			extensions: extensions.map((e) => (e.append === undefined ? { name: e.name } : { name: e.name, systemPrompt: { append: e.append } })),
		});
		const session = await agent.session({ id: "e2" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		return seen;
	};

	it("E2-1: a single extension's append lands at the END — the session's own prompt FIRST", async () => {
		expect(await promptOf([{ name: "ext", append: "EXT APPEND" }])).toBe("BASE PROMPT\n\nEXT APPEND");
	});

	it("E2-2: two extensions join in LOAD order, \\n\\n-separated", async () => {
		expect(await promptOf([{ name: "a", append: "A" }, { name: "b", append: "B" }])).toBe("BASE PROMPT\n\nA\n\nB");
	});

	it("E2-3: no appends — byte-identical to the extension-less prompt", async () => {
		expect(await promptOf([{ name: "quiet" }])).toBe("BASE PROMPT");
	});
});

describe("E1-P2 (复审): onUserMessage composes as a pipe with veto short-circuit", () => {
	/** A minimal adapter that records the messages it received (and whether it
	 *  was called at all) — the veto paths must never reach it. */
	const spyAdapter = (onStream: (messages: readonly Message[]) => void): Adapter => ({
		stream(options) {
			onStream(options.messages);
			return (async function* () {
				yield { type: "stop", reason: "end_turn", seq: 0 };
			})();
		},
	});

	const textOf = (msg: UserMessage | undefined): string | undefined =>
		msg !== undefined && typeof msg.content === "string" ? msg.content : undefined;

	it("P2-1: a veto short-circuits — a later extension's rewrite never swallows it", async () => {
		let providerCalled = false;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(extDir()),
			tools: [readTool()],
			adapter: spyAdapter(() => {
				providerCalled = true;
			}),
			extensions: [
				{ name: "vetoer", hooks: { onUserMessage: async () => null } },
				{ name: "rewriter", hooks: { onUserMessage: async (msg) => ({ ...msg, content: "rewritten" }) } },
			],
		});
		const session = await agent.session({ id: "p2-1" });
		const out: Event[] = [];
		for await (const ev of session.run("go")) out.push(ev);
		expect(providerCalled).toBe(false); // the veto ended the run before the model
		expect(out.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});

	it("P2-2: rewrites PIPE — each handler sees the message the previous one left", async () => {
		let seenBySecond: string | undefined;
		let modelSaw: string | undefined;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(extDir()),
			tools: [readTool()],
			adapter: spyAdapter((messages) => {
				modelSaw = textOf([...messages].reverse().find((m) => m.role === "user"));
			}),
			extensions: [
				{ name: "first", hooks: { onUserMessage: async (msg) => ({ ...msg, content: "ext1-says" }) } },
				{
					name: "second",
					hooks: {
						onUserMessage: async (msg) => {
							seenBySecond = textOf(msg);
							return msg;
						},
					},
				},
			],
		});
		const session = await agent.session({ id: "p2-2" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		expect(seenBySecond).toBe("ext1-says"); // the second handler saw the FIRST's rewrite
		expect(modelSaw).toBe("ext1-says"); // and that rewrite is what the model received
	});

	it("P2-3: the existing hook runs FIRST and its veto short-circuits every extension", async () => {
		let existingSeen: string | undefined;
		let extCalled = false;
		let providerCalled = false;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(extDir()),
			tools: [readTool()],
			adapter: spyAdapter(() => {
				providerCalled = true;
			}),
			hooks: {
				onUserMessage: async (msg) => {
					existingSeen = textOf(msg);
					return null; // the EXISTING hook vetoes
				},
			},
			extensions: [{ name: "ext", hooks: { onUserMessage: async () => { extCalled = true; return null; } } }],
		});
		const session = await agent.session({ id: "p2-3" });
		const out: Event[] = [];
		for await (const ev of session.run("go")) out.push(ev);
		expect(existingSeen).toBe("go"); // 既有先行 — the existing hook saw the original
		expect(extCalled).toBe(false); // the existing veto short-circuited the extension
		expect(providerCalled).toBe(false);
		expect(out.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});

	it("P2-4: a single extension handler still runs — never dropped", async () => {
		let modelSaw: string | undefined;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(extDir()),
			tools: [readTool()],
			adapter: spyAdapter((messages) => {
				modelSaw = textOf([...messages].reverse().find((m) => m.role === "user"));
			}),
			extensions: [{ name: "rewriter", hooks: { onUserMessage: async (msg) => ({ ...msg, content: "rewritten" }) } }],
		});
		const session = await agent.session({ id: "p2-4" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		expect(modelSaw).toBe("rewritten"); // the single handler's rewrite reached the model
	});
});
