/**
 * A human ruling "rerun" says the interrupted attempt did NOT apply and lets the model re-issue the call. If the tool's contract has
 * changed since the attempt was bound (its recorded digest differs from the live one, or the tool is gone), the ruling is refused
 * unless the human acknowledges the change explicitly: showing the old digest is not a check.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Tool } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";

const mk = (digest: string | undefined): Tool => ({ ...defineTool({ name: "pay", description: "pays", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "paid", isError: false }) }), ...(digest !== undefined ? { digest } : {}) });
const first = () => createFauxProvider([{ events: [{ type: "tool_call_end", callId: "c1", name: "pay", input: {} }, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]);

/** run once, cut the log right after the call's `started`: the crash window */
async function crashedStore(digest: string | undefined): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "rb-live-"));
	const s = await createAgent({ model: "faux", adapter: first(), tools: [mk(digest)], store: new SessionStore(dir) }).session({ id: "s" });
	for await (const _ of s.run("go")) { /* */ }
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && !f.includes("trace"))!;
	const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
	const at = lines.findIndex((l) => l.includes('"tool_execution_started"'));
	const crashed = mkdtempSync(join(tmpdir(), "rb-crash-"));
	mkdirSync(crashed, { recursive: true });
	writeFileSync(join(crashed, file), `${lines.slice(0, at + 1).join("\n")}\n`);
	return crashed;
}
const reopen = (dir: string, tool: Tool | undefined) => createAgent({ model: "faux", adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), tools: tool ? [tool] : [], store: new SessionStore(dir) }).session({ id: "s" });

describe("rerun checks the recorded binding", () => {
	it("the same digest: the ruling goes through", async () => {
		const s = await reopen(await crashedStore("sha256:A"), mk("sha256:A"));
		const [u] = s.uncertainExecutions();
		await s.resolveUncertain(u!.executionId, "rerun");
		expect(s.uncertainExecutions()).toEqual([]);
	});
	it("a different live digest: refused, naming both; acknowledged explicitly it goes through", async () => {
		const s = await reopen(await crashedStore("sha256:AAAAAAAAAAAA"), mk("sha256:BBBBBBBBBBBB"));
		const [u] = s.uncertainExecutions();
		await expect(s.resolveUncertain(u!.executionId, "rerun")).rejects.toThrow(/binding changed.*AAAAAAAAAA.*BBBBBBBBBB/s);
		expect(s.uncertainExecutions()).toHaveLength(1); // nothing was written
		await s.resolveUncertain(u!.executionId, "rerun", { acknowledgeBindingChange: true });
		expect(s.uncertainExecutions()).toEqual([]);
	});
	it("the tool is gone: refused too", async () => {
		const s = await reopen(await crashedStore("sha256:A"), undefined);
		const [u] = s.uncertainExecutions();
		await expect(s.resolveUncertain(u!.executionId, "rerun")).rejects.toThrow(/binding changed.*no longer/s);
	});
	it("abandoned never needs the check; a record with no binding is unaffected", async () => {
		const s1 = await reopen(await crashedStore("sha256:A"), mk("sha256:B"));
		await s1.resolveUncertain(s1.uncertainExecutions()[0]!.executionId, "abandoned");
		expect(s1.uncertainExecutions()).toEqual([]);
		const s2 = await reopen(await crashedStore(undefined), mk("sha256:B"));
		await s2.resolveUncertain(s2.uncertainExecutions()[0]!.executionId, "rerun");
		expect(s2.uncertainExecutions()).toEqual([]);
	});
});
