import type { HistoryReply, WorkRow } from "../../shared/history.js";
import type { EnvReply } from "../../shared/settings.js";
import { t } from "../i18n/index.js";

/**
 * The Works the page knows of: which one is open, where its routes are, how
 * the history groups (Pinned, then Recents).
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

/** Pinned (the latest pin first), then Recents; the input is newest first and stays so. A fork follows its parent, except into
 *  Pinned: a pin holds the one row; an archived Work, with its forks, is left out (`archived` lists them). */
export function groupWorks(works: readonly WorkRow[]): Group[] {
	const id = (w: WorkRow, other = w.id): string => `${w.key}/${other}`;
	const byId = new Map(works.map((w) => [id(w), w]));
	const out = (w: WorkRow | undefined): boolean => w !== undefined && (w.archived === true || (w.parent !== undefined && out(byId.get(id(w, w.parent)))));
	const shown = works.filter((w) => !out(w));
	const free = new Set(shown.filter((w) => w.pinned === undefined).map((w) => id(w)));
	const under = (w: WorkRow): boolean => w.parent !== undefined && w.pinned === undefined && free.has(id(w, w.parent));
	const kids = new Map<string, WorkRow[]>();
	for (const w of shown) if (under(w)) kids.set(id(w, w.parent), [...(kids.get(id(w, w.parent!)) ?? []), w]);
	const after = (w: WorkRow): WorkRow[] => [w, ...(kids.get(id(w)) ?? []).flatMap(after)];
	const buckets: WorkRow[][] = [[], []];
	const roots = shown.filter((w) => !under(w));
	for (const root of [...roots.filter((w) => w.pinned !== undefined).sort((a, b) => a.pinned! - b.pinned!), ...roots.filter((w) => w.pinned === undefined)])
		buckets[root.pinned !== undefined ? 0 : 1]!.push(...after(root));
	const labels = [t.pinned, t.recents];
	return buckets.flatMap((rows, i) => (rows.length === 0 ? [] : [{ label: labels[i]!, works: rows }]));
}

/** How the sidebar lists Recents (kept per browser): by folder (the default) or as one list; by last update or by creation. */
export type SideBy = "folder" | "list";
export type SideSort = "updated" | "created";

export interface FolderGroup {
	readonly key: string;
	readonly folder: string;
	readonly works: readonly WorkRow[];
	/** its newest Work, by the sort in use */
	readonly latest: number;
}

/** Recents by folder: each folder's rows in the list's order (a fork stays after its parent, which is in the same folder), the
 *  folders newest first. */
export function byFolder(rows: readonly WorkRow[], sort: SideSort): FolderGroup[] {
	const groups = new Map<string, { key: string; folder: string; works: WorkRow[]; latest: number }>();
	for (const w of rows) {
		const g = groups.get(w.key) ?? { key: w.key, folder: w.folder, works: [], latest: 0 };
		g.works.push(w);
		g.latest = Math.max(g.latest, sort === "created" ? w.createdAt : w.updatedAt);
		groups.set(w.key, g);
	}
	return [...groups.values()].sort((a, b) => b.latest - a.latest);
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
