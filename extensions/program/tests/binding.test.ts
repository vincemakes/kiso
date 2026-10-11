/** Binding guard: a child whose tool contract changed after the program was admitted is refused BEFORE it starts. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createPlanExtension, createProgramExtension, hideTools } from "../src/index.js";

const domain = (effects: string[]): KisoExtension => ({
	name: "domain",
	tools: ["x", "y"].map((n) => ({ ...defineTool({ name: n, description: n, parameters: { type: "object", properties: {} }, execute: async () => { effects.push(n); return { content: "{}", isError: false }; } }), digest: `sha256:admitted-${n}` })) as never,
});
const script = (tool: string, code: string) => [
	{ events: [{ type: "tool_call_end" as const, callId: "p1", name: tool, input: { code } }, { type: "stop" as const, reason: "tool_use" as const }] },
	{ events: [{ type: "text_delta" as const, text: "done" }, { type: "stop" as const, reason: "end_turn" as const }] },
];
async function run(tool: "program" | "plan", code: string, live: Record<string, string | undefined>, asked: string[]) {
	const effects: string[] = [], events: Event[] = [];
	const binding = { liveDigest: async (n: string) => { asked.push(n); return live[n]; } };
	const front = tool === "program" ? createProgramExtension({}, { binding }) : createPlanExtension({ binding });
	const agent = createAgent({ model: "faux", adapter: createFauxProvider(script(tool, code)), tools: [], extensions: [front, hideTools(domain(effects))], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
	const session = await agent.session({ id: "s" });
	for await (const ev of session.run("go")) events.push(ev);
	return { effects, events, text: String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content), started: events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name) };
}

describe("binding guard (program and plan)", () => {
	it("program: a child whose live contract differs is refused, nothing starts for it; an unchanged one runs; the live contract is asked once per tool", async () => {
		const asked: string[] = [];
		const r = await run("program", `const out = []; for (const t of ["x", "y", "y"]) { try { await tools[t]({}); out.push(t + " ok"); } catch (e) { out.push(t + " refused: " + String(e.message).slice(0, 90)); } } return out;`, { x: "sha256:CHANGED", y: "sha256:admitted-y" }, asked);
		expect(r.effects).toEqual(["y", "y"]);
		expect(r.started).toEqual(["program", "y", "y"]); // x never started
		expect(r.text).toMatch(/x refused: .*changed since this program was admitted/);
		expect(asked.sort()).toEqual(["x", "y"]); // once per tool, not per call
	});

	it("program: when the server cannot say (undefined) the call proceeds and the tool itself decides", async () => {
		const r = await run("program", `await tools.x({}); return "ran";`, { x: undefined }, []);
		expect(r.effects).toEqual(["x"]);
	});

	it("program: a contract that changes DURING the program is caught after the first failure; later calls to that tool are refused before they start", async () => {
		const effects: string[] = [], events: Event[] = [];
		let live = "sha256:admitted-x"; const asked: string[] = [];
		const flaky: KisoExtension = { name: "flaky", tools: [{ ...defineTool({ name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => { effects.push("x"); live = "sha256:CHANGED"; return { content: "server rejected the call", isError: true }; } }), digest: "sha256:admitted-x" }] as never };
		const binding = { liveDigest: async (n: string) => { asked.push(n); return live; } };
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", `const o = []; for (let i = 0; i < 3; i++) { try { await tools.x({}); o.push("ok"); } catch (e) { o.push(String(e.message).slice(0, 90)); } } return o;`)), tools: [], extensions: [createProgramExtension({}, { binding }), hideTools(flaky)], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) events.push(ev);
		expect(effects).toEqual(["x"]); // only the first call reached the tool
		expect(events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name)).toEqual(["program", "x"]);
		const text = String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content);
		expect(text).toMatch(/changed since this program was admitted/);
		expect(asked.length).toBe(2); // before the first call, and again after it failed
	});

	it("program: recheck 'every-call' asks the live contract before each call", async () => {
		const asked: string[] = [];
		const effects: string[] = [], events: Event[] = [];
		const binding = { liveDigest: async (n: string) => { asked.push(n); return "sha256:admitted-y"; }, recheck: "every-call" as const };
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", `await tools.y({}); await tools.y({}); await tools.y({}); return 1;`)), tools: [], extensions: [createProgramExtension({}, { binding }), hideTools(domain(effects))], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) events.push(ev);
		expect(asked).toEqual(["y", "y", "y"]);
		expect(effects).toEqual(["y", "y", "y"]);
	});

	it("plan: the same refusal; the failed step is reported with its reason, the unchanged step ran", async () => {
		const r = await run("plan", `const a = call("x", {}); const b = call("y", {}); output({ b });`, { x: "sha256:CHANGED", y: "sha256:admitted-y" }, []);
		expect(r.effects).toEqual(["y"]);
		expect(r.started).toEqual(["plan", "y"]);
		expect(r.text).toMatch(/failed x .*changed since this program was admitted/);
	});
});

// ── audit vs enforce, and the effects contract inside the digest (owner's ruling 2026-10-11) ─────
import { withEffects } from "../src/index.js";

describe("binding modes", () => {
	const bound = (effects: string[], digested = true): KisoExtension => ({
		name: "d",
		tools: [{ ...defineTool({ name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => { effects.push("x"); return { content: "{}", isError: false }; } }), ...(digested ? { digest: "sha256:admitted-x" } : {}) }] as never,
	});
	async function go(source: { liveDigest: (n: string) => Promise<string | undefined>; mode?: "audit" | "enforce"; allowUnbound?: readonly string[] }, code: string, digested = true) {
		const effects: string[] = [], events: Event[] = [];
		const agent = createAgent({ model: "faux", adapter: createFauxProvider(script("program", code)), tools: [], extensions: [createProgramExtension({}, { binding: source }), hideTools(bound(effects, digested))], store: new SessionStore(mkdtempSync(join(tmpdir(), "bind-"))) });
		const session = await agent.session({ id: "s" });
		for await (const ev of session.run("go")) events.push(ev);
		return { effects, text: String((events.filter((e) => e.type === "tool_result") as unknown as { content: string }[])[0]!.content), started: events.filter((e) => e.type === "tool_execution_started").map((e) => (e as { name: string }).name) };
	}
	const CALL3 = `const o = []; for (let i = 0; i < 3; i++) { try { await tools.x({}); o.push("ok"); } catch (e) { o.push(String(e.message).slice(0, 100)); } } return o;`;

	it("audit (default): a server that cannot say lets the call run, and the result says the binding was not verified", async () => {
		const r = await go({ liveDigest: async () => undefined }, CALL3);
		expect(r.effects).toEqual(["x", "x", "x"]);
		expect(r.text).toMatch(/3 tool calls? ran without a verified tool binding/);
	});
	it("enforce: a server that cannot say refuses every call before it starts", async () => {
		const r = await go({ liveDigest: async () => undefined, mode: "enforce" }, CALL3);
		expect(r.effects).toEqual([]);
		expect(r.started).toEqual(["program"]);
		expect(r.text).toMatch(/could not be verified/);
	});
	it("enforce: the binding is checked before EVERY call, not only the first", async () => {
		const asked: string[] = [];
		const r = await go({ liveDigest: async (n) => { asked.push(n); return "sha256:admitted-x"; }, mode: "enforce" }, CALL3);
		expect(asked).toEqual(["x", "x", "x"]);
		expect(r.effects).toEqual(["x", "x", "x"]);
	});
	it("enforce: a tool that carries no digest cannot be bound and is refused, unless the host lists it", async () => {
		const refused = await go({ liveDigest: async () => "sha256:whatever", mode: "enforce" }, `try { await tools.x({}); return "ran"; } catch (e) { return String(e.message).slice(0, 100); }`, false);
		expect(refused.effects).toEqual([]);
		expect(refused.text).toMatch(/no binding digest/);
		const allowed = await go({ liveDigest: async () => "sha256:whatever", mode: "enforce", allowUnbound: ["x"] }, `await tools.x({}); return "ran";`, false);
		expect(allowed.effects).toEqual(["x"]);
	});
	it("enforce: a call let through by the host's allowUnbound exemption is NAMED in the result (the guarantee covers only the non-exempt tools)", async () => {
		const r = await go({ liveDigest: async () => "sha256:whatever", mode: "enforce", allowUnbound: ["x"] }, `await tools.x({}); await tools.x({}); return "ran";`, false);
		expect(r.effects).toEqual(["x", "x"]);
		expect(r.text).toMatch(/2 tool calls? ran under the host's exemption from binding \(allowUnbound\): x/);
	});
	it("enforce: a contract that changed between two calls stops the second one", async () => {
		let live = "sha256:admitted-x"; let n = 0;
		const r = await go({ liveDigest: async () => { n += 1; if (n > 1) live = "sha256:CHANGED"; return live; }, mode: "enforce" }, CALL3);
		expect(r.effects).toEqual(["x"]);
		expect(r.text).toMatch(/changed since this program was admitted/);
	});
});

describe("the host's effects declaration is part of the digest", () => {
	const ext = (): KisoExtension & { liveDigest: (n: string) => Promise<string | undefined> } => ({ name: "mcp", liveDigest: async () => "sha256:provider-x", tools: [{ ...defineTool({ name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "{}", isError: false }) }), digest: "sha256:provider-x" }] as never });
	it("declaring `shared` changes the tool's digest; the live digest agrees with the admitted one; undeclared tools keep the provider's digest", async () => {
		const plain = ext(); const shared = withEffects(ext(), () => ({ concurrency: "shared" }));
		const none = withEffects(ext(), () => undefined);
		const dPlain = (plain.tools as unknown as { digest: string }[])[0]!.digest, dShared = (shared.tools as unknown as { digest: string }[])[0]!.digest;
		expect(dShared).not.toBe(dPlain);
		expect(dShared).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect((none.tools as unknown as { digest: string }[])[0]!.digest).toBe(dPlain);
		expect(await (shared as unknown as { liveDigest: (n: string) => Promise<string> }).liveDigest("x")).toBe(dShared);
		expect(await (none as unknown as { liveDigest: (n: string) => Promise<string> }).liveDigest("x")).toBe(dPlain);
		// a different declaration is a different tool for admission purposes
		const other = withEffects(ext(), () => ({ precommitSafe: true }));
		expect((other.tools as unknown as { digest: string }[])[0]!.digest).not.toBe(dShared);
	});
});
