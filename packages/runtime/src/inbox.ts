import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One writer at a time per inbox, across processes: a directory made atomically, taken over when older than 10 s. */
async function locked<T>(dir: string, fn: () => T): Promise<T> {
	const lock = join(dir, ".lock");
	for (let tries = 0; ; tries++) {
		try {
			mkdirSync(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
			} catch {
				// it went between the two calls
			}
			if (tries > 300) throw new InboxRefusedError("the receiver's inbox is busy; send again in a moment");
			await sleep(10);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
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
		const path = join(dir, `${message.messageId}.json`);
		const tmp = join(dir, `.${message.messageId}.${process.pid}.tmp`);
		const fd = openSync(tmp, "w", 0o600);
		try {
			writeSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
		const dirFd = openSync(dir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
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

/** Delete an admitted message. A failure leaves litter, never a second admission: the log's id is checked first. */
export function removeMessage(root: string, sessionId: string, messageId: string): void {
	try {
		rmSync(join(inboxDir(root, sessionId), `${messageId}.json`), { force: true });
	} catch {
		// litter: deleted next time
	}
}
