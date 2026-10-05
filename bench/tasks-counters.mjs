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
 *   backgroundShort     tasks started with `background: true` that ended in under 5 s, not
 *                       counting tasks the model stopped itself (0460-I2: those are servers)
 *   aliasHits           shell calls that passed the deprecated `timeoutMs`; null on a build
 *                       before 0.46.0, where `timeoutMs` is the native parameter (0460-I3)
 *   notices             task notices admitted (user_input via tasks)
 *   wakes / oneRequestWakes  runs whose first input was a notice; of those, the ones with one request
 *   wakeRequests        the requests of each wake run, in order
 *   postFinalRequests   requests in a run after a `stop: end_turn` whose only new input is a
 *                       task notice — a request that only answers a notice (0460-I4)
 *   readyRace           tool executions that started after a `background` + `readyWhen` start
 *                       and before the model was TOLD the task's state (0460-I5). A result
 *                       that states it — ready, not ready yet, ended before ready, stopped
 *                       waiting — tells at the result; the 0.46.0 rc's bare "started
 *                       background task tN." told nothing, so there the first `ready` notice
 *                       tells, else the task's end. Told, not physically ready: a server that
 *                       binds in milliseconds is ready before any probe, so a count against the
 *                       `ready` record reads 0 on the very defect it is for.
 *   sleepCalls          shell calls that sleep (`sleep N`)
 *   outputPolls         reads of a task's output file (read_file, or a shell command naming it)
 *   children            background agent tasks: each one's requests (its `stop` events) and outcome;
 *                       `leftRunning`: those whose journal holds no terminal when the leg is counted
 *   groups              background children grouped by the model response that started them:
 *                       `members` per group, `deliveries` (notices carrying a child), and
 *                       `deliveredOnce` (every child named in exactly one notice)
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
/** Events with their record's timestamp (the session log keeps `ts` beside the event). */
const timedEventsOf = (file) => lines(file).map((r) => ({ ts: r.ts ?? null, e: r.event ?? r }));

/** The build the leg ran: meta.json (run-task.sh), else the request trace's header. */
function legVersion(work) {
	try {
		const v = JSON.parse(readFileSync(join(work, "meta.json"), "utf8")).kisoVersion;
		if (typeof v === "string" && v !== "") return v;
	} catch {
		// no meta.json: fall back to the trace
	}
	const traces = join(work, "kiso-home", "sessions", "traces");
	if (!existsSync(traces)) return null;
	for (const f of readdirSync(traces)) {
		const header = lines(join(traces, f)).find((r) => r.kind === "header");
		if (typeof header?.kisoVersion === "string") return header.kisoVersion;
	}
	return null;
}

/** 0460-I3: `foregroundMs` (and the `timeoutMs` alias) arrived in 0.46.0. */
const hasForegroundMs = (version) => {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
	if (m === null) return null;
	const [major, minor] = [Number(m[1]), Number(m[2])];
	return major > 0 || minor >= 46;
};

const SLEEP = /(^|[\s;&|(])sleep\s+\d/;
const TASK_OUTPUT = /\.tasks\/t\d+\/output\.log/;

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
		wakeRequests: [],
		postFinalRequests: 0,
		readyRace: 0,
		sleepCalls: 0,
		outputPolls: 0,
		children: { count: 0, requests: [], p50: null, p90: null, max: null, budgetSpent: 0, outcomes: {}, leftRunning: 0 },
		groups: { count: 0, members: [], deliveries: 0, deliveredOnce: null },
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
	const aliasCounted = hasForegroundMs(legVersion(work));
	if (aliasCounted === false) out.aliasHits = null;
	const delivered = new Map(); // child task id → notices naming it
	for (const f of main) {
		const timed = timedEventsOf(join(dir, f));
		const events = timed.map((t) => t.e);
		let usages = 0;
		let stops = 0;
		// runs: the events between terminals
		let runFirst = null;
		let runStops = 0;
		// 0460-I4: after a final answer, a request whose only new input is a notice
		let afterFinal = false;
		let noticeSince = false;
		const closeRun = () => {
			if (runFirst?.via?.kind === "tasks") {
				out.wakes += 1;
				out.wakeRequests.push(runStops);
				if (runStops === 1) out.oneRequestWakes += 1;
			}
			runFirst = null;
			runStops = 0;
			afterFinal = false;
			noticeSince = false;
		};
		const readyStarts = []; // { ts, executionId } of background + readyWhen starts
		const startedAt = []; // { ts, executionId } of every tool execution
		const resultOf = new Map(); // executionId → tool_result content
		const resultTs = new Map(); // executionId → its tool_result's timestamp
		const readyNoticeTs = new Map(); // task id → the first notice that it is ready
		const segmentOf = new Map(); // tool_call_end seq → the model response it belongs to
		const executionSeq = new Map(); // executionId → its tool_call_end seq
		let segment = 0;
		for (const { ts, e } of timed) {
			if (e.type === "usage") usages += 1;
			if (e.type === "stop") {
				stops += 1;
				runStops += 1;
				segment += 1;
				if (afterFinal && noticeSince) out.postFinalRequests += 1;
				noticeSince = false;
				afterFinal = e.reason === "end_turn";
			}
			if (e.type === "user_input") {
				if (runFirst === null) runFirst = e;
				if (e.via?.kind === "tasks") {
					out.notices += 1;
					if (afterFinal) noticeSince = true;
					for (const item of e.via.items ?? []) {
						delivered.set(item.taskId, (delivered.get(item.taskId) ?? 0) + 1);
						if (item.transition === "ready" && !readyNoticeTs.has(item.taskId)) readyNoticeTs.set(item.taskId, ts);
					}
				} else afterFinal = false; // the person spoke: a new turn, not an acknowledgement
			}
			if (e.type === "terminal") closeRun();
			if (e.type === "tool_call_end") {
				const input = e.input ?? {};
				if (e.name === "shell" && input.timeoutMs !== undefined && aliasCounted !== false) out.aliasHits += 1;
				if ((e.name === "shell" || e.name === "delegate") && input.background === true) out.backgroundStarts += 1;
				if (typeof e.seq === "number") segmentOf.set(e.seq, segment);
			}
			if (e.type === "tool_execution_started") {
				const input = e.input ?? {};
				startedAt.push({ ts, executionId: e.executionId });
				if (typeof e.invocationSeq === "number") executionSeq.set(e.executionId, e.invocationSeq);
				if (e.name === "shell" && input.background === true && typeof input.readyWhen === "string") readyStarts.push({ ts, executionId: e.executionId });
				const text = e.name === "shell" ? String(input.command ?? "") : e.name === "read_file" ? String(input.path ?? "") : "";
				if (e.name === "shell" && SLEEP.test(text)) out.sleepCalls += 1;
				if (TASK_OUTPUT.test(text)) out.outputPolls += 1;
			}
			if (e.type === "tool_result" && typeof e.content === "string") {
				if (e.executionId !== undefined) {
					resultOf.set(e.executionId, e.content);
					resultTs.set(e.executionId, ts);
				}
				if (/^(still running after \d+ ms|ready — the output contains)/.test(e.content) && e.content.includes("continued as background task")) out.promotions += 1;
				if (/^moved to the background (by the person|so the person's message could land)/.test(e.content)) out.detaches += 1;
			}
		}
		closeRun();
		if (stops > 0) out.usagePerRequest = Math.round((usages / stops) * 100) / 100;
		// the session's tasks
		const tasksDir = join(dir, f.replace(/\.jsonl$/, ".tasks"));
		if (!existsSync(tasksDir)) continue;
		const journals = new Map(readdirSync(tasksDir).map((id) => [id, lines(join(tasksDir, id, "journal.jsonl"))]));
		// 0460-I5: a tool execution that started between a ready-wait start and the moment
		// the model was told the task's state
		for (const start of readyStarts) {
			const result = resultOf.get(start.executionId) ?? "";
			const id = /background task (t\d+)/.exec(result)?.[1];
			const records = id === undefined ? [] : (journals.get(id) ?? []);
			const toldNothing = /^started background task t\d+\.\s/.test(result);
			const told = !toldNothing
				? (resultTs.get(start.executionId) ?? start.ts)
				: ((id !== undefined ? readyNoticeTs.get(id) : undefined) ?? records.find((r) => r.type === "terminal")?.ts ?? Number.POSITIVE_INFINITY);
			out.readyRace += startedAt.filter((s) => s.executionId !== start.executionId && s.ts !== null && start.ts !== null && s.ts > start.ts && s.ts < told).length;
		}
		const groups = new Map(); // response segment → member ids
		for (const [id, records] of journals) {
			const planned = records.find((r) => r.type === "planned");
			const terminal = records.find((r) => r.type === "terminal");
			if (planned === undefined) continue;
			const modelStopped = records.some((r) => r.type === "stop_requested" && r.by === "model");
			if (planned.backend === "process" && planned.agent === undefined && terminal !== undefined && terminal.ts - planned.ts < 5_000 && !modelStopped) out.backgroundShort += 1;
			if (planned.agent !== undefined) {
				if (terminal === undefined) out.children.leftRunning += 1;
				const seq = executionSeq.get(planned.executionId);
				const key = seq === undefined ? `alone:${id}` : `segment:${segmentOf.get(seq) ?? "?"}`;
				groups.set(key, [...(groups.get(key) ?? []), id]);
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
		for (const members of groups.values()) out.groups.members.push(members.length);
		const childIds = [...groups.values()].flat();
		if (childIds.length > 0) {
			out.groups.deliveredOnce = (out.groups.deliveredOnce ?? true) && childIds.every((id) => delivered.get(id) === 1);
		}
		out.groups.count += groups.size;
		for (const { e } of timed) {
			if (e.type === "user_input" && e.via?.kind === "tasks" && (e.via.items ?? []).some((i) => childIds.includes(i.taskId))) out.groups.deliveries += 1;
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
