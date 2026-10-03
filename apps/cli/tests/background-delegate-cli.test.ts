/**
 * ADR-0058 3d through the CLI's real entry, with real child kiso processes
 * under the real task runner: `delegate({ …, background: true })` returns
 * at once; the children run as agent tasks; when the group has ended an
 * idle session wakes ONCE with every child's line and its answer. And the
 * selling point: a parent killed with SIGKILL leaves its child running —
 * the child finishes, writes its answer, and the reopened session is told
 * on the person's next message (a restart notifies, never wakes).
 *
 * The children get their own faux script through a wrapper bin (the
 * extension's KISO_SUBAGENT_BIN knob): the parent's script drives the
 * parent, the children's drives them.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { type: string; source?: string; via?: { kind: string; items?: unknown[] }; content?: unknown };
const eventsOf = (file: string): Ev[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => (JSON.parse(l) as { event: Ev }).event)
		: [];

async function until(read: () => boolean, what: string, ms = 45_000): Promise<void> {
	const end = Date.now() + ms;
	while (!read()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

/** The parent's env, with the children's own faux script behind a wrapper bin. */
function world(parent: unknown[], children: unknown[]) {
	const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass" });
	const cwd = mkdtempSync(join(tmpdir(), "kiso-bg-ws-"));
	writeFileSync(join(dirs.home, "parent.json"), JSON.stringify(parent));
	writeFileSync(join(dirs.home, "child.json"), JSON.stringify(children));
	const bin = join(dirs.home, "child-bin.mjs");
	writeFileSync(bin, `process.env.KISO_FAUX_SCRIPT = ${JSON.stringify(join(dirs.home, "child.json"))};\nprocess.argv[1] = ${JSON.stringify(CLI)};\nawait import(${JSON.stringify(pathToFileURL(CLI).href)});\n`);
	return { env: { ...env, KISO_FAUX_SCRIPT: join(dirs.home, "parent.json"), KISO_SUBAGENT_BIN: bin }, home: dirs.home, cwd, log: join(dirs.home, "sessions", "bg.jsonl") };
}

const delegateCall = (tasks: unknown[]) => ({ events: [{ type: "tool_call_end", callId: "d1", name: "delegate", input: { tasks, background: true } }, { type: "stop", reason: "tool_use" }] });
const TEXT = (text: string, delayMs = 0) => ({ events: [...(delayMs > 0 ? [{ type: "delay", ms: delayMs }] : []), { type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

describe("ADR-0058 3d — background children through the CLI", () => {
	it("returns at once; the group's end wakes the idle session once, with every child's line and answer", async () => {
		const w = world([delegateCall([{ role: "explorer", task: "map the auth flow" }, { role: "reviewer", task: "review the plan" }]), TEXT("waiting for the children"), TEXT("both children reported")], [TEXT("child answer: auth lives in src/auth", 300)]);
		const parent = spawn("node", [CLI, "chat", "bg"], { env: w.env, cwd: w.cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		parent.stdout.on("data", (d: Buffer) => (out += d.toString()));
		parent.stderr.on("data", (d: Buffer) => (out += d.toString()));
		const closed = new Promise<number | null>((r) => parent.on("close", r));
		parent.stdin.write("look into auth\n");
		await until(() => eventsOf(w.log).some((e) => e.type === "user_input" && e.via?.kind === "tasks"), "the wake turn's input");
		parent.stdin.end();
		expect(await closed).toBe(0);
		const events = eventsOf(w.log);
		const result = events.find((e) => e.type === "tool_result");
		expect(String(result?.content)).toMatch(/^started 2 background children: t1 explorer \(session sub-bg-[0-9a-f]+-1-explorer\), t2 reviewer/);
		const inputs = events.filter((e) => e.type === "user_input");
		expect(inputs.map((e) => e.source ?? "user")).toEqual(["user", "system"]);
		expect(inputs[1]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "exited" }] });
		const notice = String(inputs[1]!.content);
		expect(notice).toMatch(/<kiso-task id="t1" kind="agent" role="explorer" status="exited" outcome="completed" session="sub-bg-[^"]+"[^>]*result="[^"]+t1\/result\.md"\/>\nchild answer: auth lives in src\/auth/);
		expect(notice).toMatch(/<kiso-task id="t2" kind="agent" role="reviewer" status="exited"/);
		expect(readFileSync(join(w.home, "sessions", "bg.tasks", "t1", "result.md"), "utf8")).toBe("child answer: auth lives in src/auth\n");
		expect(out).toContain("both children reported");
	}, 90_000);

	it("the parent is SIGKILLed while its child runs: the child finishes; the reopened session is told on the next message", async () => {
		const w = world([delegateCall([{ role: "explorer", task: "map the auth flow" }]), TEXT("waiting"), TEXT("noted the child's answer")], [TEXT("late answer", 4_000)]);
		const parent = spawn("node", [CLI, "chat", "bg"], { env: w.env, cwd: w.cwd, stdio: ["pipe", "pipe", "pipe"] });
		const gone = new Promise((r) => parent.on("close", r));
		parent.stdin.write("look into auth\n");
		// the parent's turn is over and the child is still in its 4 s answer
		await until(() => eventsOf(w.log).some((e) => e.type === "terminal"), "the parent's first turn");
		const journal = join(w.home, "sessions", "bg.tasks", "t1", "journal.jsonl");
		expect(readFileSync(journal, "utf8")).not.toContain('"type":"terminal"');
		parent.kill("SIGKILL");
		await gone;
		await until(() => existsSync(journal) && readFileSync(journal, "utf8").includes('"type":"terminal"'), "the child's end");
		expect(readFileSync(join(w.home, "sessions", "bg.tasks", "t1", "result.md"), "utf8")).toBe("late answer\n");
		// reopened: no wake at startup; the notice rides the person's message
		const again = spawn("node", [CLI, "chat", "bg"], { env: w.env, cwd: w.cwd, stdio: ["pipe", "pipe", "pipe"] });
		const closed = new Promise<number | null>((r) => again.on("close", r));
		again.stdin.write("what did it find?\n");
		again.stdin.end();
		expect(await closed).toBe(0);
		const inputs = eventsOf(w.log).filter((e) => e.type === "user_input");
		expect(inputs.map((e) => e.source ?? "user")).toEqual(["user", "user", "system"]);
		expect(inputs[2]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] });
		expect(String(inputs[2]!.content)).toMatch(/kind="agent"[^\n]*\/>\nlate answer/);
	}, 120_000);
});
