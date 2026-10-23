import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { sessionFolders } from "@vincemakes/kiso-code/config";
import type { SessionMeta } from "@vincemakes/kiso-runtime";
import type { HistoryReply, WorkRow, WorkState } from "../shared/history.js";

/**
 * The history: every Work of every project folder under the kiso home, the
 * terminal's own layout (`projects/<enc>/`). Reading a folder's titles is
 * slow (see history-worker.ts), so it happens in a worker, one folder at a
 * time, the folder in use first, and a folder is read again only when its
 * files changed (count, bytes, newest write) and not more often than
 * `MIN_AGE_MS`. A request answers from what is read so far and says it is
 * still `scanning`.
 */

const MIN_AGE_MS = 3_000;
const MAX_ROWS = 400;

interface Read {
	readonly print: string;
	readonly metas: readonly SessionMeta[];
	readonly at: number;
}

/** What the host knows about a Work it holds open: a run live, or waiting for an answer. */
export type LiveState = (key: string, sessionId: string) => Promise<WorkState>;

/** The folder's files as one string: it changes when a log is added or written. */
function printOf(dir: string): string {
	let count = 0;
	let bytes = 0;
	let newest = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			const s = statSync(join(dir, name));
			if (s.size === 0) continue;
			count += 1;
			bytes += s.size;
			newest = Math.max(newest, s.mtimeMs);
		} catch {
			// gone between the listing and the stat
		}
	}
	return `${count}:${bytes}:${newest}`;
}

export class History {
	readonly #home: string;
	readonly #live: LiveState;
	readonly #reads = new Map<string, Read>();
	readonly #queue: string[] = [];
	#worker: Worker | null = null;
	#inflight: string | null = null;

	constructor(home: string, live: LiveState) {
		this.#home = home;
		this.#live = live;
	}

	/** `fresh` names a folder whose listing is read again now, whatever its age. */
	async snapshot(current: { readonly key: string; readonly dir: string }, fresh?: string): Promise<HistoryReply> {
		const rows: WorkRow[] = [];
		const now = Date.now();
		for (const folder of sessionFolders(this.#home)) {
			if (folder.kind !== "project" || folder.workspace === null) continue;
			let print: string;
			try {
				print = printOf(folder.dir);
			} catch {
				continue;
			}
			const read = this.#reads.get(folder.dir);
			const due = read === undefined || (read.print !== print && (now - read.at >= MIN_AGE_MS || fresh === basename(folder.dir)));
			if (due) this.#enqueue(folder.dir, folder.dir === current.dir);
			if (read === undefined) continue;
			const key = basename(folder.dir);
			for (const meta of read.metas) {
				rows.push({
					id: meta.id,
					key,
					folder: basename(folder.workspace),
					title: meta.title,
					createdAt: meta.createdAt,
					updatedAt: meta.updatedAt,
					events: meta.events,
					runs: meta.runs,
					state: "idle",
				});
			}
		}
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		const works = await Promise.all(rows.slice(0, MAX_ROWS).map(async (row) => ({ ...row, state: await this.#live(row.key, row.id) })));
		return { current: { key: current.key, folder: basename(current.dir) }, works, scanning: this.#inflight !== null || this.#queue.length > 0 };
	}

	#enqueue(dir: string, first: boolean): void {
		if (this.#inflight === dir || this.#queue.includes(dir)) return;
		if (first) this.#queue.unshift(dir);
		else this.#queue.push(dir);
		this.#pump();
	}

	#pump(): void {
		if (this.#inflight !== null) return;
		const dir = this.#queue.shift();
		if (dir === undefined) return;
		this.#inflight = dir;
		const print = printOf(dir);
		const worker = (this.#worker ??= new Worker(new URL("./history-worker.js", import.meta.url)));
		const done = (message: { readonly dir: string; readonly metas?: readonly SessionMeta[]; readonly error?: string }): void => {
			worker.off("message", done);
			// an unreadable folder is remembered empty: it is tried again when its files change
			this.#reads.set(dir, { print, metas: message.metas ?? [], at: Date.now() });
			this.#inflight = null;
			this.#pump();
		};
		worker.on("message", done);
		worker.once("error", (error: Error) => {
			this.#worker = null;
			done({ dir, error: error.message });
		});
		worker.postMessage({ dir });
	}

	close(): void {
		void this.#worker?.terminate();
		this.#worker = null;
	}
}
