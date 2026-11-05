/**
 * The history of Works across every project folder: what `GET /desk/history`
 * answers. A Work is one session; it belongs to the folder it was started in.
 */

/** idle: nothing to say; running: a run is live in this host; waiting: the run waits for the person's answer. */
export type WorkState = "idle" | "running" | "waiting";

export interface WorkRow {
	readonly id: string;
	/** the folder's key in the host's routes (`/w/<key>/v1/...`) */
	readonly key: string;
	/** the folder's name (the last part of its path) */
	readonly folder: string;
	/** the session's title: named by its first request */
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly events: number;
	readonly runs: number;
	readonly state: WorkState;
	/** the Work this one was forked from (the sidebar lists a fork after it, one step in) */
	readonly parent?: string;
	/** its place among the pinned Works (0: the latest pin) */
	readonly pinned?: number;
	/** kept out of the list; the sidebar's Archived line shows it */
	readonly archived?: true;
	/** a run of it ended while the person looked elsewhere, and they have not looked at it since */
	readonly unread?: true;
}

export interface HistoryReply {
	/** the folder a new task starts in */
	readonly current: { readonly key: string; readonly folder: string };
	/** newest first, across folders */
	readonly works: readonly WorkRow[];
	/** some folder's listing is still being read or refreshed */
	readonly scanning: boolean;
}
