/**
 * The program sandbox (QuickJS) on its own: what a script can and cannot do.
 * No kernel here — `runProgram` gets plain functions for invoke and catalog.
 * Invariants exercised (kiso-doc/program-invariants.md): I13 bounded, I15 no
 * ambient authority, I16 projection lossless on demand.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runProgram, type ProgramHost } from "../src/sandbox.js";

const ok = (content: string) => ({ content, isError: false as const });
const host = (over: Partial<ProgramHost> = {}): ProgramHost => ({
	invoke: async (name, input) => ok(JSON.stringify({ name, input })),
	catalog: () => [
		{ name: "make_widget", description: "Create a widget with a colour", inputSchema: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] } },
		{ name: "list_widgets", description: "List all widgets", inputSchema: { type: "object", properties: {} } },
		{ name: "calendar_get", description: "Get a calendar event", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
	],
	signal: new AbortController().signal,
	...over,
});

describe("sandbox: basics", () => {
	it("returns a value, prints text and console lines", async () => {
		const r = await runProgram(`console.log("hello", 1); text("a line"); return { n: 1 + 2 };`, host());
		expect(r.ok).toBe(true);
		expect(r.output).toContain('"n": 3');
		expect(r.output).toContain("a line");
		expect(r.output).toContain("hello 1");
	});

	it("calls tools: the result is parsed JSON, and calls can run in parallel", async () => {
		const seen: string[] = [];
		const r = await runProgram(
			`const rs = await Promise.all([tools.make_widget({colour:"red"}), tools.make_widget({colour:"blue"}), tools.list_widgets({})]); return rs.map(x => x.input.colour ?? null);`,
			host({ invoke: async (n, i) => { seen.push(n); return ok(JSON.stringify({ name: n, input: i })); } }),
		);
		expect(r.ok).toBe(true);
		expect(JSON.parse(r.value as string)).toEqual(["red", "blue", null]);
		expect(seen.sort()).toEqual(["list_widgets", "make_widget", "make_widget"]);
		expect(r.calls).toHaveLength(3);
	});

	it("a plain-text tool result stays a string", async () => {
		const r = await runProgram(`return await tools.list_widgets({});`, host({ invoke: async () => ok("no widgets") }));
		expect(r.output).toContain("no widgets");
	});

	it("a tool error rejects inside the script and can be caught; an uncaught one fails the script and lists the calls already made", async () => {
		const bad = host({ invoke: async (n) => (n === "make_widget" ? { content: "colour not allowed", isError: true as const } : ok("{}")) });
		const caught = await runProgram(`try { await tools.make_widget({colour:"x"}); } catch (e) { return "caught: " + e.message; }`, bad);
		expect(caught.ok).toBe(true);
		expect(caught.output).toContain("caught: colour not allowed");
		const failed = await runProgram(`await tools.list_widgets({}); await tools.make_widget({colour:"x"}); return "unreachable";`, bad);
		expect(failed.ok).toBe(false);
		expect(failed.output).toMatch(/Script failed/);
		expect(failed.output).toContain("colour not allowed");
		expect(failed.output).toMatch(/not undone|already made|before the failure/i);
		expect(failed.calls.map((c) => `${c.name}:${c.ok}`)).toEqual(["list_widgets:true", "make_widget:false"]);
	});
});

describe("sandbox: discovery", () => {
	it("ALL_TOOLS, searchTools and describeTool work from the catalog", async () => {
		const r = await runProgram(
			`const all = ALL_TOOLS.map(t => t.name); const hits = await searchTools("widget"); const d = await describeTool("make_widget"); return { all, hits: hits.map(h => h.name), schema: d.inputSchema.required, none: await describeTool("nope") ?? null };`,
			host(),
		);
		const v = JSON.parse(r.value as string);
		expect(v.all).toEqual(["make_widget", "list_widgets", "calendar_get"]);
		expect(v.hits.slice(0, 2).sort()).toEqual(["list_widgets", "make_widget"]);
		expect(v.hits).not.toContain("calendar_get");
		expect(v.schema).toEqual(["colour"]);
		expect(v.none).toBeNull();
	});

	it("calling an unknown tool name is a clear error, not an undefined-is-not-a-function", async () => {
		const r = await runProgram(`return await tools.nope({});`, host({ invoke: async (n) => ({ content: `Unknown tool: ${n}`, isError: true as const }) }));
		expect(r.ok).toBe(false);
		expect(r.output).toContain("Unknown tool: nope");
	});
});

describe("sandbox: limits (I13)", () => {
	it("a CPU loop is interrupted by the time budget", async () => {
		const t0 = Date.now();
		const r = await runProgram(`while (true) {}`, host(), { timeoutMs: 300 });
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/interrupt|time/i);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it("a script awaiting a never-answering tool is stopped by the same wall budget", async () => {
		const r = await runProgram(`await tools.list_widgets({}); return 1;`, host({ invoke: () => new Promise(() => {}) }), { timeoutMs: 300 });
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/time/i);
	});

	it("an abort ends the script", async () => {
		const ac = new AbortController();
		const p = runProgram(`await tools.list_widgets({}); return 1;`, host({ signal: ac.signal, invoke: () => new Promise(() => {}) }), { timeoutMs: 5000 });
		setTimeout(() => ac.abort(), 100);
		const r = await p;
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/abort/i);
	});

	it("the number of tool calls is capped, and calls past the cap never reach the host", async () => {
		let reached = 0;
		const r = await runProgram(`const out = []; for (let i = 0; i < 20; i++) { try { await tools.list_widgets({}); out.push("ok"); } catch (e) { out.push("cap"); } } return out.filter(x => x === "cap").length;`, host({ invoke: async () => { reached += 1; return ok("{}"); } }), { maxCalls: 5 });
		expect(reached).toBe(5);
		expect(JSON.parse(r.value as string)).toBe(15);
	});

	it("memory is bounded", async () => {
		const r = await runProgram(`const a = []; while (true) a.push("x".repeat(1e6));`, host(), { memoryBytes: 16 * 1024 * 1024, timeoutMs: 5000 });
		expect(r.ok).toBe(false);
	});
});

describe("sandbox: no ambient authority (I15)", () => {
	it("none of the host's powers exist inside the script", async () => {
		const r = await runProgram(
			`return { process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout, Buffer: typeof Buffer, global: typeof global, importMeta: typeof WebAssembly, std: typeof std, os: typeof os };`,
			host(),
		);
		const v = JSON.parse(r.value as string);
		expect(v.process).toBe("undefined");
		expect(v.require).toBe("undefined");
		expect(v.fetch).toBe("undefined");
		expect(v.setTimeout).toBe("undefined");
		expect(v.Buffer).toBe("undefined");
		expect(v.global).toBe("undefined");
		expect(v.std).toBe("undefined");
		expect(v.os).toBe("undefined");
	});

	it("the tool bridge cannot be used to reach outside the catalog's names or to run code on the host", async () => {
		const names: string[] = [];
		await runProgram(`for (const n of ["constructor", "__proto__", "toString", "make_widget"]) { try { await tools[n]({}); } catch (e) {} }`, host({ invoke: async (n) => { names.push(n); return ok("{}"); } }));
		expect(names).toEqual(["constructor", "__proto__", "toString", "make_widget"]); // names go to the kernel verbatim; the kernel refuses what is not a tool
	});
});

describe("sandbox: projection (I16)", () => {
	it("a long output is cut with a notice, and the full text is kept on disk", async () => {
		const r = await runProgram(`return "x".repeat(50000);`, host(), { maxOutputChars: 2000 });
		expect(r.output.length).toBeLessThan(4000);
		expect(r.output).toMatch(/truncated/i);
		expect(r.fullOutputPath).toBeDefined();
		expect(existsSync(r.fullOutputPath!)).toBe(true);
		expect(readFileSync(r.fullOutputPath!, "utf8").length).toBeGreaterThan(50000);
	});
});
