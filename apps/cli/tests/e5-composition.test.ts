/**
 * E5 (the composition round) — the three gates the ruling demanded, red
 * before green:
 *
 *   1. THE DEFAULT COMPOSITION CARRIES NO TASK SURFACE — the rent-ledger
 *      side proof: every request of a default-composition session shows
 *      no `system:ext:task` / `tool:task_set` rent line and no task_set
 *      toolCall. (E5-F1/F2: the task extension paid its rent on 13
 *      consecutive real-provider sessions and was never called — the
 *      measured dead weight leaves the default.)
 *   2. THE OPT-IN PATH STILL LOADS task_set AND IT IS CALLABLE — a user
 *      extension named "task" (the copy from extensions/task/src) loads
 *      as a plain user extension (no shadow warning — task is no longer
 *      a built-in), the rent carries the task surfaces, the model's
 *      task_set call executes (the durable log holds the tool's own
 *      `[pending] <text>` echo).
 *   3. A PLAN-CARRYING SESSION RESUMES UNDER THE NEW DEFAULT — the plan
 *      created with the extension is still read back (the resumed run's
 *      first request carries the turn segment that contains the task_set
 *      result), the pre-resume log is byte-untouched (the append-only
 *      rule: the log never rewrites), the
 *      resumed run completes, and its rent carries no task surface — the
 *      documented edge: there is no task_set to UPDATE the plan until
 *      the opt-in is restored.
 *
 * All runs are real CLI processes on the BUILT dist with the faux
 * provider (deterministic, no API) and a fully isolated KISO_HOME. The
 * rent assertions mirror the bench extractor's arm proof
 * (bench/extract-e5-leg0.py).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const TASK_EXT = join(fileURLToPath(new URL("../../..", import.meta.url)), "extensions", "task", "src", "kiso-task.mjs");

/** All request lines of a session's trace. */
function traceRequests(home: string, sid: string): any[] {
	const p = join(home, "sessions", "traces", `${sid}.jsonl`);
	expect(existsSync(p), `trace missing: ${p}`).toBe(true);
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => r.kind === "request");
}

/** The task-surfaced rent lines of a request (the E4/E5 arm proof shape). */
function taskRent(req: any): any[] {
	return (req.rent ?? []).filter(
		(l: any) => l.surface.startsWith("system:ext:task") || l.surface.startsWith("tool:task_set"),
	);
}

/** The durable session log lines (run envelope + event). */
function logLines(home: string, sid: string): any[] {
	const p = join(home, "sessions", `${sid}.jsonl`);
	expect(existsSync(p), `session log missing: ${p}`).toBe(true);
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

/** The seq of the FIRST task_set tool_result in the durable log — the
 *  plan's position in the event stream (the resumed run's read-back
 *  coverage is asserted against it). tool_result events carry callId,
 *  not name — the task_set call is found first. */
function planSeq(home: string, sid: string): number {
	const events = logLines(home, sid).map((l) => l.event);
	const call = events.find((e) => e.type === "tool_call_end" && e.name === "task_set");
	const ev = call && events.find((e) => e.type === "tool_result" && e.callId === call.callId);
	if (!ev) throw new Error("no task_set tool_result in the durable log");
	return ev.seq as number;
}

/** A faux script file for the provider; returns its path. */
function fauxScript(turns: any[]): string {
	const p = join(mkdtempSync(join(tmpdir(), "kiso-faux-")), "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

describe("E5 composition — the default carries no task surface (rent-ledger proof)", () => {
	it("a default-composition session pays no task rent and never calls task_set", () => {
		const { env } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const res = runCli(["--mode", "bypass", "e5-g1"], env, { input: "hello\nexit\n" });
		expect(res.status, res.stderr).toBe(0);
		const reqs = traceRequests(env.KISO_HOME as string, "e5-g1");
		expect(reqs.length).toBeGreaterThan(0);
		for (const r of reqs) {
			expect(taskRent(r), JSON.stringify(r.rent)).toEqual([]);
			expect(r.toolCalls).not.toContain("task_set");
		}
	});
});

describe("E5 composition — the opt-in path loads task_set and it is callable", () => {
	it("a user extension named 'task' loads plainly and executes a task_set call", () => {
		const { env } = isolatedEnv();
		writeFileSync(join(env.KISO_EXTENSIONS_DIR as string, "kiso-task.mjs"), readFileSync(TASK_EXT, "utf8"), "utf8");
		const script = [
			{
				events: [
					{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: [{ text: "step one", status: "pending" }] } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const res = runCli(["--mode", "bypass", "e5-g2"], { ...env, KISO_FAUX_SCRIPT: fauxScript(script) }, { input: "plan it\nexit\n" });
		expect(res.status, res.stderr).toBe(0);
		// task is NOT a built-in any more — a user extension of that name
		// loads as a plain user extension, no loud shadow.
		expect(res.stderr).not.toContain("shadows the built-in");
		expect(stripANSI(res.stdout)).toContain("task");
		const reqs = traceRequests(env.KISO_HOME as string, "e5-g2");
		const surfaces = reqs.flatMap((r) => r.rent.map((l: any) => l.surface));
		expect(surfaces).toContain("system:ext:task");
		expect(surfaces).toContain("tool:task_set");
		// CALLABLE: the model called it and it EXECUTED — the durable log
		// holds the call, its execution, and the tool's own echo line
		// (only taskEcho emits `[pending] step one`; the trace's toolCalls
		// field only captures calls completing inside the request window,
		// so the log is the proof).
		const events = logLines(env.KISO_HOME as string, "e5-g2").map((l) => l.event);
		expect(events.some((e) => e.type === "tool_call_end" && e.name === "task_set")).toBe(true);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		expect(events.some((e) => e.type === "tool_result" && String(e.content).includes("[pending] step one"))).toBe(true);
	});
});

describe("E5 composition — a plan-carrying session resumes under the new default", () => {
	it("the durable plan is read back, the log is untouched, the resumed run carries no task tool", () => {
		const { env } = isolatedEnv();
		writeFileSync(join(env.KISO_EXTENSIONS_DIR as string, "kiso-task.mjs"), readFileSync(TASK_EXT, "utf8"), "utf8");
		const create = [
			{
				events: [
					{
						type: "tool_call_end",
						callId: "p1",
						name: "task_set",
						input: {
							items: [
								{ text: "first step", status: "pending" },
								{ text: "second step", status: "pending" },
							],
						},
					},
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const r1 = runCli(["--mode", "bypass", "e5-plan"], { ...env, KISO_FAUX_SCRIPT: fauxScript(create) }, { input: "make a plan\nexit\n" });
		expect(r1.status, r1.stderr).toBe(0);
		const home = env.KISO_HOME as string;
		const before = readFileSync(join(home, "sessions", "e5-plan.jsonl"), "utf8");
		expect(before).toContain("[pending] first step"); // the plan is durable
		const seq = planSeq(home, "e5-plan");

		// phase 2 — resume with the NEW DEFAULT composition: the same home,
		// an EMPTY extensions dir (no task), the fake provider continuing at
		// its durable position (the two consumed turns are skipped).
		const emptyExt = mkdtempSync(join(tmpdir(), "kiso-empty-ext-"));
		const resumeScript = [
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{
				events: [
					{ type: "text_delta", text: "I still see the plan." },
					{ type: "stop", reason: "end_turn" },
				],
			},
		];
		const env2 = {
			...process.env,
			KISO_HOME: home,
			KISO_EXTENSIONS_DIR: emptyExt,
			KISO_MCP_CONFIG: env.KISO_MCP_CONFIG as string,
			KISO_SKILLS_DIR: env.KISO_SKILLS_DIR as string,
			KISO_FAUX_SCRIPT: fauxScript(resumeScript),
		};
		const r2 = runCli(["resume", "e5-plan", "continue"], env2, { input: "" });
		expect(r2.status, r2.stderr).toBe(0);

		// ① the pre-resume log is byte-untouched (append-only).
		const after = readFileSync(join(home, "sessions", "e5-plan.jsonl"), "utf8");
		expect(after.startsWith(before)).toBe(true);

		// ② the durable plan is READ BACK: the resumed run's first request
		//    carries the prior-turn segment containing the task_set result.
		const reqs = traceRequests(home, "e5-plan");
		const resumed = [...reqs].reverse().find((r) => r.requestIndex === 0)!;
		expect(resumed).toBeTruthy();
		const covered = (resumed.contextManifest as any[]).some(
			(m) => m.role === "turn" && m.seqRange && m.seqRange[0] <= seq && seq <= m.seqRange[1],
		);
		expect(covered, JSON.stringify(resumed.contextManifest)).toBe(true);

		// ③ the resumed run's composition is the new default — no task
		//    surface in its rent (the documented edge: no task_set to
		//    update the plan; the opt-in restores it).
		for (const r of reqs.filter((r) => r.runId === resumed.runId)) {
			expect(taskRent(r), JSON.stringify(r.rent)).toEqual([]);
		}
	});
});
