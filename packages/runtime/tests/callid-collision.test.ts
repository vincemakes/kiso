/**
 * AUDIT (event protocol): a child's call id is `<parent>/<n>`, and the runtime used to decide "this execution is a child" by looking at that
 * STRING. A provider is free to issue an id that contains a slash. A model-issued call whose id happens to be `<some call>/<n>` was taken for a
 * child, so a human ruling on it wrote no model-facing result: a dangling tool_use. The explicit `parent` link now decides.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Tool } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const tools = (): Tool[] => [
	defineTool({ name: "pay", description: "p", parameters: { type: "object", properties: {} }, effects: { concurrency: "shared" }, execute: async () => ({ content: "paid", isError: false }) }),
	defineTool({ name: "send", description: "s", parameters: { type: "object", properties: {} }, effects: { concurrency: "shared" }, execute: async () => ({ content: "sent", isError: false }) }),
] as unknown as Tool[];

describe("a provider call id with a slash is not a child", () => {
	it("two model-issued calls `c` and `c/1`, both started and not receipted: ruling on `c/1` still answers the model's call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collide-"));
		const adapter = createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "c", name: "pay", input: {} }, { type: "tool_call_end", callId: "c/1", name: "send", input: {} }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
		]);
		const s = await createAgent({ model: "faux", adapter, tools: tools(), store: new SessionStore(dir) }).session({ id: "s" });
		for await (const _ of s.run("go")) { /* */ }
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!;
		const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
		// crash: cut right after the SECOND started (both started, neither receipted)
		const idx: number[] = []; lines.forEach((l, i) => { if (l.includes('"tool_execution_started"')) idx.push(i); });
		expect(idx.length).toBe(2);
		const crashed = mkdtempSync(join(tmpdir(), "collide-crash-")); mkdirSync(crashed, { recursive: true });
		writeFileSync(join(crashed, file), `${lines.slice(0, idx[1]! + 1).join("\n")}\n`);
		const r = await createAgent({ model: "faux", adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), tools: tools(), store: new SessionStore(crashed) }).session({ id: "s" });
		const un = r.uncertainExecutions();
		expect(un.map((u) => u.callId).sort()).toEqual(["c", "c/1"]);
		// neither is a child of the other: each can be ruled on alone, and each ruling answers its own tool_use
		await r.resolveUncertain(un.find((u) => u.callId === "c/1")!.executionId, "abandoned");
		await r.resolveUncertain(un.find((u) => u.callId === "c")!.executionId, "abandoned");
		const answered = (id: string) => r.log.all.some((e) => e.type === "tool_result" && (e as { callId: string }).callId === id);
		expect(answered("c/1")).toBe(true);
		expect(answered("c")).toBe(true);
	});
});
