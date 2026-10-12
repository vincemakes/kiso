/**
 * Result Inspect — `inspect_result` and the ResultRef grammar.
 *
 * A ref is a locator: it resolves from ids and the store layout alone
 * (a new tool instance, as after a restart, resolves the same ref), it
 * reaches only the calling session's own tasks and children, a missing
 * backing file is a plain "expired" result, and every view streams and
 * stays under the 12 KiB cap. The fixtures here are synthetic: a store
 * directory with a task root, a background child's task directory, a
 * foreground child's artifact directory, and a small child session log.
 */

import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolResult } from "@vincemakes/kiso-core";
import { formatResultRef, INSPECT_CAP_BYTES, inspectResultTool, parseResultRef, renderWork, type InspectView } from "../src/inspect-result.js";

const SESSION = "s1";
const CHILD_BG = "sub-s1-0123456789abcdef01234567-1-explorer";
const CHILD_FG = "sub-s1-89abcdef0123456789abcdef-2-reviewer";

function ctx(sessionId: string | undefined = SESSION): ToolContext {
	return { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, sessionId, executionId: "ex-1" } as unknown as ToolContext;
}

let store: string;
let root: string;

/** A new tool instance over the store — what a restarted process builds. */
const toolFor = (r: string = root) => inspectResultTool({ tasks: (sid) => (sid === undefined ? undefined : { root: join(r, "..", `${sid}.tasks`) }) });

async function run(ref: string, view: InspectView | Record<string, unknown>, sessionId: string | undefined = SESSION, tool = toolFor()): Promise<ToolResult> {
	return tool.execute({ ref, view: view as InspectView }, ctx(sessionId));
}

const ev = (event: Record<string, unknown>) => `${JSON.stringify({ runId: "r1", ts: 1, event })}\n`;

/** A small child session: its task, two parallel calls (one fails), a
 *  third call, the deltas and thinking that are skipped, and its end. */
const CHILD_LOG = [
	ev({ type: "user_input", content: "find the retry logic\nanswer precisely" }),
	ev({ seq: 1, type: "thinking", text: "let me look" }),
	ev({ seq: 2, type: "tool_call_start", callId: "c1", name: "search_text" }),
	ev({ seq: 3, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: '{"pattern"' }),
	ev({ seq: 4, type: "tool_call_start", callId: "c2", name: "read_file" }),
	ev({ seq: 5, type: "tool_call_end", callId: "c1", name: "search_text", input: { pattern: "retry|backoff" } }),
	ev({ seq: 6, type: "tool_call_end", callId: "c2", name: "read_file", input: { path: "src/missing.js" } }),
	ev({ seq: 7, type: "stop", reason: "tool_use" }),
	ev({ type: "tool_execution_succeeded", executionId: "ex-9", callId: "c2", invocationSeq: 6, result: { content: "ENOENT", isError: true }, seq: 8 }),
	ev({ type: "tool_result", callId: "c2", invocationSeq: 6, content: "ENOENT: src/missing.js", isError: true, executionId: "ex-9", seq: 9 }),
	ev({ type: "tool_result", callId: "c1", invocationSeq: 5, content: "src/pay.js:7: for (let i = 0; i < attempts; i++) {\nsrc/pay.js:9:   await sleep(backoffBaseMs * 2 ** i);\n", isError: false, executionId: "ex-8", seq: 10 }),
	ev({ seq: 11, type: "text_delta", text: "The client retries" }),
	ev({ seq: 12, type: "tool_call_end", callId: "c3", name: "read_file", input: { path: "src/pay.js", note: "x".repeat(400) } }),
	ev({ type: "tool_result", callId: "c3", invocationSeq: 12, content: `line one\n${"y".repeat(500)}`, isError: false, executionId: "ex-12", seq: 13 }),
	ev({ seq: 14, type: "terminal", outcome: { kind: "completed" } }),
].join("");

const RENDERED = [
	"> find the retry logic",
	"> answer precisely",
	'#2 read_file {"path":"src/missing.js"}',
	"  (error)",
	"  ENOENT: src/missing.js",
	'#1 search_text {"pattern":"retry|backoff"}',
	"  src/pay.js:7: for (let i = 0; i < attempts; i++) {",
	"  src/pay.js:9:   await sleep(backoffBaseMs * 2 ** i);",
	`#3 read_file ${JSON.stringify({ path: "src/pay.js", note: "x".repeat(400) }).slice(0, 299)}…`,
	"  line one",
	`  ${"y".repeat(398)}… [+102 bytes]`,
	"[end: completed]",
];

beforeAll(() => {
	store = mkdtempSync(join(tmpdir(), "kiso-inspect-"));
	root = join(store, `${SESSION}.tasks`);
	// t1: a shell task, 100 numbered lines
	mkdirSync(join(root, "t1"), { recursive: true });
	writeFileSync(join(root, "t1", "journal.jsonl"), `${JSON.stringify({ type: "planned", ts: 1, taskId: "t1", backend: "process", command: "make", cwd: "/", profile: "oneshot" })}\n`);
	writeFileSync(join(root, "t1", "output.log"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}${i % 10 === 6 ? " ERROR here" : ""}`).join("\n") + "\n");
	// t2: a background child — its task directory holds its result
	mkdirSync(join(root, "t2"), { recursive: true });
	writeFileSync(join(root, "t2", "journal.jsonl"), `${JSON.stringify({ type: "planned", ts: 1, taskId: "t2", backend: "process", command: "explorer: look", cwd: "/", profile: "oneshot", agent: { role: "explorer", session: CHILD_BG } })}\n`);
	writeFileSync(join(root, "t2", "output.log"), "child chatter\n");
	writeFileSync(join(root, "t2", "result.json"), JSON.stringify({ outcome: "completed", requests: 5 }));
	writeFileSync(join(root, "t2", "result.md"), "The client makes 4 attempts.\n\nUNRESOLVED\nnone\n");
	writeFileSync(join(store, `${CHILD_BG}.jsonl`), CHILD_LOG);
	// a foreground child (no tasks): its artifact directory holds its result
	mkdirSync(join(store, "subagent", CHILD_FG), { recursive: true });
	writeFileSync(join(store, "subagent", CHILD_FG, "result.json"), JSON.stringify({ outcome: "completed" }));
	writeFileSync(join(store, "subagent", CHILD_FG, "result.md"), "foreground answer\n");
	delete process.env.KISO_SUBAGENT_ARTIFACTS;
});

afterAll(() => rmSync(store, { recursive: true, force: true }));

describe("Result Inspect — the ResultRef grammar", () => {
	it("parse and format round-trip every kind", () => {
		for (const ref of ["result:task:t1", "result:task:t42", `result:subagent:${CHILD_BG}`, `result:subagent:${CHILD_BG}/work`, "result:subagent:sub-my.session-ab-1-explorer"]) {
			const parsed = parseResultRef(ref);
			expect("error" in parsed, ref).toBe(false);
			expect(formatResultRef(parsed as Exclude<typeof parsed, { error: string }>)).toBe(ref);
		}
		expect(parseResultRef(`result:subagent:${CHILD_BG}/work`)).toEqual({ kind: "subagent", childId: CHILD_BG, work: true });
	});

	it("malformed and traversing refs are refused", () => {
		for (const bad of [
			"",
			"result:task:",
			"result:task:t0",
			"result:task:1",
			"result:task:t1 ",
			"result:task:t1/../t2",
			"result:task:../../etc/passwd",
			"result:subagent:",
			"result:subagent:x-1-explorer",
			"result:subagent:sub-",
			"result:subagent:sub-..",
			"result:subagent:sub-s1/../../secret",
			"result:subagent:sub-s1-a/work/x",
			"result:subagent:sub-s1-a/answer",
			"result:file:/etc/passwd",
			"/etc/passwd",
		]) {
			expect("error" in parseResultRef(bad), bad).toBe(true);
		}
	});

	it("the tool refuses a malformed ref as a precondition, before touching the disk", async () => {
		const r = await run("result:subagent:sub-s1/../../x", { kind: "info" });
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(r.content).toMatch(/not a result ref/);
	});
});

describe("Result Inspect — a task's output", () => {
	it("info: the kind, the id, bytes, a streamed line count, mtime, and the backing file", async () => {
		const r = await run("result:task:t1", { kind: "info" });
		expect(r.isError).toBe(false);
		expect(r.content).toContain("result:task:t1 — task t1's output");
		expect(r.content).toContain("kind: file");
		expect(r.content).toContain(`backing file: ${join(root, "t1", "output.log")}`);
		expect(r.content).toMatch(/\nbytes: \d+\n/);
		expect(r.content).toContain("lines: 100\n");
		expect(r.content).toMatch(/modified: \d{4}-\d\d-\d\dT/);
	});

	it("range: numbered lines from startLine, and the end said when the file ends first", async () => {
		const r = await run("result:task:t1", { kind: "range", startLine: 9, limit: 3 });
		expect(r.content.split("\n")).toEqual(["result:task:t1 — task t1's output, lines 9–11", "9: line 9", "10: line 10", "11: line 11"]);
		const end = await run("result:task:t1", { kind: "range", startLine: 99, limit: 10 });
		expect(end.content).toContain("99: line 99\n100: line 100\n[end: it has 100 lines]");
		expect((await run("result:task:t1", { kind: "range", startLine: 500, limit: 10 })).content).toContain("[no lines: it has 100 lines]");
	});

	it("grep: `<line>: <text>`, at most `limit` matches, and where the next one is", async () => {
		const r = await run("result:task:t1", { kind: "grep", pattern: "ERROR", limit: 3 });
		expect(r.content.split("\n")).toEqual([
			"result:task:t1 — task t1's output, lines matching /ERROR/",
			"7: line 7 ERROR here",
			"17: line 17 ERROR here",
			"27: line 27 ERROR here",
			"[stopped at the limit of 3 matches; the next match is at line 37]",
		]);
		expect((await run("result:task:t1", { kind: "grep", pattern: "^line 10\\d$" })).content).toContain("100: line 100");
		expect((await run("result:task:t1", { kind: "grep", pattern: "nothing-like-this" })).content).toContain("(no matches)");
	});

	it("tail: the last lines, numbered from the streamed count", async () => {
		const r = await run("result:task:t1", { kind: "tail", lines: 3 });
		expect(r.content.split("\n")).toEqual(["result:task:t1 — task t1's output, the last 3 of 100 lines", "98: line 98", "99: line 99", "100: line 100"]);
	});

	it("views are checked: bad numbers, a pattern over 200 chars, an invalid RegExp", async () => {
		for (const view of [{ kind: "range", startLine: 0, limit: 1 }, { kind: "range", startLine: 1 }, { kind: "grep", pattern: "a", limit: 101 }, { kind: "tail", lines: 0 }, { kind: "sql" }, { kind: "grep", pattern: "" }]) {
			expect(await run("result:task:t1", view), JSON.stringify(view)).toMatchObject({ isError: true, errorKind: "precondition" });
		}
		const long = await run("result:task:t1", { kind: "grep", pattern: "a".repeat(201) });
		expect(long).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(long.content).toMatch(/201 chars; the limit is 200/);
		expect((await run("result:task:t1", { kind: "grep", pattern: "(" })).content).toMatch(/invalid pattern/);
	});
});

describe("Result Inspect — a child's answer and its rendered work", () => {
	it("a background child's answer is found in its task's directory, by the session its journal names", async () => {
		const r = await run(`result:subagent:${CHILD_BG}`, { kind: "range", startLine: 1, limit: 10 });
		expect(r.content).toContain(`result:subagent:${CHILD_BG} — the child's final answer`);
		expect(r.content).toContain("1: The client makes 4 attempts.");
		expect((await run(`result:subagent:${CHILD_BG}`, { kind: "info" })).content).toContain(`backing file: ${join(root, "t2", "result.md")}`);
	});

	it("a foreground child's answer is found in its artifact directory", async () => {
		const r = await run(`result:subagent:${CHILD_FG}`, { kind: "info" });
		expect(r.content).toContain(`backing file: ${join(store, "subagent", CHILD_FG, "result.md")}`);
		expect((await run(`result:subagent:${CHILD_FG}`, { kind: "tail" })).content).toContain("1: foreground answer");
	});

	it("the work view renders each tool call as a header and its result's lines, skipping deltas and thinking", async () => {
		const lines: string[] = [];
		for await (const l of renderWork(join(store, `${CHILD_BG}.jsonl`))) lines.push(l);
		expect(lines).toEqual(RENDERED);
		// a header's args stay within 300 chars, a line within 400
		expect(lines[8]!.length - "#3 read_file ".length).toBeLessThanOrEqual(300);
		expect(lines[10]!.startsWith(`  ${"y".repeat(398)}…`)).toBe(true);
	});

	it("info/range/grep/tail over the rendered work", async () => {
		const ref = `result:subagent:${CHILD_BG}/work`;
		const info = await run(ref, { kind: "info" });
		expect(info.content).toContain("kind: rendered transcript");
		expect(info.content).toContain(`backing file: ${join(store, `${CHILD_BG}.jsonl`)}`);
		expect(info.content).toContain(`lines: ${RENDERED.length} (rendered)`);
		expect((await run(ref, { kind: "range", startLine: 3, limit: 3 })).content.split("\n").slice(1)).toEqual(['3: #2 read_file {"path":"src/missing.js"}', "4:   (error)", "5:   ENOENT: src/missing.js"]);
		expect((await run(ref, { kind: "grep", pattern: "^#\\d" })).content.split("\n").slice(1)).toEqual([`3: ${RENDERED[2]}`, `6: ${RENDERED[5]}`, `9: ${RENDERED[8]}`]);
		expect((await run(ref, { kind: "tail", lines: 2 })).content.split("\n")).toEqual([`${ref} — the child's tool calls, rendered from its session log, the last 2 of ${RENDERED.length} lines`, `11: ${RENDERED[10]}`, "12: [end: completed]"]);
	});
});

describe("Result Inspect — the reach: the calling session's own store only", () => {
	it("a child of another session is refused, whatever its files", async () => {
		const other = "sub-s2-0123456789abcdef01234567-1-explorer";
		writeFileSync(join(store, `${other}.jsonl`), CHILD_LOG);
		for (const ref of [`result:subagent:${other}`, `result:subagent:${other}/work`, "result:subagent:sub-s10-0123-1-explorer"]) {
			const r = await run(ref, { kind: "info" });
			expect(r, ref).toMatchObject({ isError: true, errorKind: "precondition" });
			expect(r.content).toMatch(/not a child of this session/);
		}
	});

	it("a task id resolves only under the calling session's task root", async () => {
		// session s2 has no t1: its root is s2.tasks
		const r = await run("result:task:t1", { kind: "info" }, "s2");
		expect(r.isError).toBe(false);
		expect(r.content).toMatch(/^expired: result:task:t1: no output for task t1 in this session/);
	});

	it("a call with no session store is refused", async () => {
		const signal = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
		const r = await toolFor().execute({ ref: "result:task:t1", view: { kind: "info" } }, { signal, executionId: "ex-1" } as unknown as ToolContext);
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
	});
});

describe("Result Inspect — expiry and restarts", () => {
	it("a missing backing file is a plain expired result, never an exception", async () => {
		expect(await run("result:task:t9", { kind: "tail" })).toMatchObject({ isError: false, content: expect.stringMatching(/^expired: /) });
		expect(await run("result:subagent:sub-s1-ffff-9-explorer", { kind: "info" })).toMatchObject({ isError: false, content: expect.stringMatching(/^expired: .*result directory is gone/) });
		expect(await run("result:subagent:sub-s1-ffff-9-explorer/work", { kind: "info" })).toMatchObject({ isError: false, content: expect.stringMatching(/^expired: .*session log is gone/) });
		// a child that left no committed record: nothing is served as its answer
		const dir = join(store, "subagent", "sub-s1-eeee-3-explorer");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "result.md"), "uncommitted\n");
		const r = await run("result:subagent:sub-s1-eeee-3-explorer", { kind: "tail" });
		expect(r).toMatchObject({ isError: false });
		expect(r.content).toMatch(/^expired: .*no committed result/);
		expect(r.content).not.toContain("uncommitted");
	});

	it("a ref resolves from ids and the store layout alone: a new tool instance reads the same bytes", async () => {
		const views: InspectView[] = [{ kind: "tail", lines: 5 }, { kind: "grep", pattern: "read_file" }];
		for (const ref of ["result:task:t1", `result:subagent:${CHILD_BG}`, `result:subagent:${CHILD_BG}/work`]) {
			for (const view of views) {
				const before = await run(ref, view, SESSION, toolFor());
				const after = await run(ref, view, SESSION, inspectResultTool({ tasks: () => ({ root }) }));
				expect(after.content, ref).toBe(before.content);
			}
		}
	});
});

describe("Result Inspect — the cap and streaming", () => {
	let big: string;
	beforeAll(() => {
		big = mkdtempSync(join(tmpdir(), "kiso-inspect-big-"));
		mkdirSync(join(big, "s1.tasks", "t1"), { recursive: true });
		mkdirSync(join(big, "s1.tasks", "t2"), { recursive: true });
		mkdirSync(join(big, "s1.tasks", "t3"), { recursive: true });
		// t1: one 5 MB line
		writeFileSync(join(big, "s1.tasks", "t1", "output.log"), "x".repeat(5 * 1024 * 1024));
		// t2: 200,000 matching lines
		writeFileSync(join(big, "s1.tasks", "t2", "output.log"), `match me ${"q".repeat(190)}\n`.repeat(200_000));
		// t3: ~60 MB, written in chunks, with one marker near the end
		const fd = openSync(join(big, "s1.tasks", "t3", "output.log"), "w");
		const block = Array.from({ length: 10_000 }, (_, i) => `row ${String(i).padStart(5, "0")} ${"p".repeat(88)}`).join("\n") + "\n";
		for (let i = 0; i < 60; i += 1) writeSync(fd, block);
		closeSync(fd);
		appendFileSync(join(big, "s1.tasks", "t3", "output.log"), "THE-MARKER at the end\nlast line\n");
	});
	afterAll(() => rmSync(big, { recursive: true, force: true }));

	const bigTool = () => inspectResultTool({ tasks: () => ({ root: join(big, "s1.tasks") }) });
	const capped = (r: ToolResult) => expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(INSPECT_CAP_BYTES);

	it("a 5 MB single-line file stays under the cap in every view, and says what it cut", async () => {
		for (const view of [{ kind: "range", startLine: 1, limit: 5 }, { kind: "tail" }, { kind: "grep", pattern: "x" }, { kind: "info" }] as InspectView[]) {
			const r = await run("result:task:t1", view, SESSION, bigTool());
			capped(r);
			if (view.kind !== "info") expect(r.content, view.kind).toMatch(/… \[\+\d+ bytes\]/);
		}
		expect((await run("result:task:t1", { kind: "info" }, SESSION, bigTool())).content).toContain("lines: 1\n");
	});

	it("a 200k-match grep stays under the cap: the limit, or the cap, stops it, and the result says which", async () => {
		const r = await run("result:task:t2", { kind: "grep", pattern: "match", limit: 100 }, SESSION, bigTool());
		capped(r);
		expect(r.content).toMatch(/\[cut at the 12 KiB cap after \d+ matches; the next match is at line \d+/);
		const few = await run("result:task:t2", { kind: "grep", pattern: "match" }, SESSION, bigTool());
		capped(few);
		expect(few.content).toContain("[stopped at the limit of 30 matches; the next match is at line 31]");
		const tail = await run("result:task:t2", { kind: "tail", lines: 1000 }, SESSION, bigTool());
		capped(tail);
		expect(tail.content).toMatch(/\[cut at the 12 KiB cap: lines 199001–\d+ not shown\]/);
		expect(tail.content.endsWith(`200000: match me ${"q".repeat(190)}`)).toBe(true);
	});

	it("a ~60 MB output is streamed: fast, and never held in memory", async () => {
		const tool = bigTool();
		const heap0 = process.memoryUsage().heapUsed;
		const t0 = performance.now();
		const info = await run("result:task:t3", { kind: "info" }, SESSION, tool);
		expect(info.content).toContain("lines: 600002\n");
		const tail = await run("result:task:t3", { kind: "tail", lines: 2 }, SESSION, tool);
		expect(tail.content.split("\n").slice(1)).toEqual(["600001: THE-MARKER at the end", "600002: last line"]);
		const grep = await run("result:task:t3", { kind: "grep", pattern: "THE-MARKER", limit: 1 }, SESSION, tool);
		expect(grep.content).toContain("600001: THE-MARKER at the end");
		const range = await run("result:task:t3", { kind: "range", startLine: 300_001, limit: 2 }, SESSION, tool);
		expect(range.content).toContain(`300001: row 00000 ${"p".repeat(88)}`);
		const ms = performance.now() - t0;
		const grown = process.memoryUsage().heapUsed - heap0;
		// loose bounds: four full passes over 60 MB; the file is never one string
		expect(ms).toBeLessThan(15_000);
		expect(grown).toBeLessThan(48 * 1024 * 1024);
		for (const r of [info, tail, grep, range]) capped(r);
	}, 30_000);
});
