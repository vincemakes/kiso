/**
 * 0.49.0 C — the child contract, through the extension's real delegate
 * tool and a scripted child process (KISO_SUBAGENT_BIN).
 *
 * C1: a child runs on the task's model, else the user's subagents.model,
 * else the conversation's own profile at the conversation's effort, else
 * the environment, and its section says which model it ran on.
 * C2: a reader runs under its turn budget; a writer has none yet (F1);
 * every child writes its result record.
 * C3/I5/I6: the section is the child's handoff, rendered from its record
 * and never from its printed output: an answer within 4 KiB (16 KiB a
 * call), a failure's error first and at most 2 KiB of its tail, and no
 * inline patch. What the child printed streams to its output.log.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createSubagentExtension, { resolveChild } from "../dist/kiso-subagent.mjs";

/** The scripted child: records how it was launched, then does what
 *  FAKE_CHILD_MODE says. It honours --result-file as the CLI does —
 *  result.md first, then result.json, the record that commits it. */
const FAKE_CHILD = `
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
appendFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ args, model: at("--model"), maxTurns: at("--max-turns"), resultFile: at("--result-file"), reasoning: process.env.KISO_CHILD_REASONING ?? null, cwd: process.cwd() }) + "\\n");
const mode = process.env.FAKE_CHILD_MODE ?? "ok";
const result = at("--result-file");
const record = (r) => writeFileSync(join(dirname(result), "result.json"), JSON.stringify(r));
// a pipe pushes back: write with its backpressure, as a real child does
const flood = async (bytes) => { const chunk = "x".repeat(64 * 1024); for (let n = 0; n < bytes; n += chunk.length) if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once("drain", r)); };
if (mode === "ok") {
	writeFileSync(result, "found it in src/a.ts\\n\\nUNRESOLVED\\nnone\\n");
	record({ outcome: "completed", endedBy: "completed", requests: 2, toolCalls: 3, model: "m-1", profile: at("--model") });
} else if (mode === "long") {
	writeFileSync(result, "L".repeat(30_000) + "\\n");
	record({ outcome: "completed", endedBy: "completed", requests: 2, toolCalls: 1, model: "m-1", profile: at("--model") });
} else if (mode === "flood-fail") {
	await flood(100 * 1024);
	process.stderr.write("\\nthe child's last words\\n");
	process.exitCode = 1;
} else if (mode === "error-record") {
	await flood(100 * 1024);
	writeFileSync(result, "");
	record({ outcome: "failed", endedBy: "error", requests: 1, toolCalls: 196, model: "m-1", profile: at("--model"), error: "402: request failed: 402 Insufficient Balance" });
	process.exitCode = 1;
} else if (mode === "md-only") {
	writeFileSync(result, "an answer nothing committed\\n");
} else if (mode === "flood-ok") {
	await flood(50 * 1024 * 1024);
	writeFileSync(result, "survived the flood\\n");
	record({ outcome: "completed", endedBy: "completed", requests: 1, toolCalls: 0, model: "m-1", profile: null });
} else if (mode === "edit") {
	writeFileSync(join(process.cwd(), "new.txt"), "NEW-CONTENT-THE-PATCH-CARRIES\\n");
	writeFileSync(result, "added new.txt\\n\\nUNRESOLVED\\nnone\\n");
	record({ outcome: "completed", endedBy: "completed", requests: 2, toolCalls: 1, model: "m-1", profile: null });
}
`;

const ctx = { signal: new AbortController().signal, sessionId: "s-parent" };
const saved = { ...process.env };
const savedCwd = process.cwd();
let home: string;
let log: string;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "kiso-c0490-"));
	home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	const bin = join(dir, "fake-child.mjs");
	writeFileSync(bin, FAKE_CHILD, "utf8");
	log = join(dir, "launches.jsonl");
	for (const k of ["KISO_SUBAGENT_DEPTH", "KISO_SUBAGENT_ARTIFACTS", "KISO_DELEGATION_CONFIG_JSON", "KISO_CHILD_REASONING", "FAKE_CHILD_MODE"]) delete process.env[k];
	Object.assign(process.env, { KISO_HOME: home, KISO_SESSIONS_DIR: join(home, "sessions"), KISO_SUBAGENT_BIN: bin, FAKE_CHILD_LOG: log });
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(savedCwd);
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

type Launch = { args: string[]; model: string | null; maxTurns: string | null; resultFile: string | null; reasoning: string | null };
const launches = (): Launch[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Launch) : []);

async function delegate(tasks: Record<string, unknown>[], host: Parameters<typeof createSubagentExtension>[0] = {}): Promise<{ content: string; isError: boolean }> {
	const ext = await createSubagentExtension(host);
	const tool = ext.tools!.find((t) => t.name === "delegate")!;
	return (await tool.execute({ tasks }, ctx as never)) as { content: string; isError: boolean };
}

const manifests = (): Record<string, unknown>[] => {
	const dir = join(home, "sessions", "subagent");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".result.json"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
};

describe("0.49.0 C1 — which model a child runs on", () => {
	it("the order: the task's model, then subagents.model, then the conversation's profile with its effort, then none", () => {
		const high = { thinking: "default", effort: "high" };
		const conversation = { profile: "sol", reasoning: high };
		expect(resolveChild({ model: "ds" }, { subagentsModel: "mini" }, conversation)).toEqual({ profile: "ds", source: "task" });
		expect(resolveChild({}, { subagentsModel: "mini" }, conversation)).toEqual({ profile: "mini", source: "subagents.model" });
		expect(resolveChild({}, {}, conversation)).toEqual({ profile: "sol", reasoning: high, source: "conversation" });
		expect(resolveChild({}, {}, { profile: null })).toEqual({ source: "environment" });
		expect(resolveChild({}, {}, null)).toEqual({ source: "environment" });
	});

	it("a child that names no model runs on the conversation's profile at the conversation's effort — never on the config's default", async () => {
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ profiles: ["ds", "sol"] });
		const r = await delegate([{ role: "explorer", task: "look" }], { currentBinding: (id) => (id === "s-parent" ? { profile: "sol", reasoning: { thinking: "default", effort: "high" } } : null) });
		expect(r.isError).toBe(false);
		const [l] = launches();
		expect(l!.model).toBe("sol");
		expect(JSON.parse(l!.reasoning!)).toEqual({ thinking: "default", effort: "high" });
		expect(r.content).toMatch(/status: completed · model: sol · /);
		expect(manifests()[0]).toMatchObject({ model: "sol", modelSource: "conversation", reasoning: { thinking: "default", effort: "high" } });
	});

	it("the task's own model, or the user's subagents.model, starts at that profile's own effort", async () => {
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ profiles: ["ds", "sol", "mini"], subagentsModel: "mini" });
		const host = { currentBinding: () => ({ profile: "sol", reasoning: { thinking: "default", effort: "high" } }) };
		await delegate([{ role: "explorer", task: "look", model: "ds" }], host);
		await delegate([{ role: "explorer", task: "look" }], host);
		const [byTask, byConfig] = launches();
		expect([byTask!.model, byTask!.reasoning]).toEqual(["ds", null]);
		expect([byConfig!.model, byConfig!.reasoning]).toEqual(["mini", null]);
	});

	it("with nothing to resolve the child inherits the environment, and its section says it ran on the default", async () => {
		process.env.KISO_CHILD_REASONING = '{"thinking":"default","effort":"low"}'; // a stray value is never passed on
		const r = await delegate([{ role: "explorer", task: "look" }]);
		const [l] = launches();
		expect(l!.model).toBeNull();
		expect(l!.reasoning).toBeNull();
		expect(r.content).toMatch(/· model: \S+ \(default\) ·/);
		expect(manifests()[0]).toMatchObject({ modelSource: "environment" });
	});
});

describe("0.49.0 C2 — budgets and the result record", () => {
	it("a reader runs under its turn budget with a result file; the record lives in the child's own directory", async () => {
		await delegate([{ role: "explorer", task: "look" }, { role: "reviewer", task: "judge" }]);
		for (const l of launches()) {
			expect(l.maxTurns).toBe("32");
			expect(l.resultFile).toMatch(/subagent\/sub-s-parent-[0-9a-f]+-\d-(explorer|reviewer)\/result\.md$/);
			expect(existsSync(join(l.resultFile!, "..", "result.json"))).toBe(true);
		}
	});

	it("the host's reader budget applies to the foreground too", async () => {
		await delegate([{ role: "explorer", task: "look" }], { backgroundMaxTurns: 7 });
		expect(launches()[0]!.maxTurns).toBe("7");
	});
});

describe("0.49.0 C3 — the section is the child's handoff, never its printed output", () => {
	it("a child that floods its output and dies without a record: a bounded section, the tail, and the full output on disk", async () => {
		process.env.FAKE_CHILD_MODE = "flood-fail";
		const r = await delegate([{ role: "explorer", task: "look" }]);
		expect(r.isError).toBe(true);
		expect(r.content).toContain("FAILED: the child exited with code 1 and left no result record");
		expect(r.content).toMatch(/\n…x+\nthe child's last words$/);
		expect(Buffer.byteLength(r.content)).toBeLessThan(3_000); // today: the whole 100 KB
		const out = join(launches()[0]!.resultFile!, "..", "output.log");
		expect(statSync(out).size).toBeGreaterThan(100 * 1024);
	}, 30_000);

	it("a failed child's record leads with its error: the provider's 402 is the first thing the parent reads", async () => {
		process.env.FAKE_CHILD_MODE = "error-record";
		const r = await delegate([{ role: "explorer", task: "look" }]);
		expect(r.content).toMatch(/FAILED: the child's run ended with error\nerror: 402: request failed: 402 Insufficient Balance\n…x+$/);
		expect(r.content).toMatch(/· tools: 196$/m);
		expect(Buffer.byteLength(r.content)).toBeLessThan(3_500);
	}, 30_000);

	it("I5: an answer the child wrote without its record is never read as its result", async () => {
		process.env.FAKE_CHILD_MODE = "md-only";
		const r = await delegate([{ role: "explorer", task: "look" }]);
		expect(r.isError).toBe(true);
		expect(r.content).toContain("left no result record");
		expect(r.content).not.toContain("an answer nothing committed");
	});

	it("a 30 KB answer: 4 KiB of it and the path to the rest", async () => {
		process.env.FAKE_CHILD_MODE = "long";
		const r = await delegate([{ role: "explorer", task: "look" }]);
		const resultPath = launches()[0]!.resultFile!;
		expect(r.content).toContain(`\n${"L".repeat(4_096)}\n… [truncated; the whole answer: ${resultPath}]`);
		expect(r.content).not.toContain("L".repeat(4_097));
		expect(readFileSync(resultPath, "utf8")).toBe(`${"L".repeat(30_000)}\n`);
	});

	it("a call's children share 16 KiB: five long answers show 16 KiB of answer between them, and every child its path", async () => {
		process.env.FAKE_CHILD_MODE = "long";
		const r = await delegate(Array.from({ length: 5 }, (_, i) => ({ role: "explorer", task: `look ${i}` })));
		// whole lines of the answer only: a temp path's random suffix may hold an L too
		const shown = (r.content.match(/^L+$/gm) ?? []).reduce((n, s) => n + s.length, 0);
		expect(shown).toBe(16_384);
		expect(r.content.match(/the whole answer: /g)).toHaveLength(5);
	}, 30_000);

	it("a child that prints 50 MB: its output is all on disk, and the section is its answer", async () => {
		process.env.FAKE_CHILD_MODE = "flood-ok";
		const r = await delegate([{ role: "explorer", task: "look" }]);
		expect(r.isError).toBe(false);
		// an answer without its UNRESOLVED section says so, in one line
		expect(r.content).toMatch(/\nsurvived the flood\n {2}unresolved: not reported$/);
		expect(Buffer.byteLength(r.content)).toBeLessThan(1_000);
		expect(statSync(join(launches()[0]!.resultFile!, "..", "output.log")).size).toBeGreaterThanOrEqual(50 * 1024 * 1024);
	}, 60_000);
});

describe("0.49.0 C2/C3 — a writer", () => {
	it("an implementer has a result file and no turn budget yet (F1); its patch is named, never inlined", async () => {
		const repo = process.cwd();
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "a\n");
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "a.txt"], { cwd: repo });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });
		process.env.FAKE_CHILD_MODE = "edit";
		const r = await delegate([{ role: "implementer", task: "add a file" }]);
		const [l] = launches();
		expect(l!.maxTurns).toBeNull();
		expect(l!.resultFile).toMatch(/implementer\/result\.md$/);
		expect(r.content).toMatch(/\n {2}patch: \S+\.patch\n {2}worktree kept at: /);
		expect(r.content).not.toContain("NEW-CONTENT-THE-PATCH-CARRIES");
		const patch = r.content.match(/\n {2}patch: (\S+\.patch)/)![1]!;
		expect(readFileSync(patch, "utf8")).toContain("NEW-CONTENT-THE-PATCH-CARRIES");
	}, 30_000);
});
