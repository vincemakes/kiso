/**
 * round 3 — user rewrite/veto end to end.
 *
 * 1. user_input_replaced is a NORMAL stream event: yielded, durable, and
 *    never a seq gap.
 * 2. After a rewrite, the provider sees ONLY the replacement from the
 *    first to the last turn; the original is never visible.
 * 3. The hook's returned message keeps its `source`.
 * 4. A veto terminates the run — the provider is NEVER called, even when
 *    history exists.
 * 5. All three layers: the raw core loop, a real AgentSession, and a
 *    reload from disk.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { EventLog, loop, projectMessages } from "../src/index.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";

const TOOL_TURN: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function seenAdapter(seen: Message[][], script: FauxScript): Adapter {
	const base = createFauxProvider(script);
	return {
		stream: (opts) => {
			seen.push([...opts.messages]);
			return base.stream(opts);
		},
	};
}

const registryWith = () => {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "web_search",
			description: "S",
			parameters: { type: "object" },
			execute: async () => ({ content: "ok", isError: false }),
		}),
	);
	return registry;
};

describe("raw core loop (round 3)", () => {
	it("user_input_replaced is a yielded, durable, gapless stream event", async () => {
		const log = new EventLog();
		const seen: Message[][] = [];
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: seenAdapter(seen, TOOL_TURN),
			model: "faux",
			registry: registryWith(),
			log,
			messages: [{ role: "user", content: "original" }],
			hooks: {
				onUserMessage: async (msg) => ({ ...msg, content: "replaced", source: "suggestion" as const }),
			},
		})) {
			events.push(ev);
		}
		const replaced = events.filter((e) => e.type === "user_input_replaced");
		expect(replaced).toHaveLength(1);
		// gapless seq: the replaced event's seq is exactly one after the seed.
		expect((replaced[0] as { seq: number }).seq).toBe(1);
		// the provider never saw the original — from the FIRST call on.
		for (const messages of seen) {
			const userTexts = messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);
			expect(userTexts).not.toContain("original");
			expect(userTexts).toContain("replaced");
		}
	});

	it("the hook's returned source is preserved through the projection", async () => {
		const log = new EventLog();
		for await (const _ev of loop({
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: registryWith(),
			log,
			messages: [{ role: "user", content: "original" }],
			hooks: {
				onUserMessage: async (msg) => ({ ...msg, content: "replaced", source: "suggestion" as const }),
			},
		})) {
			// drain
		}
		const { projectMessages } = await import("../src/index.js");
		const projected = projectMessages(log.all);
		const user = projected.find((m) => m.role === "user") as { content: string; source?: string };
		expect(user.content).toBe("replaced");
		expect(user.source).toBe("suggestion");
	});

	it("a veto terminates the run — the provider is NEVER called, even with history", async () => {
		const log = new EventLog();
		const seen: Message[][] = [];
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: seenAdapter(seen, [{ events: [{ type: "stop", reason: "end_turn" }] }]),
			model: "faux",
			registry: registryWith(),
			log,
			messages: [
				{ role: "user", content: "history that exists" },
				{ role: "user", content: "vetoed input" },
			],
			hooks: {
				onUserMessage: async () => null, // veto the LAST message
			},
		})) {
			events.push(ev);
		}
		expect(seen).toHaveLength(0); // provider never called
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toMatchObject({ outcome: { kind: "completed" } });
	});
});

describe("AgentSession + reload (round 3)", () => {
	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rw-"));
		const store = new SessionStore(dir);
		const seen: Message[][] = [];
		const agent = createAgent({
			model: "faux",
			store,
			tools: [
				defineTool({
					name: "web_search",
					description: "S",
					parameters: { type: "object" },
					execute: async () => ({ content: "ok", isError: false }),
				}),
			],
			adapter: seenAdapter(seen, TOOL_TURN),
			hooks: {
				onUserMessage: async (msg) => ({ ...msg, content: "rewritten-by-hook", source: "suggestion" as const }),
			},
		});
		return { dir, store, seen, agent };
	}

	it("through a real session, every model call sees only the rewrite; the disk replay agrees", async () => {
		const { dir, store, seen, agent } = await setup();
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("ask something")) {
			// drain
		}
		for (const messages of seen) {
			const userTexts = messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);
			expect(userTexts).not.toContain("ask something");
			expect(userTexts).toContain("rewritten-by-hook");
		}
		store.closeAll();

		// Reload from disk: the replacement is durable and the projection
		// equals what the model saw.
		const store2 = new SessionStore(dir);
		const reloaded = await createAgent({
			model: "faux",
			store: store2,
			tools: [],
			adapter: createFauxProvider([]),
		}).session({ id: "s" });
		const user = reloaded.projected().find((m) => m.role === "user") as { content: string; source?: string };
		expect(user.content).toBe("rewritten-by-hook");
		expect(user.source).toBe("suggestion");
		// The original never made it to disk.
		expect(reloaded.projected().some((m) => m.role === "user" && (m as { content: string }).content === "ask something")).toBe(false);
	});

	it("round 5: a rewrite with ContentBlock[] content is a legal event — persisted and reloaded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rw-"));
		const store = new SessionStore(dir);
		const blocks: Message = {
			role: "user",
			content: [
				{ type: "text", text: "look at this:" },
				{ type: "image", sourceType: "base64", data: "cG5n", mediaType: "image/png" },
			],
		};
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
			hooks: {
				onUserMessage: async () => blocks,
			},
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("plain text in")) {
			// drain
		}
		store.closeAll();

		// The block content survived persistence (deep schema validation) and
		// reloads exactly.
		const store2 = new SessionStore(dir);
		const reloaded = await createAgent({
			model: "faux",
			store: store2,
			tools: [],
			adapter: createFauxProvider([]),
		}).session({ id: "s" });
		const user = reloaded.projected().find((m) => m.role === "user") as { content: unknown };
		expect(user.content).toEqual(blocks.content);
	});
});

describe("rewrite exactly-once across recovery (round 6)", () => {
	it("a replacement yielded then interrupted: reload + resume calls the hook ONCE and keeps ONE replacement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rw-"));
		let hookCalls = 0;
		const seen: Message[][] = [];
		const makeAgent = (store: SessionStore) =>
			createAgent({
				model: "faux",
				store,
				tools: [],
				adapter: seenAdapter(seen, [{ events: [{ type: "stop", reason: "end_turn" }] }]),
				hooks: {
					onUserMessage: async (msg) => {
						hookCalls += 1;
						return { ...msg, content: `rewrite-${hookCalls}`, source: "suggestion" as const };
					},
				},
			});

		// First process: consume until the replacement is YIELDED, then
		// abandon the run (a crash right after the replacement persisted,
		// before the provider was called).
		const store = new SessionStore(dir);
		const session = await makeAgent(store).session({ id: "s" });
		for await (const ev of session.run("original")) {
			if (ev.type === "user_input_replaced") break; // crash here
		}
		store.closeAll();
		expect(hookCalls).toBe(1);
		expect(new SessionStore(dir).load("s").filter((r) => r.event.type === "user_input_replaced")).toHaveLength(1);

		// Reload + resume: the hook must NOT run again, the provider must
		// see exactly one user message (the replacement), and the disk must
		// still hold exactly one replacement.
		const store2 = new SessionStore(dir);
		const session2 = await makeAgent(store2).session({ id: "s" });
		for await (const _ev of session2.resume()) {
			// drain
		}
		expect(hookCalls).toBe(1); // never re-invoked
		expect(new SessionStore(dir).load("s").filter((r) => r.event.type === "user_input_replaced")).toHaveLength(1);
		// The provider saw exactly one user message, the rewrite.
		expect(seen.length).toBeGreaterThan(0);
		for (const messages of seen) {
			const users = messages.filter((m) => m.role === "user");
			expect(users).toHaveLength(1);
			expect(users[0]!.content).toBe("rewrite-1");
		}
	});

	it("a veto crash before the terminal: resume does NOT call the hook or the provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rw-"));
		let hookCalls = 0;
		let providerCalls = 0;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [],
			adapter: {
				stream: (opts) => {
					providerCalls += 1;
					return createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]).stream(opts);
				},
			},
			hooks: {
				onUserMessage: async () => {
					hookCalls += 1;
					return null; // veto
				},
			},
		});
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("blocked")) {
			if (ev.type === "user_input_replaced") break; // crash before the terminal
		}
		expect(hookCalls).toBe(1);
		expect(providerCalls).toBe(0);

		const session2 = await agent.session({ id: "s" });
		for await (const _ev of session2.resume()) {
			// drain
		}
		// Neither the hook nor the provider ran again — the veto is durable.
		expect(hookCalls).toBe(1);
		expect(providerCalls).toBe(0);
	});

	it("the projection renders the FINAL replacement at the input's position — never one message per replacement", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "original" });
		log.append({ type: "user_input_replaced", replaces: 0, content: "first", source: "suggestion" });
		log.append({ type: "user_input_replaced", replaces: 0, content: "final", source: "suggestion" });
		const projected = projectMessages(log.all);
		const users = projected.filter((m) => m.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject({ content: "final", source: "suggestion" });
	});
});

	it("P1-7: a persisted veto with PRIOR history never calls the provider on resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rw-"));
		let providerCalls = 0;
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [],
			adapter: {
				stream: (opts) => {
					providerCalls += 1;
					return createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]).stream(opts);
				},
			},
			hooks: {
				onUserMessage: async (msg) =>
					(msg as { content: string }).content === "blocked"
						? null // veto the second input only
						: { ...msg, content: "rewritten-history", source: "suggestion" as const },
			},
		});
		// Round 1: normal history (rewritten), the run completes.
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("hello")) {
			// drain
		}
		expect(providerCalls).toBeGreaterThan(0);
		// Round 2: a veto, crash right after the replacement persisted.
		const session2 = await agent.session({ id: "s" });
		for await (const ev of session2.run("blocked")) {
			if (ev.type === "user_input_replaced") break;
		}
		expect(providerCalls).toBe(1); // the vetoed turn itself never called the provider
		// Resume: the persisted veto must hold — the provider is NOT called
		// again, despite the earlier history.
		const session3 = await agent.session({ id: "s" });
		for await (const _ev of session3.resume()) {
			// drain
		}
		expect(providerCalls).toBe(1);
		expect(new SessionStore(dir).load("s").some((r) => r.event.type === "terminal")).toBe(true);
	});
