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
 * of is said once in the transcript, by name, when kiso concludes it — live,
 * or as the session opens — and `/tasks` lists it; the status row counts
 * only what kiso manages.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, settledScreen, spares } from "./helpers/pty.js";

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

	it("a task kiso lost track of is said once, at once, by name — not again when the model is told; /tasks show says why (Amendment 8)", () => {
		// the command kills its own runner: the runner never records the end,
		// and the command's shell outlives it — kiso cannot know how it ends
		const cmd = "sleep 1; kill -9 $PPID; sleep 2";
		// "next" runs a 2 s command: the notice's merge window (1 s) closes
		// while that run is live, so the model is told within it either way
		const wait2 = { events: [{ type: "tool_call_end", callId: "s2", name: "shell", input: { command: "sleep 2" } }, { type: "stop", reason: "tool_use" }] };
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: cmd, background: true }), text("started it"), wait2, text("heard"), ...spares(3)]) });
		const raw = ptyRun(["chat", "t3e-d"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				// said when kiso concludes it — no message has carried it yet
				["lost track of t1", "next\r"],
				["heard", "/tasks show t1\r"],
				["t1 — lost track:", "exit\r"],
			],
			// tall enough that nothing scrolls off: the settled screen is the whole transcript
			rows: 60,
			timeout: 60,
		});
		expect(raw).toContain(`✦ lost track of t1 (${cmd})`);
		expect(raw).toContain("it may still be running · /tasks shows it");
		expect(raw).toContain("t1 — lost track: its runner is gone without recording its end; it may still be running");
		// said once on the screen, though the model was told with "next" (the
		// byte stream repaints the row as it scrolls — count the settled rows)
		expect(settledScreen(raw, 60, 100).filter((r) => r.includes("✦ lost track of t1")).length).toBe(1);
		const notices = eventsOf(dirs.home, "t3e-d").filter((e) => e.type === "user_input" && e.via?.kind === "tasks");
		expect(notices.map((e) => e.via?.items)).toEqual([[{ taskId: "t1", transition: "unknown" }]]);
		expect(String(notices[0]?.content)).toContain('status="unknown"');
		// the status row never held it
		expect(raw).not.toContain("◌");
		expect(raw).not.toMatch(/\d+ unknown/);
		expect(journal(dirs.home, "t3e-d", "t1")).not.toContain('"type":"terminal"');
		// a gone runner is never asked to stop at exit, so nothing is reported unconfirmed
		expect(raw).not.toContain("stop unconfirmed");
	}, 120_000);

	it("a loss concluded while no kiso listened is said as the session opens, before any message (Amendment 8)", () => {
		const cmd = "sleep 4; kill -9 $PPID; sleep 2";
		const { env, dirs } = isolatedEnv({ KISO_MODE: "bypass", KISO_FAUX_SCRIPT: fauxScript([shellCall({ command: cmd, background: true }), text("started it"), ...spares(3)]) });
		const first = ptyRun(["chat", "t3e-e"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["started it", "exit\r"],
				["1 task is running", "\x1b[B\r"], // leave it running
			],
			timeout: 60,
		});
		expect(first).toContain("left running: t1");
		// wait (bounded) until the command has killed its runner
		const pid = Number(/"type":"runner_started","ts":\d+,"pid":(\d+)/.exec(journal(dirs.home, "t3e-e", "t1"))?.[1]);
		const alive = (): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const until = Date.now() + 20_000;
		while (alive() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		expect(alive()).toBe(false);
		const reopened = ptyRun(["chat", "t3e-e"], env as NodeJS.ProcessEnv, { feeds: [["lost track of t1", "exit\r"]], timeout: 60 });
		expect(reopened).toContain(`✦ lost track of t1 (${cmd})`);
		// the model has not been told yet: its notice rides the next run
		expect(eventsOf(dirs.home, "t3e-e").filter((e) => e.type === "user_input" && e.via?.kind === "tasks")).toEqual([]);
	}, 180_000);
});
