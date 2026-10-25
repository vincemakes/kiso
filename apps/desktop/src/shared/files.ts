/** What the read-only file doors answer (`/desk/fs/tree`, `/desk/fs/file`) and the task-log door. Nothing here leaves the Work's folder. */

export interface TreeEntry {
	readonly name: string;
	readonly kind: "dir" | "file" | "link";
	readonly size: number;
	/** a folder the listing does not open (dependencies, dot folders): shown as "not listed" */
	readonly folded?: true;
	/** a link that leads outside the folder or to a protected file: shown, never followed */
	readonly outside?: true;
}

export interface TreeReply {
	/** the folder's real path: the page uses it to match the paths a step wrote against the tree */
	readonly root: string;
	readonly path: string;
	readonly entries: readonly TreeEntry[];
	/** entries beyond the cap, not sent */
	readonly more: number;
}

export type PreviewKind = "text" | "markdown" | "image" | "binary" | "toolarge";

export interface FileReply {
	readonly kind: PreviewKind;
	readonly size: number;
	readonly text?: string;
	readonly truncated?: boolean;
	/** an image as a data URL, up to the image cap */
	readonly dataUrl?: string;
}

export interface TaskLogReply {
	readonly lines: readonly string[];
	/** the log is longer than what is sent (its last part only) */
	readonly truncated: boolean;
}
