/** P0-1, runtime side: a child's effect happened and the post-tool hook then threw. What the next process sees. */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type KisoExtension, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const ok = (c: string): ToolResult => ({ content: c, isError: false });
const tools = (applied: string[]): Tool[] => [
	defineTool({ name: "prog", description: "p", parameters: { type: "object", properties: {} }, execute: async (_i, ctx) => { await ctx.invoke!("pay", {}); return ok("parent finished"); } }),
	defineTool({ name: "pay", description: "p", parameters: { type: "object", properties: {} }, execute: async () => { applied.push("pay"); return ok("paid"); } }),
] as unknown as Tool[];
const exploding: KisoExtension = { name: "boom", hooks: { onPostTool: async (c: { name: string }, r: ToolResult) => { if (c.name === "pay") throw new Error("post-tool hook exploded"); return r; } } as never };

describe("infrastructure fault after a child's effect (runtime)", () => {
	it("the next process sees child AND parent uncertain, resume is blocked, children are ruled first, and the model is told the child's honest end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "infra-"));
		const applied: string[] = [];
		const adapter = createFauxProvider([{ events: [{ type: "tool_call_end", callId: "p1", name: "prog", input: {} }, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]);
		const live = await createAgent({ model: "faux", adapter, tools: tools(applied), extensions: [exploding], store: new SessionStore(dir) }).session({ id: "s" });
		let threw = false;
		try { for await (const _ of live.run("go")) { /* */ } } catch { threw = true; }
		expect(applied).toEqual(["pay"]);
		expect(threw).toBe(true);
		const copy = mkdtempSync(join(tmpdir(), "infra-2-"));
		cpSync(dir, copy, { recursive: true, filter: (s) => !/\.lock$|\.lock\//.test(s) });
		const next = await createAgent({ model: "faux", adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), tools: tools([]), store: new SessionStore(copy) }).session({ id: "s" });
		expect(next.uncertainExecutions().map((u) => u.callId).sort()).toEqual(["p1", "p1/1"]);
		await expect((async () => { for await (const _ of next.resume()) { /* */ } })()).rejects.toThrow(/blocked/i);
		await expect(next.resolveUncertain(next.uncertainExecutions().find((u) => u.callId === "p1")!.executionId, "abandoned")).rejects.toThrow(/child/i);
		await next.resolveUncertain(next.uncertainExecutions().find((u) => u.callId === "p1/1")!.executionId, "abandoned");
		await next.resolveUncertain(next.uncertainExecutions().find((u) => u.callId === "p1")!.executionId, "abandoned");
		const told = String((next.log.all.filter((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p1").at(-1) as unknown as { content: string }).content);
		expect(told).toContain("p1/1 pay abandoned");
		expect(next.uncertainExecutions()).toEqual([]);
	});
});
