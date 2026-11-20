import { createHash } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@vincemakes/kiso-core";
import { withDirLock } from "./dir-lock.js";
import { fsyncDir } from "./tasks/journal.js";

/**
 * ADR-0062 § 3–§ 4: the durable inbox. A session's log has one writer, so a message to it waits here, one file per message
 * (`<sessionId>.inbox/<messageId>.json`, written whole), until the receiver admits it; the admission in the receiver's log is
 * the durable fact, and only then is the file deleted (a file whose id the log already holds is deleted unread). Capacity is
 * checked and the file published under one lock, so racing senders never oversell the last slot; a send that was accepted is
 * never dropped afterwards.
 */

export interface PeerFile {
	readonly path: string;
	/** the file's revision when it was sent (the file tools' rev id) */
	readonly rev: string;
}

export interface PeerMessage {
	readonly messageId: string;
	/** the sender's address, `<folder key>/<session id>` */
	readonly from: string;
	readonly fromTitle: string;
	readonly text: string;
	readonly files: readonly PeerFile[];
	/** the causal chain this message belongs to (ADR-0062 § 6) */
	readonly rootId: string;
	readonly at: number;
	/** what it is: a message (the default), or the completion notice a child owes its parent (ADR-0062 § 7) */
	readonly event?: "message" | "completion";
	/** held for the person: a narrower sender to a wider receiver (ADR-0062 § 8); never delivered until released */
	readonly held?: true;
}

export const INBOX_LIMITS = { textBytes: 16 * 1024, files: 20, messages: 200, bytes: 1024 * 1024 } as const;

/** The send is refused: the reason, said to the sender. */
export class InboxRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InboxRefusedError";
	}
}

export const inboxDir = (root: string, sessionId: string): string => join(root, `${sessionId}.inbox`);
const isMessageFile = (name: string): boolean => name.endsWith(".json") && !name.startsWith(".");

/** One writer at a time per inbox, across processes (`dir-lock.ts`: a directory made atomically, a dead holder's taken over). */
const locked = <T>(dir: string, fn: () => T): Promise<T> =>
	withDirLock(join(dir, ".lock"), fn, () => new InboxRefusedError("the receiver's inbox is busy; send again in a moment"));

/** A message file, whole: temp, fsync, rename, then the directory entry (on POSIX; Windows opens no directory as a file, the
 *  task journal's rule). */
function publish(dir: string, messageId: string, bytes: Buffer): void {
	const tmp = join(dir, `.${messageId}.${process.pid}.tmp`);
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, join(dir, `${messageId}.json`));
	fsyncDir(dir);
}

/** Write a message into the receiver's inbox. "duplicate" when that id is already there (a replayed send). */
export async function writeMessage(root: string, sessionId: string, message: PeerMessage): Promise<"written" | "duplicate"> {
	if (Buffer.byteLength(message.text) > INBOX_LIMITS.textBytes) throw new InboxRefusedError(`the message is ${Buffer.byteLength(message.text)} bytes; the limit is ${INBOX_LIMITS.textBytes}`);
	if (message.files.length > INBOX_LIMITS.files) throw new InboxRefusedError(`${message.files.length} files; the limit is ${INBOX_LIMITS.files}`);
	const dir = inboxDir(root, sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const bytes = Buffer.from(JSON.stringify(message));
	return locked(dir, () => {
		const names = readdirSync(dir).filter(isMessageFile);
		if (names.includes(`${message.messageId}.json`)) return "duplicate";
		let held = 0;
		for (const name of names) {
			try {
				held += statSync(join(dir, name)).size;
			} catch {
				// admitted and deleted meanwhile
			}
		}
		if (names.length >= INBOX_LIMITS.messages || held + bytes.length > INBOX_LIMITS.bytes) throw new InboxRefusedError("the receiver's inbox is full; send later");
		publish(dir, message.messageId, bytes);
		return "written";
	});
}

/** The inbox, oldest first; an unreadable file is skipped (it is tried again next time). */
export function readInbox(root: string, sessionId: string): PeerMessage[] {
	const dir = inboxDir(root, sessionId);
	let names: string[];
	try {
		names = readdirSync(dir).filter(isMessageFile);
	} catch {
		return [];
	}
	const messages: PeerMessage[] = [];
	for (const name of names) {
		try {
			const m = JSON.parse(readFileSync(join(dir, name), "utf8")) as PeerMessage;
			if (typeof m.messageId === "string" && typeof m.text === "string" && `${m.messageId}.json` === name) messages.push(m);
		} catch {
			// half there, or gone
		}
	}
	return messages.sort((a, b) => a.at - b.at || (a.messageId < b.messageId ? -1 : 1));
}

/** ADR-0062 § 8: the person admits a held message: it is written again without the hold (whole, temp + rename), so the
 *  receiver's next look delivers it. False when it is not there or not held. */
export async function releaseMessage(root: string, sessionId: string, messageId: string): Promise<boolean> {
	const dir = inboxDir(root, sessionId);
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false; // no inbox: nothing held (finding G3)
	return locked(dir, () => {
		const m = readInbox(root, sessionId).find((x) => x.messageId === messageId);
		if (m === undefined || m.held !== true) return false;
		const { held: _, ...free } = m;
		publish(dir, messageId, Buffer.from(JSON.stringify(free))); // durable as the first write was (finding G3)
		return true;
	});
}

/** Delete an admitted message. A failure leaves litter, never a second admission: the log's id is checked first. */
export function removeMessage(root: string, sessionId: string, messageId: string): void {
	try {
		rmSync(join(inboxDir(root, sessionId), `${messageId}.json`), { force: true });
	} catch {
		// litter: deleted next time
	}
}

/** A file's revision as the file tools print it (`rev:` + the first 16 hex of sha256), read as a stream so a large file never
 *  sits in memory (ADR-0062 § 3). */
export async function fileRevision(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `rev:${hash.digest("hex").slice(0, 16)}`;
}

/** A message's id: the sender's address, the call, the receiver's address and the text (ADR-0062 § 5). */
export const peerMessageId = (from: string, callId: string, to: string, text: string): string =>
	createHash("sha256").update(`${from}\n${callId}\n${to}\n${text}`).digest("hex").slice(0, 24);

/**
 * ADR-0062 § 5: a send cut off by a crash is resolved "rerun", which tells the model it did not land, so the model sends it
 * again in a new call, with a new call id. If the first attempt had already reached the inbox, a new id would be a second
 * message. So a send whose `to`, `text` and `files` match a `message` call resolved "rerun" (and not since re-sent) takes that
 * call's id: the inbox calls it a duplicate, or the receiver's log already holds it, and the receiver takes it once.
 */
export function retriedSendCallId(events: readonly Event[], input: { readonly to: string; readonly text: string; readonly files?: readonly string[] }): string | undefined {
	const keyOf = (i: unknown): string => {
		const x = (i ?? {}) as { to?: unknown; text?: unknown; files?: unknown };
		return JSON.stringify([x.to, x.text, x.files ?? []]);
	};
	const sends = new Map<string, string>();
	const open: string[] = [];
	for (const e of events) {
		if (e.type === "tool_call_end" && e.name === "message") sends.set(e.callId, keyOf(e.input));
		else if (e.type === "tool_execution_resolved" && e.resolution === "rerun" && sends.has(e.callId)) open.push(e.callId);
		else if (e.type === "tool_result" && !e.isError && sends.has(e.callId)) {
			const at = open.findIndex((c) => sends.get(c) === sends.get(e.callId));
			if (at >= 0) open.splice(at, 1);
		}
	}
	return open.find((c) => sends.get(c) === keyOf(input));
}
