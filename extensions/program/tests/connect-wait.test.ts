/**
 * The cold start (findings-mcp-bridge F1) without a kernel line: an extension that
 * publishes tools while it is still connecting gets a BOUNDED wait before the run's
 * first request, through the existing async `onUserMessage` hook (awaited before
 * the request is assembled; the table is re-snapshotted per request). The same
 * shape as the shell tool's foreground wait: a bound owned by the tool side,
 * not the kernel.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension, type Tool } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { connectWait, createProgramExtension, hideTools } from "../src/index.js";

/** A bridge that connects after `ms`: `connecting` is true until then, its tools appear when it settles. */
function slowBridge(ms: number): KisoExtension {
	const tools: Tool[] = [];
	const ext: { name: string; tools: Tool[]; connecting: boolean } = { name: "slow-bridge", tools, connecting: true };
	setTimeout(() => {
		tools.push(defineTool({ name: "remote_ping", description: "Ping the remote service", parameters: { type: "object", properties: {} }, execute: async () => ({ content: JSON.stringify({ pong: true }), isError: false }) }));
		ext.connecting = false;
	}, ms);
	return ext;
}

const SCRIPT = `const r = await tools.remote_ping({}); return r.pong;`;
const sink = () => createFauxProvider([
	{ events: [{ type: "tool_call_end", callId: "p1", name: "program", input: { code: SCRIPT } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] },
]);

async function firstTurn(extensions: KisoExtension[]): Promise<string> {
	const agent = createAgent({ model: "faux", adapter: sink(), tools: [], extensions, store: new SessionStore(mkdtempSync(join(tmpdir(), "cw-"))) });
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	for await (const ev of session.run("ping it")) events.push(ev);
	return (events.find((e) => e.type === "tool_result") as unknown as { content: string }).content;
}

describe("bounded wait for a connecting extension", () => {
	it("WITHOUT the wait the first request has no remote tools, so the script cannot call them (the cold start)", async () => {
		const out = await firstTurn([createProgramExtension(), hideTools(slowBridge(300))]);
		expect(out).toMatch(/Script failed/);
	});

	it("WITH the wait the first turn finds them: the run holds until the bridge has settled", async () => {
		const bridge = slowBridge(300);
		const out = await firstTurn([createProgramExtension(), hideTools(bridge), connectWait(bridge, 5000)]);
		expect(out).toContain("Script completed");
		expect(out).toContain("true");
	});

	it("the wait is bounded: a bridge that never connects delays the run by the bound and no more", async () => {
		const never: KisoExtension & { connecting: boolean } = { name: "never", tools: [], connecting: true };
		const t0 = Date.now();
		await firstTurn([createProgramExtension(), hideTools(never), connectWait(never, 400)]);
		const took = Date.now() - t0;
		expect(took).toBeGreaterThanOrEqual(380);
		expect(took).toBeLessThan(2500);
	});

	it("an extension that is already connected costs nothing", async () => {
		const done: KisoExtension & { connecting: boolean } = { name: "done", tools: [], connecting: false };
		const t0 = Date.now();
		await firstTurn([createProgramExtension(), hideTools(done), connectWait(done, 5000)]);
		expect(Date.now() - t0).toBeLessThan(1500);
	});
});
