/**
 * The 0.40.0 dogfood (item 2) — a session's SUMMARY, the one thing the
 * session list reads.
 *
 * The list used to read every session's whole event log, three times, to
 * draw one row each: on the owner's machine that is 118 sessions, 584 MB,
 * 3.58M events, about 8.3 s before the picker appears. The sidecar the
 * session already keeps (`<id>.meta.json`) is read in 2 ms for all 118. So
 * the list reads the sidecar ONLY, and the sidecar carries what the row
 * shows, as its own tenant beside the execution profile:
 *
 *   title, turns, last activity, state (open or the terminal's outcome),
 *   uncertain executions, pending asks, whether the workspace is unknown,
 *   and where the summary came from (a run, or the one-time migration).
 *
 * The runtime writes it at a run's start (state open — a run killed there
 * reads "interrupted" in the list, which is the truth) and at its end. It
 * is OBSERVATION: nothing in recovery, projection or a request reads it
 * (the §6 purity rule), and a failed write never fails a run.
 *
 * `sessionSummary` is a pure function of the durable records, shared by the
 * live writes and the one-time migration so the two can never disagree.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "@vincemakes/kiso-core";
import { readProfile, readSessionName, readSummary, writeSummary } from "./profile.js";
import { executionLedger } from "./ledger.js";
import { openRunId } from "./recovery.js";
import { sessionTitle, type StoreRecord } from "./store.js";

export interface SessionSummary {
	/** the session's first substantive prompt (`sessionTitle`); null when unknown */
	readonly title: string | null;
	/** user turns; null when unknown (an unreadable log) */
	readonly turns: number | null;
	/** ms since the epoch — the last record's stamp, or the file's mtime */
	readonly updatedAt: number;
	/** "open" while a run has no terminal event; else the terminal's outcome kind */
	readonly state: string | null;
	readonly uncertain: number;
	readonly asks: number;
	/** the profile records no workspace (a session from before 0.40.0) */
	readonly workspaceUnknown: boolean;
	/** "run" — written by a run; "migration" — the one-time pass over a legacy log */
	readonly source: "run" | "migration";
}

/** Pending asks from the records alone: a permission request of the OPEN
 *  run with no decision and no expiry — the session's own rule, restated
 *  over records so the migration needs no live session. */
function pendingAsks(records: readonly StoreRecord[]): number {
	const open = openRunId(records);
	if (open === undefined) return 0;
	const decided = new Set<string>();
	const requested = new Set<string>();
	for (const r of records) {
		const e = r.event as Event & { decisionId?: string };
		if (e.type === "permission_requested" && r.runId === open && typeof e.decisionId === "string") requested.add(e.decisionId);
		else if ((e.type === "permission_decided" || e.type === "permission_expired") && typeof e.decisionId === "string") decided.add(e.decisionId);
	}
	let n = 0;
	for (const id of requested) if (!decided.has(id)) n += 1;
	return n;
}

/** The summary of a session's events — the core both writers share.
 *  `open`, `updatedAt` and `asks` come from whoever knows them: a live
 *  session knows its own run and its resolvers; the migration derives
 *  them from the records. */
export function summarizeEvents(
	events: readonly Event[],
	opts: { open: boolean; updatedAt: number; asks: number; workspaceUnknown: boolean; source: "run" | "migration" },
): SessionSummary {
	let state: string | null = opts.open ? "open" : null;
	if (!opts.open) {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const e = events[i]!;
			if (e.type === "terminal") {
				state = (e as { outcome: { kind: string } }).outcome.kind;
				break;
			}
		}
	}
	const title = sessionTitle(events.map((event) => ({ runId: "", ts: 0, event }) as StoreRecord));
	return {
		title: title === "(no prompt)" ? null : title,
		turns: events.filter((e) => e.type === "user_input").length,
		updatedAt: opts.updatedAt,
		state,
		uncertain: [...executionLedger(events).values()].filter((x) => x.status === "uncertain").length,
		asks: opts.asks,
		workspaceUnknown: opts.workspaceUnknown,
		source: opts.source,
	};
}

/** The summary of a session's durable RECORDS — the one-time migration's
 *  input (a legacy log read exactly once, never through a live session). */
export function sessionSummary(records: readonly StoreRecord[], opts: { workspaceUnknown: boolean; source: "run" | "migration"; fallbackUpdatedAt?: number }): SessionSummary {
	return summarizeEvents(
		records.map((r) => r.event),
		{
			open: openRunId(records) !== undefined,
			updatedAt: records.at(-1)?.ts ?? opts.fallbackUpdatedAt ?? 0,
			asks: pendingAsks(records),
			workspaceUnknown: opts.workspaceUnknown,
			source: opts.source,
		},
	);
}

// ── the list's read path, and the one-time migration ───────────────────


/** The migration's marker: written once every legacy session has a
 *  summary. From then on the list never reads a log (lead's ruling A): a
 *  session still without a summary shows "no summary". */
export const SUMMARY_MIGRATION_MARKER = ".summaries-migrated";

export interface SessionListing {
	readonly id: string;
	/** the log file's mtime — the last-activity fallback, never a guess at content */
	readonly mtime: number;
	readonly summary: SessionSummary | null;
	readonly workspace: string | null;
	readonly profileName: string | null;
	/** Graphite R3d: the name the person gave it (`/name`), or null —
	 *  optional, so a listing built before names existed still types */
	readonly name?: string | null;
}

/** Every session in `root`, from the DIRECTORY and the sidecars only — no
 *  log is opened. The 0.40.0 dogfood's list path. */
export function listSessionSidecars(root: string): SessionListing[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const out: SessionListing[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".jsonl")) continue;
		const id = entry.slice(0, -".jsonl".length);
		let mtime = 0;
		try {
			const st = statSync(join(root, entry));
			if (st.size === 0) continue; // an empty log is no session (the old list skipped it too)
			mtime = st.mtimeMs;
		} catch {
			continue;
		}
		const profile = readProfile(root, id);
		out.push({
			id,
			mtime,
			summary: readSummary(root, id),
			workspace: profile.kind === "ok" ? profile.profile.workspace : null,
			profileName: profile.kind === "ok" ? profile.profile.profileName : null,
			name: readSessionName(root, id),
		});
	}
	return out;
}

/** Whether the one-time migration still has work: the marker is absent. */
export function summaryMigrationPending(root: string): boolean {
	return !existsSync(join(root, SUMMARY_MIGRATION_MARKER));
}

/**
 * The ONE-TIME migration (lead's ruling A). Each session without a summary
 * has its log read exactly once — through the store's plain loader, never a
 * live session, so the profile contract cannot throw it — and its summary
 * written with `source: "migration"`. A log that cannot be read gets what
 * CAN be said (last activity from the file's mtime; title and turns
 * unknown) and never throws the list. Resumable: each summary is written on
 * its own, so a crash mid-way leaves the done ones done; the marker lands
 * only when every session has one.
 */
export function migrateSummaries(root: string, load: (id: string) => readonly StoreRecord[], onEach?: (done: number, total: number) => void): number {
	const todo = listSessionSidecars(root).filter((s) => s.summary === null);
	todo.forEach((s, i) => {
		let summary: SessionSummary;
		try {
			summary = sessionSummary(load(s.id), { workspaceUnknown: s.workspace === null, source: "migration", fallbackUpdatedAt: s.mtime });
		} catch {
			summary = { title: null, turns: null, updatedAt: s.mtime, state: null, uncertain: 0, asks: 0, workspaceUnknown: s.workspace === null, source: "migration" };
		}
		try {
			writeSummary(root, s.id, summary);
		} catch {
			// a sidecar that cannot be written leaves this session without a
			// summary; the list says so, and the marker still lands below
		}
		onEach?.(i + 1, todo.length);
	});
	writeFileSync(join(root, SUMMARY_MIGRATION_MARKER), `${new Date().toISOString()}\n`);
	return todo.length;
}
