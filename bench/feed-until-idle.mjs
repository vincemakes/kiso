#!/usr/bin/env node
/**
 * feed-until-idle — the stdin of a kiso bench leg that may run tasks
 * (0.46.0 evaluation, kiso-doc plan-0460-3f-evaluation).
 *
 * A leg used to be `printf prompt | kiso`: stdin ends at once, and the CLI
 * exits when the person's turn is done. With background tasks that is the
 * HARNESS ending the session — a clean exit stops every task — where a
 * person would have kept it open and been woken when the work ended. So the
 * leg's stdin stays open until the SESSION is idle: a run has ended, the
 * log's last event is that run's terminal, no task of the session is live,
 * and nothing has been written for QUIET_MS. Then stdin closes and the CLI
 * exits as it always did. The deadline closes it regardless.
 *
 * Both arms run under it: the control (no tasks) is idle as soon as its run
 * ended and the log went quiet — the same moment `printf` gave it, plus the
 * quiet window.
 *
 *   node feed-until-idle.mjs <sessions-dir> <session-id> <deadline-s> -- <line>...
 *
 * A task is live while its journal has no `terminal` (nor `stop_unconfirmed`)
 * and its recorded runner pid still exists — a runner that died without a
 * terminal is not waited for (its verdict is `unknown`, ADR-0058 §6). A
 * wait (ADR-0059) is live until `wait_fired` / `wait_expired`: it has no
 * runner, and its end restarts the quiet clock like any task end, so the
 * wake run it causes is waited for.
 *
 * The quiet window runs from the LATER of the log's last change and the
 * latest task end (eval-0460b amendment A1). A turn that dispatches
 * background work and ends goes quiet at once; when its last task ends
 * later, the session is idle at that instant, but the end's notice — a wake
 * run — lands a beat after (the manager's poll, the delivery window). Timing
 * the quiet from the log alone closed stdin in that beat and the CLI exited
 * before the wake: four of eval-0460b's six F1b legs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";

export const QUIET_MS = Number(process.env.FEED_QUIET_MS ?? 5_000);
const TICK_MS = 250;

/** The last event of a session log, and how many terminals it holds. */
export function logState(file) {
	if (!existsSync(file)) return { last: null, terminals: 0, size: 0 };
	const text = readFileSync(file, "utf8");
	let last = null;
	let terminals = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const ev = JSON.parse(line).event;
			if (ev?.type === "terminal") terminals += 1;
			last = ev ?? last;
		} catch {
			// a torn last line: the writer is mid-append — not idle
			last = { type: "torn" };
		}
	}
	return { last, terminals, size: text.length };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
};

/** Every task journal of the session: [id, records]. */
function journals(tasksDir) {
	if (!existsSync(tasksDir)) return [];
	const out = [];
	for (const id of readdirSync(tasksDir)) {
		const journal = join(tasksDir, id, "journal.jsonl");
		if (!existsSync(journal)) continue;
		const records = readFileSync(journal, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return {};
				}
			});
		out.push([id, records]);
	}
	return out;
}

/** A task has ended: a process's terminal, a stop nobody could confirm, or —
 *  ADR-0059 — a wait's event or deadline. A WAITING task has no runner and
 *  no terminal, so it is live (the session is not idle while a wait is
 *  pending — the chain's next wake is what the leg is waiting for). */
const ended = (r) => r.type === "terminal" || r.type === "stop_unconfirmed" || r.type === "wait_fired" || r.type === "wait_expired";

/** The ids of the session's live tasks. */
export function liveTasks(tasksDir, isAlive = alive) {
	const live = [];
	for (const [id, records] of journals(tasksDir)) {
		if (records.some(ended)) continue;
		const runner = records.find((r) => r.type === "runner_started");
		if (runner !== undefined && !isAlive(runner.pid)) continue; // gone without a terminal: unknown, not waited for
		live.push(id);
	}
	return live;
}

/** The latest task end (a `terminal` or `stop_unconfirmed` timestamp) in the session's journals, or null. */
export function lastTaskEnd(tasksDir) {
	let latest = null;
	for (const [, records] of journals(tasksDir)) {
		for (const r of records) if (ended(r) && typeof r.ts === "number" && (latest === null || r.ts > latest)) latest = r.ts;
	}
	return latest;
}

/** Close stdin now: idle, and quiet for QUIET_MS since the later of the log's
 *  last change and the latest task end (a task ending restarts the clock). */
export function shouldClose(sessionsDir, sessionId, now, logQuietSince, isAlive = alive) {
	const end = lastTaskEnd(join(sessionsDir, `${sessionId}.tasks`)) ?? 0;
	return now - Math.max(logQuietSince, end) >= QUIET_MS && idleNow(sessionsDir, sessionId, isAlive);
}

/** Idle: a run ended, its terminal is the last event, no task is live. */
export function idleNow(sessionsDir, sessionId, isAlive = alive) {
	const log = logState(join(sessionsDir, `${sessionId}.jsonl`));
	return log.terminals > 0 && log.last?.type === "terminal" && liveTasks(join(sessionsDir, `${sessionId}.tasks`), isAlive).length === 0;
}

async function main(argv) {
	const sep = argv.indexOf("--");
	const [sessionsDir, sessionId, deadlineS] = argv.slice(0, sep);
	const lines = argv.slice(sep + 1);
	if (sep < 0 || sessionsDir === undefined || sessionId === undefined || deadlineS === undefined) {
		console.error("usage: feed-until-idle.mjs <sessions-dir> <session-id> <deadline-s> -- <line>...");
		process.exit(2);
	}
	for (const line of lines) process.stdout.write(`${line}\n`);
	const deadline = Date.now() + Number(deadlineS) * 1000;
	const logFile = join(sessionsDir, `${sessionId}.jsonl`);
	let lastSize = -1;
	let quietSince = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, TICK_MS));
		if (Date.now() > deadline) break;
		const size = existsSync(logFile) ? statSync(logFile).size : 0;
		if (size !== lastSize) {
			lastSize = size;
			quietSince = Date.now();
			continue;
		}
		if (shouldClose(sessionsDir, sessionId, Date.now(), quietSince)) break;
	}
	process.stdout.end();
}

if (isMain(import.meta.url)) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(`feed-until-idle: ${err.message}`);
		process.exit(1);
	});
}
