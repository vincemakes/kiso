/**
 * 0.49.0 A through a real terminal: a foreground reader delegation is a
 * bounded join the person can end. ctrl+b and a steer move it to the
 * background at once — the session's 329 s with no way out is gone — and
 * the group's notice later wakes the model with the children's answers.
 * The exit question counts joined children: they are tasks from their
 * start.
 *
 * The parent is scripted (faux); its delegate calls are real; the
 * children are a scripted process (KISO_SUBAGENT_BIN) that sleeps, then
 * writes its answer and its result record.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const CHILD = `
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const role = /-(explorer|reviewer)$/.exec(args[args.indexOf("chat") + 1])?.[1] ?? "x";
setTimeout(() => {
	const result = at("--result-file");
	writeFileSync(result, "ANSWER-OF-" + role + "\\n\\nUNRESOLVED\\nnone\\n");
	writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 1, toolCalls: 0, model: "m", profile: null }));
}, Number(process.env.CHILD_SLEEP_MS ?? "6000"));
`;

type Ev = { type: string; content?: unknown; via?: { kind: string; items?: { taskId: string }[] } };
const eventsOf = (home: string, id: string): Ev[] =>
	readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event: Ev }).event);
const delegateCall = {
	events: [
		{ type: "tool_call_end", callId: "d1", name: "delegate", input: { tasks: [{ role: "explorer", task: "map the code" }, { role: "reviewer", task: "judge the plan" }] } },
		{ type: "stop", reason: "tool_use" },
	],
};
const text = (t: string) => ({ events: [{ type: "text_delta", text: t }, { type: "stop", reason: "end_turn" }] });
const PROMPT = "/mode to switch";

function setup(sleepMs: number) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-join-pty-"));
	writeFileSync(join(dir, "child.mjs"), CHILD, "utf8");
	return isolatedEnv({
		KISO_MODE: "bypass",
		KISO_SUBAGENT_BIN: join(dir, "child.mjs"),
		CHILD_SLEEP_MS: String(sleepMs),
		KISO_FAUX_SCRIPT: fauxScript([delegateCall, text("NOTED-THEY-KEEP-GOING"), text("GOT-THEIR-ANSWERS"), ...spares(3)]),
	});
}

describe("0.49.0 A — the person can always move a delegation to the background", () => {
	it("ctrl+b ends the join at once; the group's notice later wakes the model with both answers", () => {
		const { env, dirs } = setup(5_000);
		const raw = ptyRun(["chat", "join-b"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["ctrl+b background", "\x02"],
				["GOT-THEIR-ANSWERS", "exit\r"],
			],
			timeout: 90,
		});
		const events = eventsOf(dirs.home, "join-b");
		const result = String(events.find((e) => e.type === "tool_result")?.content);
		expect(result).toMatch(/^summary: 2 tasks /);
		expect(result).toMatch(/\nmoved to the background by the person: continued as background tasks t1, t2; you will be told when all of them have ended/);
		const wake = events.find((e) => e.type === "user_input" && e.via?.kind === "tasks");
		expect(wake?.via?.items?.map((i) => i.taskId)).toEqual(["t1", "t2"]);
		expect(String(wake?.content)).toContain("ANSWER-OF-explorer");
		expect(String(wake?.content)).toContain("ANSWER-OF-reviewer");
		expect(raw).toContain("NOTED-THEY-KEEP-GOING");
	}, 180_000);

	it("a steer ends the join so the person's message can land", () => {
		const { env, dirs } = setup(20_000);
		ptyRun(["chat", "join-s"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["NOTED-THEY-KEEP-GOING", "exit\r"],
				["2 tasks are running", "\r"],
			],
			// the steer, typed while the join waits past its 2 s
			delays: [[5, "also check the tests\r"]],
			timeout: 90,
		});
		const events = eventsOf(dirs.home, "join-s");
		expect(String(events.find((e) => e.type === "tool_result")?.content)).toMatch(/\nmoved to the background so the person's message could land: continued as background tasks t1, t2; /);
		expect(events.filter((e) => e.type === "user_input" && e.via === undefined).map((e) => String(e.content))).toEqual(["go", "also check the tests"]);
	}, 180_000);

	it("the exit question counts joined children, and stopping them is a stop of the tasks", () => {
		const { env, dirs } = setup(30_000);
		const raw = ptyRun(["chat", "join-x"], env as NodeJS.ProcessEnv, {
			feeds: [
				[PROMPT, "go\r"],
				["ctrl+b background", "\x02"],
				["NOTED-THEY-KEEP-GOING", "exit\r"],
				["2 tasks are running", "\r"],
			],
			timeout: 90,
		});
		expect(raw).toContain("stop all and exit");
		for (const t of ["t1", "t2"]) expect(readFileSync(join(dirs.home, "sessions", "join-x.tasks", t, "journal.jsonl"), "utf8")).toMatch(/"type":"stop_requested","ts":\d+,"by":"exit"/);
	}, 180_000);
});
