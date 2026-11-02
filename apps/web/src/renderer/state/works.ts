import type { HistoryReply, WorkRow } from "../../shared/history.js";
import type { EnvReply } from "../../shared/settings.js";
import { t } from "../i18n/index.js";

/**
 * The Works the page knows of: which one is open, where its routes are, how
 * the history groups by day.
 */

/** One Work: the session id, and the folder's key unless it is the folder in use. */
export interface Target {
	readonly key: string | null;
	readonly sessionId: string;
}

/** A session id the way the terminal makes one: the time to the second, then four random characters. */
export function newWorkId(now = new Date(), random = Math.random): string {
	const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
	return `${stamp}-${Math.floor(random() * 0x10000).toString(16).padStart(4, "0")}`;
}

/** The session routes of a Work's folder. */
export const sessionsUrl = (origin: string, key: string | null): string => (key === null ? `${origin}/v1/sessions` : `${origin}/w/${key}/v1/sessions`);

export interface Group {
	readonly label: string;
	readonly works: readonly WorkRow[];
}

/** Today, yesterday, earlier — by the calendar day on this machine; the input is newest first and stays so. */
export function groupWorks(works: readonly WorkRow[], now = new Date()): Group[] {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = 86_400_000;
	const buckets: WorkRow[][] = [[], [], []];
	// a fork is listed right after its parent (the parent's day), the Works without a listed parent in their own order
	const kids = new Map<string, WorkRow[]>();
	const ids = new Set(works.map((w) => `${w.key}/${w.id}`));
	for (const w of works) if (w.parent !== undefined && ids.has(`${w.key}/${w.parent}`)) kids.set(`${w.key}/${w.parent}`, [...(kids.get(`${w.key}/${w.parent}`) ?? []), w]);
	const after = (w: WorkRow): WorkRow[] => [w, ...(kids.get(`${w.key}/${w.id}`) ?? []).flatMap(after)];
	const roots = works.filter((w) => w.parent === undefined || !ids.has(`${w.key}/${w.parent}`));
	for (const root of roots) buckets[root.updatedAt >= midnight ? 0 : root.updatedAt >= midnight - day ? 1 : 2]!.push(...after(root));
	const labels = [t.today, t.yesterday, t.earlier];
	return buckets.flatMap((rows, i) => (rows.length === 0 ? [] : [{ label: labels[i]!, works: rows }]));
}

/** Where a Work runs: its folder, branch and permission tier — that Work's own when `session` is given (key null: the folder in use). */
export async function fetchEnv(key: string | null, session?: string): Promise<EnvReply> {
	const q = new URLSearchParams({ ...(key === null ? {} : { key }), ...(session === undefined ? {} : { session }) }).toString();
	const response = await fetch(`/desk/env${q === "" ? "" : `?${q}`}`);
	if (!response.ok) throw new Error(`env ${response.status}`);
	return (await response.json()) as EnvReply;
}

export async function fetchHistory(fresh?: string): Promise<HistoryReply> {
	const response = await fetch(`/desk/history${fresh === undefined ? "" : `?fresh=${encodeURIComponent(fresh)}`}`);
	if (!response.ok) throw new Error(`history ${response.status}`);
	return (await response.json()) as HistoryReply;
}
