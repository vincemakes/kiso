/**
 * SessionStore — append-only JSONL durability (Reliable Session Alpha).
 *
 * One file per session: `<root>/<id>.jsonl`. Every line is
 * `{"runId": string, "ts": number, "event": Event}` — the run id rides on
 * the envelope so the event union stays pure (ADR-0003), and every record
 * is attributable to a run and a wall-clock moment for audit.
 *
 * Durability contract: `append` writes the line and fsyncs the file BEFORE
 * it returns — the consumer may publish the event only after this call. A
 * crash mid-write leaves a partial tail line; `load` skips it and returns
 * the contiguous prefix. A record that was never fsynced did not happen.
 *
 * Synchronous on purpose: the durability point must not be able to slip
 * behind the publish point (pi's event-queue swallow failure).
 */

import {
	appendFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Event } from "@kiso/core";

/** A durable record: the run that produced it, and the event itself. */
export interface StoreRecord {
	readonly runId: string;
	readonly ts: number;
	readonly event: Event;
}

export interface SessionMeta {
	readonly id: string;
	readonly title: string;
	readonly events: number;
	readonly runs: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Session ids become file names — keep them host-safe. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class SessionStore {
	readonly root: string;
	readonly #fds = new Map<string, number>();

	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
	}

	private pathFor(sessionId: string): string {
		if (!ID_PATTERN.test(sessionId)) {
			throw new Error(`invalid session id: ${sessionId}`);
		}
		return join(this.root, `${sessionId}.jsonl`);
	}

	private fd(sessionId: string): number {
		let fd = this.#fds.get(sessionId);
		if (fd === undefined) {
			fd = openSync(this.pathFor(sessionId), "a");
			this.#fds.set(sessionId, fd);
		}
		return fd;
	}

	/** Write-ahead: durable (written + fsynced) before returning. */
	append(sessionId: string, runId: string, event: Event): void {
		const fd = this.fd(sessionId);
		appendFileSync(fd, `${JSON.stringify({ runId, ts: Date.now(), event })}\n`);
		fsyncSync(fd);
	}

	/** Replay the contiguous prefix of a session's log. */
	load(sessionId: string): StoreRecord[] {
		const path = this.pathFor(sessionId);
		if (!existsSync(path)) return [];
		const raw = readFileSync(path, "utf8");
		const records: StoreRecord[] = [];
		for (const line of raw.split("\n")) {
			if (line === "") continue;
			try {
				const parsed = JSON.parse(line) as StoreRecord;
				if (parsed && typeof parsed.runId === "string" && parsed.event && typeof parsed.event.type === "string") {
					records.push(parsed);
				}
			} catch {
				// Partial tail line from a crash mid-write — the prefix is
				// the truth; anything after it never became durable.
				break;
			}
		}
		return records;
	}

	has(sessionId: string): boolean {
		return existsSync(this.pathFor(sessionId));
	}

	list(): SessionMeta[] {
		const metas: SessionMeta[] = [];
		for (const entry of readdirSync(this.root)) {
			if (!entry.endsWith(".jsonl")) continue;
			const id = entry.slice(0, -".jsonl".length);
			const records = this.load(id);
			if (records.length === 0) continue;
			const first = records[0]!.event;
			metas.push({
				id,
				title:
					first.type === "user_input" && typeof first.content === "string"
						? first.content.slice(0, 60)
						: "(no prompt)",
				events: records.length,
				runs: new Set(records.map((r) => r.runId)).size,
				createdAt: records[0]?.ts ?? 0,
				updatedAt: records.at(-1)?.ts ?? 0,
			});
		}
		return metas.sort((a, b) => a.id.localeCompare(b.id));
	}
}
