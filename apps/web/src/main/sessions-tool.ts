import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type KisoExtension } from "@vincemakes/kiso-core";
import { LIST_SESSIONS, SESSIONS_APPROVALS, hasSessionsTools, heldElsewhere, markSessionsTools } from "@vincemakes/kiso-runtime/internal";
import type { HistoryReply, WorkRow } from "../shared/history.js";
import { messageTool } from "./message-tool.js";

/**
 * ADR-0062 PR 1: the sessions extension, the web host's half. A Work gets it only when the host runs with it on
 * (KISO_WEB_SESSIONS=on) and the Work was created that way: a Work with no log yet is marked on its first open, and the mark
 * (a sidecar tenant) is what decides from then on, here and in the terminal, so no table changes mid-session.
 */

export interface SessionsHost {
	/** every Work the host can reach, newest first (the sidebar's listing) */
	readonly list: () => Promise<HistoryReply>;
	/** a folder key's session directory */
	readonly dirOf: (key: string) => string;
	/** a message was written to this Work's inbox: open it here if it is not held elsewhere, and have it look */
	readonly deliver: (key: string, sessionId: string) => Promise<void>;
	/** whether this Work may read the file (its folder or the folders it was given; never a protected file) */
	readonly mayRead: (self: { readonly key: string; readonly sessionId: string }, path: string) => boolean;
}

const MAX_LINES = 100;
const STATE = { running: "running", waiting: "waiting on the person", idle: "idle" } as const;

/** The extension for this Work, or undefined: marks a new Work first. */
export function sessionsFor(dir: string, self: { readonly key: string; readonly sessionId: string }, host: SessionsHost): KisoExtension | undefined {
	if (!existsSync(join(dir, `${self.sessionId}.jsonl`)) && !hasSessionsTools(dir, self.sessionId)) markSessionsTools(dir, self.sessionId);
	if (!hasSessionsTools(dir, self.sessionId)) return undefined;
	const listTool = defineTool({
		...LIST_SESSIONS,
		idempotent: true,
		execute: async (input) => ({ content: listing(await host.list(), self, (input as { readonly query?: string }).query, host.dirOf), isError: false }),
	});
	return { name: "sessions", approvals: SESSIONS_APPROVALS, tools: [listTool, messageTool(self, host)] };
}

/** Each id's shortest suffix (four characters at least) that no other listed id ends with; a full id listed twice (two
 *  folders) is prefixed with its folder. Keyed `folder/id`. */
export function shortRefs(rows: readonly Pick<WorkRow, "id" | "folder">[]): Map<string, string> {
	const refs = new Map<string, string>();
	const ids = rows.map((r) => r.id);
	for (const row of rows) {
		const twins = ids.filter((id) => id === row.id).length > 1;
		let n = 4;
		while (n < row.id.length && ids.some((id) => id !== row.id && id.endsWith(row.id.slice(-n)))) n += 1;
		refs.set(`${row.folder}/${row.id}`, twins ? `${row.folder}/${row.id}` : row.id.slice(-n));
	}
	return refs;
}

const ago = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The tool's answer: one line per Work, this one left out. */
export function listing(reply: HistoryReply, self: { readonly key: string; readonly sessionId: string }, query: string | undefined, dirOf: (key: string) => string, now = Date.now()): string {
	const others = reply.works.filter((w) => !(w.key === self.key && w.id === self.sessionId));
	const refs = shortRefs(others);
	const q = query?.trim().toLowerCase() ?? "";
	const found = q === "" ? others : others.filter((w) => w.title.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
	const lines = found.slice(0, MAX_LINES).map((w) => {
		const state = w.state === "idle" && heldElsewhere(join(dirOf(w.key), `${w.id}.lock`)) ? "open elsewhere (the terminal)" : STATE[w.state];
		return `- ${w.title || "(untitled)"} · ref ${refs.get(`${w.folder}/${w.id}`)} · folder ${w.folder} · ${state}${w.archived === true ? " · archived" : ""} · active ${ago(now - w.updatedAt)}`;
	});
	const head = found.length === 0 ? (q === "" ? "No other sessions." : `No session matches "${query}".`) : `${found.length} session${found.length === 1 ? "" : "s"}${q === "" ? "" : ` matching "${query}"`}:`;
	const more = found.length > MAX_LINES ? [`(${found.length - MAX_LINES} more; narrow them with query)`] : [];
	const partial = reply.scanning ? ["Some folders are still being read: the list may be incomplete."] : [];
	return [head, ...lines, ...more, ...partial].join("\n");
}
