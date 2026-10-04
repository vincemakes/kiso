#!/usr/bin/env node
/**
 * tasks-counters.mjs <work> — what a kiso leg did with tasks (the 0.46.0
 * evaluation's "counted on every leg", ADR-0058 §11), read from the leg's
 * own durable records: the session logs and the task journals under
 * <work>/kiso-home/sessions. A leg of a build without tasks counts zeros.
 *
 *   promotions          a foreground command continued as a task (waited or ready)
 *   detaches            moved to the background by the person or a steer (3e)
 *   backgroundStarts    shell `background: true` and background delegate calls
 *   backgroundShort     tasks started with `background: true` that ended in under 5 s
 *   aliasHits           shell calls that passed the deprecated `timeoutMs`
 *   notices             task notices admitted (user_input via tasks)
 *   wakes / oneRequestWakes  runs whose first input was a notice; of those, the ones with one request
 *   children            background agent tasks: each one's requests (its `stop` events) and outcome
 *   cacheHit            cacheRead / inputTokens over every request of the leg (children included)
 *   usagePerRequest     usage events per `stop` event in the main session (1 = one usage per request)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

const lines = (file) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l.trim() !== "")
				.flatMap((l) => {
					try {
						return [JSON.parse(l)];
					} catch {
						return [];
					}
				})
		: [];
const eventsOf = (file) => lines(file).map((r) => r.event ?? r);

const percentile = (xs, p) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function counters(work) {
	const dir = join(work, "kiso-home", "sessions");
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
	const main = files.filter((f) => !f.startsWith("sub-"));
	const out = {
		promotions: 0,
		detaches: 0,
		backgroundStarts: 0,
		backgroundShort: 0,
		aliasHits: 0,
		notices: 0,
		wakes: 0,
		oneRequestWakes: 0,
		children: { count: 0, requests: [], p50: null, p90: null, max: null, budgetSpent: 0, outcomes: {} },
		cacheHit: null,
		usagePerRequest: null,
	};
	let input = 0;
	let cache = 0;
	for (const f of files) {
		for (const e of eventsOf(join(dir, f))) {
			if (e.type === "usage" && typeof e.inputTokens === "number" && typeof e.cacheRead === "number") {
				input += e.inputTokens;
				cache += e.cacheRead;
			}
		}
	}
	out.cacheHit = input > 0 ? Math.round((cache / input) * 1000) / 1000 : null;
	for (const f of main) {
		const events = eventsOf(join(dir, f));
		let usages = 0;
		let stops = 0;
		// runs: the events between terminals
		let runFirst = null;
		let runStops = 0;
		const closeRun = () => {
			if (runFirst?.via?.kind === "tasks") {
				out.wakes += 1;
				if (runStops === 1) out.oneRequestWakes += 1;
			}
			runFirst = null;
			runStops = 0;
		};
		for (const e of events) {
			if (e.type === "usage") usages += 1;
			if (e.type === "stop") {
				stops += 1;
				runStops += 1;
			}
			if (e.type === "user_input") {
				if (runFirst === null) runFirst = e;
				if (e.via?.kind === "tasks") out.notices += 1;
			}
			if (e.type === "terminal") closeRun();
			if (e.type === "tool_call_end") {
				const input = e.input ?? {};
				if (e.name === "shell" && input.timeoutMs !== undefined) out.aliasHits += 1;
				if ((e.name === "shell" || e.name === "delegate") && input.background === true) out.backgroundStarts += 1;
			}
			if (e.type === "tool_result" && typeof e.content === "string") {
				if (/^(still running after \d+ ms|ready — the output contains)/.test(e.content) && e.content.includes("continued as background task")) out.promotions += 1;
				if (/^moved to the background (by the person|so the person's message could land)/.test(e.content)) out.detaches += 1;
			}
		}
		closeRun();
		if (stops > 0) out.usagePerRequest = Math.round((usages / stops) * 100) / 100;
		// the session's tasks
		const tasksDir = join(dir, f.replace(/\.jsonl$/, ".tasks"));
		if (!existsSync(tasksDir)) continue;
		for (const id of readdirSync(tasksDir)) {
			const records = lines(join(tasksDir, id, "journal.jsonl"));
			const planned = records.find((r) => r.type === "planned");
			const terminal = records.find((r) => r.type === "terminal");
			if (planned === undefined) continue;
			if (planned.backend === "process" && planned.agent === undefined && terminal !== undefined && terminal.ts - planned.ts < 5_000) out.backgroundShort += 1;
			if (planned.agent !== undefined) {
				out.children.count += 1;
				const childEvents = eventsOf(join(dir, `${planned.agent.session}.jsonl`));
				out.children.requests.push(childEvents.filter((e) => e.type === "stop").length);
				let outcome = "no result";
				try {
					outcome = JSON.parse(readFileSync(join(tasksDir, id, "result.json"), "utf8")).outcome ?? outcome;
				} catch {
					// no result.json: the child wrote none
				}
				out.children.outcomes[outcome] = (out.children.outcomes[outcome] ?? 0) + 1;
				if (outcome === "incomplete") out.children.budgetSpent += 1;
			}
		}
	}
	const r = out.children.requests;
	out.children.p50 = percentile(r, 50);
	out.children.p90 = percentile(r, 90);
	out.children.max = r.length === 0 ? null : Math.max(...r);
	return out;
}

if (isMain(import.meta.url)) {
	console.log(JSON.stringify(counters(process.argv[2]), null, 1));
}
