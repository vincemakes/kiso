import { join } from "node:path";
import { defineTool, type Event, type KisoExtension } from "@vincemakes/kiso-core";
import { ChainBudget, LIST_SESSIONS, SESSIONS_APPROVALS, heldElsewhere, shortRefs } from "@vincemakes/kiso-runtime/internal";
import type { HistoryReply, WorkRow } from "../shared/history.js";
import { messageTool } from "./message-tool.js";
import { startSessionTool, type WorkStart } from "./start-session-tool.js";

/**
 * ADR-0062 PR 1: the sessions extension, the web host's half. Every Work this host opens gets it when the host runs with it on
 * (KISO_WEB_SESSIONS=on). Amendment 2 (owner, 2026-11-20): a Work follows the host that opens it, so a Work the terminal made
 * has the tools here, and the terminal drops them again.
 */

export interface SessionsHost {
	/** every Work the host can reach, newest first (the sidebar's listing) */
	readonly list: () => Promise<HistoryReply>;
	/** a folder key's session directory */
	readonly dirOf: (key: string) => string;
	/** a message was written to this Work's inbox: open it here if it is not held elsewhere, and have it look */
	readonly deliver: (key: string, sessionId: string) => Promise<"handed" | "woke" | "waiting">;
	/** whether this Work may read the file (its folder or the folders it was given; never a protected file) */
	readonly mayRead: (self: { readonly key: string; readonly sessionId: string }, path: string) => boolean;
	/** the folder a Work works in: a relative `files` path is read from it */
	readonly cwdOf: (key: string) => string | undefined;
	/** ADR-0062 § 6: the causal chain the Work is on, read from its log */
	readonly chainOf: (key: string, sessionId: string) => string;
	/** the Work's permission mode */
	readonly tierOf: (sessionId: string) => string;
	/** spend one of a chain's wakes; false once they are spent */
	readonly mayWake: (rootId: string) => boolean;
	/** a Work's events, from its log */
	readonly eventsOf: (key: string, sessionId: string) => readonly Event[];
	/** ADR-0062 § 9: start a Work from this one (a fork waits for the parent's run to end) */
	readonly startWork: (key: string, parent: string, start: WorkStart) => Promise<void>;
}

/** The chain budgets, one small file per chain under the kiso home (a restart never refills a spent one). */
export const chainBudget = (home: string): ChainBudget => new ChainBudget(join(home, "chains"));

const MAX_LINES = 100;
const STATE = { running: "running", waiting: "waiting on the person", idle: "idle" } as const;

/** The extension for this Work. Whether the host runs with it is the host's one switch; the Work follows the host that opens it
 *  (ADR-0062 Amendment 1), so the sidecar's mark is no longer decided here: the runtime sets it once the Work's lock is held. */
export function sessionsFor(self: { readonly key: string; readonly sessionId: string }, host: SessionsHost): KisoExtension {
	const listTool = defineTool({
		...LIST_SESSIONS,
		idempotent: true,
		execute: async (input) => ({ content: listing(await host.list(), self, (input as { readonly query?: string }).query, host.dirOf), isError: false }),
	});
	return { name: "sessions", approvals: SESSIONS_APPROVALS, tools: [listTool, messageTool(self, host), startSessionTool(self, host)] };
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
