#!/usr/bin/env node
/**
 * subagents-counters.mjs <work> — the 0.49.0 subagents kit's per-leg
 * record (kiso-doc kit-subagents-0490): what the join did, what woke the
 * parent, and what each writer left. Read from the leg's own durable files:
 * the main session log (never a child's) and its task directories.
 *
 *   delegate calls, and those with `background: true`;
 *   each call's join outcome, from its tool result:
 *     within   — every child reported in the result;
 *     cut      — the join's budget passed: some continued as the group;
 *     person / steer / interrupted — the wait was ended early;
 *     started  — a background call (no wait);
 *     partial  — a cut call that also reported at least one child;
 *   wake runs — runs whose first input is a task notice;
 *   the parent's requests (its `stop` events);
 *   writers — each task with a collection: its role, the child's requests
 *     and outcome (result.json), the collection's outcome, the adoption's
 *     terminal (apply.jsonl), and both acceptance verdicts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";
import { applyTerminal, taskDirs } from "./w1-verify.mjs";

function jsonl(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
}

const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

/** The join's outcome, from a delegate call's result text. */
export function joinOutcome(content) {
	if (/^started \d+ background/.test(content)) return "started";
	if (/\nmoved to the background by the person: /.test(content)) return "person";
	if (/\nmoved to the background so the person's message could land: /.test(content)) return "steer";
	if (/\ninterrupted: continued as background/.test(content)) return "interrupted";
	if (/\nstill running after \d+ ms: continued as background/.test(content)) return "cut";
	return "within";
}

export function subagentCounters(records, tasks) {
	const events = records.map((r) => r.event ?? r);
	const calls = events.filter((e) => e.type === "tool_call_end" && e.name === "delegate");
	const byCall = new Map(calls.map((c) => [c.callId, c]));
	const joins = { within: 0, cut: 0, partial: 0, person: 0, steer: 0, interrupted: 0, started: 0 };
	for (const r of events.filter((e) => e.type === "tool_result" && byCall.has(e.callId))) {
		const content = String(r.content ?? "");
		const o = joinOutcome(content);
		joins[o] += 1;
		if (o !== "within" && o !== "started" && /· task t\d+\n/.test(content)) joins.partial += 1;
	}
	// a run's first input: a person's line, or (a wake) a task notice
	const firstInput = new Map();
	records.forEach((r, i) => {
		const e = events[i];
		if (e.type === "user_input" && r.runId !== undefined && !firstInput.has(r.runId)) firstInput.set(r.runId, e);
	});
	const wakes = [...firstInput.values()].filter((e) => e.via?.kind === "tasks").length;
	const writers = [];
	for (const dir of tasks) {
		const journal = jsonl(join(dir, "journal.jsonl"));
		const planned = journal.find((r) => r.type === "planned");
		const collected = journal.find((r) => r.type === "collected");
		if (planned?.agent?.collect !== true) continue;
		const result = readJson(join(dir, "result.json"));
		const apply = applyTerminal(dir);
		const applyRecords = jsonl(join(dir, "apply.jsonl"));
		const workspaceAcc = applyRecords.find((r) => r.type === "acceptance_result");
		const childAcc = readJson(join(dir, "acceptance.json"));
		writers.push({
			task: dir.split("/").pop(),
			role: planned.agent.role,
			requests: result?.requests ?? null,
			outcome: result?.outcome ?? null,
			endedBy: result?.endedBy ?? null,
			collection: collected?.outcome ?? null,
			adopted: apply?.outcome ?? null,
			childAcceptance: childAcc === null ? null : childAcc.passed === true,
			workspaceAcceptance: workspaceAcc === undefined ? null : workspaceAcc.passed === true,
		});
	}
	return {
		delegateCalls: calls.length,
		explicitBackground: calls.filter((c) => c.input?.background === true).length,
		joins,
		wakes,
		parentRequests: events.filter((e) => e.type === "stop").length,
		writers,
	};
}

function mainLog(work) {
	const dir = join(work, "kiso-home", "sessions");
	const logs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("sub-")) : [];
	if (logs.length !== 1) throw new Error(`expected one kiso session log in ${dir}, found ${logs.length}`);
	return join(dir, logs[0]);
}

if (isMain(import.meta.url)) {
	const work = process.argv[2];
	process.stdout.write(`${JSON.stringify(subagentCounters(jsonl(mainLog(work)), taskDirs(work)))}\n`);
}
