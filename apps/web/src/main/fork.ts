import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./files.js";
import type { Fork, Settings } from "./settings.js";
import type { Space } from "./space.js";

/**
 * Fork a Work: a new Work holding the conversation up to the end of one of its runs. It is the parent's local files under a new id:
 * the log's lines up to that run's `terminal`, byte for byte (no line names its session and none chains to another), and its
 * `.meta.json` (the execution profile the runtime needs before a first event) with the name made "… (fork)". Not copied: the lock
 * and the background tasks, which belong to the parent's process. The fork starts with the parent's tier, model and effort, and the
 * host remembers where it came from (history, not authority). The parent is only read; lines it appends meanwhile are after the cut.
 */

const ID = (now = new Date()): string => `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;

/** Write a file whole or not at all: a temp file, its bytes synced, then renamed over the name (the store's own discipline). */
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

export function forkWork(space: Space, settings: Settings, parent: string, atSeq: number | undefined): { readonly id: string; readonly fork: Fork } {
	if (!space.store.ids().includes(parent)) throw new Refusal(404, "no such Work in this folder");
	const log = readFileSync(join(space.dir, `${parent}.jsonl`));
	// the lines, with where each ends, and the event each holds
	const lines: { readonly end: number; readonly seq: number; readonly type: string; readonly event: Record<string, unknown> }[] = [];
	for (let from = 0; from < log.length; ) {
		const nl = log.indexOf(10, from);
		if (nl < 0) break; // a line still being written is after any cut
		const event = (JSON.parse(log.subarray(from, nl).toString("utf8")) as { event: Record<string, unknown> }).event;
		lines.push({ end: nl + 1, seq: event["seq"] as number, type: event["type"] as string, event });
		from = nl + 1;
	}
	const cut = atSeq === undefined ? [...lines].reverse().find((l) => l.type === "terminal") : lines.find((l) => l.seq === atSeq);
	if (cut === undefined) throw new Refusal(409, atSeq === undefined ? "this Work has no finished run to fork from yet" : `no event ${atSeq} in this Work`);
	if (cut.type !== "terminal") throw new Refusal(409, "a fork starts at the end of a run: pick a reply that finished");
	const kept = lines.filter((l) => l.end <= cut.end);
	// an execution still waiting for a verdict belongs to the world the parent ran in: settle it there first
	const resolved = new Set(kept.filter((l) => l.type === "tool_execution_resolved").map((l) => l.event["executionId"]));
	if (kept.some((l) => l.type === "uncertain_pending" && !resolved.has(l.event["executionId"]))) throw new Refusal(409, "an action before this point is still waiting for your verdict in the original Work: settle it there, then fork");
	const id = ID();
	let meta: Record<string, unknown> = {};
	try {
		meta = JSON.parse(readFileSync(join(space.dir, `${parent}.meta.json`), "utf8")) as Record<string, unknown>;
	} catch {
		// a legacy Work with no sidecar: the fork's runtime writes its own on first open
	}
	// its name, else its first line (only this log is read: the store's listing reads every log in the folder whole)
	const first = kept.find((l) => l.type === "user_input")?.event as { content?: unknown; via?: { line?: unknown } } | undefined;
	const said = typeof first?.via?.line === "string" ? first.via.line : typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? (first.content as { text?: unknown }[]).map((p) => (typeof p.text === "string" ? p.text : "")).join(" ") : "";
	const title = typeof meta["name"] === "string" ? meta["name"] : said.replace(/\s+/g, " ").trim().slice(0, 60);
	// the profile first, then the log: the runtime reads a session's profile before its first event
	durable(join(space.dir, `${id}.meta.json`), Buffer.from(`${JSON.stringify({ ...meta, name: `${(title || "Work").slice(0, 110)} (fork)` })}\n`));
	durable(join(space.dir, `${id}.jsonl`), log.subarray(0, cut.end));
	const fork: Fork = { parent, title, atSeq: cut.seq, at: Date.now() };
	settings.forked(parent, id, fork);
	return { id, fork };
}

/** A Work's fork notice, when it is a fork (its system prompt's last part, and the Context breakdown's share of it). */
export const forkNoteOf = (settings: Settings, session: string | undefined): string | undefined => {
	const fork = session === undefined ? undefined : settings.forkOf(session);
	return fork === undefined ? undefined : forkNote(fork.title);
};

/** What a forked Work's model is told, in its system prompt: what the conversation it continues does not bring with it. */
export const forkNote = (parentTitle: string): string =>
	`This Work was forked from the Work "${parentTitle}" at the end of one of its runs. The conversation above it is copied; two things are not. ` +
	"Background tasks started there are not running here (a task id from that conversation names nothing in this Work). " +
	"The folder is shared with it: its files are as they are on disk now, not as they were when the run above ended, and the original Work may still change them.";
