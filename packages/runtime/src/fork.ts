/**
 * A fork (owner 2026-11-03: one rule for the terminal, the web app and the products that embed kiso): a new session
 * holding the conversation up to the end of one of the parent's runs, and nothing after it. It is the parent's local
 * files under a new id: the log's lines up to that run's `terminal`, byte for byte (no line names its session and none
 * chains to another), and a sidecar with the parent's execution profile, the name "… (fork)" and the fork's origin. Not
 * carried: the lock and the background tasks, which belong to the parent's process, and the parent's summary, which may
 * describe runs after the cut. The parent is only read; lines it appends meanwhile are after the cut. The sidecar is
 * written first: the runtime reads a session's profile before its first event.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readSessionName, tenantsOf, writeForkSidecar, type ForkOrigin } from "./profile.js";

/** A fork the store will not make, said in words (the caller shows them). */
export class ForkRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkRefusedError";
	}
}

/** The id a fork is given: the time to the second and four random characters, the way a session's id is made. */
const newId = (now = new Date()): string => `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;

/** Write a file whole or not at all: a temp file, its bytes synced, then renamed over the name. */
function durable(path: string, bytes: Buffer): void {
	const tmp = `${path}.fork-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** Fork `parent` in `root` after the run that ended at `afterSeq` (absent: the last finished run). */
export function forkSession(root: string, parent: string, afterSeq?: number): { readonly id: string; readonly origin: ForkOrigin } {
	let log: Buffer;
	try {
		log = readFileSync(join(root, `${parent}.jsonl`));
	} catch {
		throw new ForkRefusedError(`no session ${parent} to fork`);
	}
	// the lines, with where each ends, and the event each holds
	const lines: { readonly end: number; readonly seq: number; readonly type: string; readonly event: Record<string, unknown> }[] = [];
	for (let from = 0; from < log.length; ) {
		const nl = log.indexOf(10, from);
		if (nl < 0) break; // a line still being written is after any cut
		const event = (JSON.parse(log.subarray(from, nl).toString("utf8")) as { event: Record<string, unknown> }).event;
		lines.push({ end: nl + 1, seq: event["seq"] as number, type: event["type"] as string, event });
		from = nl + 1;
	}
	const cut = afterSeq === undefined ? [...lines].reverse().find((l) => l.type === "terminal") : lines.find((l) => l.seq === afterSeq);
	if (cut === undefined) throw new ForkRefusedError(afterSeq === undefined ? "this session has no finished run to fork from yet" : `no event ${afterSeq} in this session`);
	if (cut.type !== "terminal") throw new ForkRefusedError("a fork starts at the end of a run: pick a reply that finished");
	const kept = lines.filter((l) => l.end <= cut.end);
	// an execution still waiting for a verdict belongs to the world the parent ran in: settle it there first
	const resolved = new Set(kept.filter((l) => l.type === "tool_execution_resolved").map((l) => l.event["executionId"]));
	if (kept.some((l) => l.type === "uncertain_pending" && !resolved.has(l.event["executionId"]))) throw new ForkRefusedError("an action before this point is still waiting for your verdict in the original session: settle it there, then fork");
	// its name, else its first line (only this log is read)
	const first = kept.find((l) => l.type === "user_input")?.event as { content?: unknown; via?: { line?: unknown } } | undefined;
	const said = typeof first?.via?.line === "string" ? first.via.line : typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? (first.content as { text?: unknown }[]).map((p) => (typeof p.text === "string" ? p.text : "")).join(" ") : "";
	const title = readSessionName(root, parent) ?? said.replace(/\s+/g, " ").trim().slice(0, 60);
	const id = newId();
	const origin: ForkOrigin = { session: parent, afterSeq: cut.seq, at: Date.now(), title };
	writeForkSidecar(root, id, { profile: tenantsOf(root, parent)["profile"], name: `${(title || "Session").slice(0, 110)} (fork)`, forkedFrom: origin });
	durable(join(root, `${id}.jsonl`), log.subarray(0, cut.end));
	return { id, origin };
}

/**
 * What a fork's model is told, once, with the fork's first input after the copied history (never in the system prompt:
 * a cache is a prefix, and a note there made the fork's first request read the whole history fresh, 0% against 88%
 * measured on co, plan fork rev 2): what the conversation it continues does not bring with it.
 */
export const forkNote = (parentTitle: string): string =>
	`This session was forked from the session "${parentTitle}" at the end of one of its runs. The conversation above it is copied; two things are not. ` +
	"Background tasks started there are not running here (a task id from that conversation names nothing in this session). " +
	"The folder is shared with it: its files are as they are on disk now, not as they were when the run above ended, and the original session may still change them.";
