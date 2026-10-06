/**
 * ADR-0058 (3e) through a real terminal: the person's side of tasks.
 *
 * ctrl+b moves a running foreground command to the background (the row
 * teaches the key while it applies); the count rides the status row;
 * `/tasks show` prints a task's output on the screen and NOWHERE else (no
 * user_input — the model never sees the inspection); a clean exit with
 * live tasks asks first and says what each answer does; "leave" keeps a
 * runner's task running and says so; a steer during a long command lands
 * without waiting for it (ADR-0057 §5). Amendment 8: a task kiso lost track
 * of is said once in the transcript, by name, and `/tasks` lists it; the
 * status row counts only what kiso manages.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

type Ev = { type: string; content?: unknown; source?: string; via?: { kind: string; items?: unknown } };
const eventsOf = (home: string, id: string): Ev[] =>
	readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event: Ev }).event);
const journal = (home: string, id: string, task: string): string => {
	const f = join(home, "sessions", `${id}.tasks`, task, "journal.jsonl");
	return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const shellCall = (input: object) => ({ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input }, { type: "stop", reason: "tool_use" }] });
const text = (t: string) => ({ events: [{ type: "text_delta", text: t }, { type: "stop", reason: "end_turn" }] });
const PROMPT = "/ commands · ↑ history";

describe("ADR-0058 (3e) — the person's side of tasks", () => {
	it("ctrl+b moves the running command to the background; /tasks show is the person's alone; exit asks and stops it", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: "echo begun; sleep 30" }), text("noted, it keeps going"), ...spares(3)]) });
		const raw = ptyRun(["chat", "t3e-a"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["ctrl+b background", "\x02"],
				["noted, it keeps going", "/tasks show t1\r"],
				["its last output", "exit\r"],
				["1 task is running", "\r"],
			],
			timeout: 60,
		});
		const events = eventsOf(dirs.home, "t3e-a");
		const result = events.find((e) => e.type === "tool_result");
		expect(String(result?.content)).toMatch(/^moved to the background by the person; continued as background task t1/);
		expect(raw).toContain("● 1 task running");
		expect(raw).toContain("begun"); // the output, shown to the person
		// the inspection never reached the trajectory
		expect(events.filter((e) => e.type === "user_input").map((e) => String(e.content))).toEqual(["go"]);
		// the exit question said what it would do, and the task was stopped
		expect(raw).toContain("stop all and exit");
		expect(journal(dirs.home, "t3e-a", "t1")).toMatch(/"type":"stop_requested","ts":\d+,"by":"exit"/);
	}, 120_000);

	it("exit can leave a runner's task running — and says so", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: "sleep 20", background: true }), text("started it"), ...spares(3)]) });
		const raw = ptyRun(["chat", "t3e-b"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["started it", "exit\r"],
				["1 task is running", "\x1b[B\r"], // the second answer: leave it
			],
			timeout: 60,
		});
		expect(raw).toContain("leave 1 background task running");
		expect(raw).toContain("left running: t1");
		const j = journal(dirs.home, "t3e-b", "t1");
		expect(j).not.toContain('"type":"terminal"');
		expect(j).not.toContain('"type":"stop_requested"');
		// tidy: the reopened session stops it, and this time the answer is "stop"
		ptyRun(["chat", "t3e-b"], env as NodeJS.ProcessEnv, { feeds: [[PROMPT, "exit\r"], ["1 task is running", "\r"]], timeout: 60 });
		expect(journal(dirs.home, "t3e-b", "t1")).toContain('"by":"exit"');
	}, 180_000);

	it("a steer during a long command lands without waiting for it (ADR-0057 §5)", () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: "sleep 30" }), text("heard you"), ...spares(3)]) });
		ptyRun(["chat", "t3e-c"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["esc stop", ""],
				["heard you", "exit\r"],
				["1 task is running", "\r"],
			],
			// the steer, typed while the command runs past its 2 s
			delays: [[5, "also check the logs\r"]],
			timeout: 60,
		});
		const events = eventsOf(dirs.home, "t3e-c");
		expect(String(events.find((e) => e.type === "tool_result")?.content)).toMatch(/^moved to the background so the person's message could land; continued as background task t1/);
		expect(events.filter((e) => e.type === "user_input").map((e) => String(e.content))).toEqual(["go", "also check the logs"]);
	}, 120_000);

	it("a task kiso lost track of is said once in the transcript, by name, and /tasks show says why (Amendment 8)", () => {
		// the command kills its own runner: the runner never records the end,
		// and the command's shell outlives it — kiso cannot know how it ends
		const cmd = "sleep 1; kill -9 $PPID; sleep 2";
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: cmd, background: true }), text("started it"), text("heard"), ...spares(3)]) });
		const raw = ptyRun(["chat", "t3e-d"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["heard", "/tasks show t1\r"],
				["t1 — lost track:", "exit\r"],
			],
			// a lost task is a notice, not a wake: the next message carries
			// it. The runner dies ~1 s after the task starts and a gone
			// runner is read within one identify window (5 s) — 15 s is margin
			delays: [[15, "next\r"]],
			timeout: 60,
		});
		expect(raw).toContain(`✦ lost track of t1 (${cmd})`);
		expect(raw).toContain("it may still be running · /tasks shows it");
		expect(raw).toContain("t1 — lost track: its runner is gone without recording its end; it may still be running");
		// the status row never held it
		expect(raw).not.toContain("◌");
		expect(raw).not.toMatch(/\d+ unknown/);
		// said once: one delivery, and the model's side still reads unknown
		const notices = eventsOf(dirs.home, "t3e-d").filter((e) => e.type === "user_input" && e.via?.kind === "tasks");
		expect(notices.map((e) => e.via?.items)).toEqual([[{ taskId: "t1", transition: "unknown" }]]);
		expect(String(notices[0]?.content)).toContain('status="unknown"');
		expect(journal(dirs.home, "t3e-d", "t1")).not.toContain('"type":"terminal"');
		// a gone runner is never asked to stop at exit, so nothing is reported unconfirmed
		expect(raw).not.toContain("stop unconfirmed");
	}, 120_000);
});
