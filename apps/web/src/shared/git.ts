/** What `GET /desk/git` answers: the rail's Changes from git (main/git.ts reads it). */

export interface GitFile {
	readonly path: string;
	/** lines added and removed against the base (null: a binary file, or an untracked one) */
	readonly added: number | null;
	readonly removed: number | null;
	/** "new" (untracked or added), "deleted", or "modified" */
	readonly state: "new" | "deleted" | "modified";
	/** not committed yet */
	readonly dirty: boolean;
}

export interface GitReply {
	readonly repo: boolean;
	readonly branch: string | null;
	/** what a pull request would go into (origin's default branch, else main or master), short name */
	readonly base: string | null;
	readonly ahead: number;
	readonly files: readonly GitFile[];
	readonly dirty: boolean;
	/** a pull request can be opened from here: a branch other than the base, a remote, and `gh` signed in */
	readonly canPr: boolean;
	readonly pr: { readonly number: number; readonly title: string; readonly url: string; readonly state: string; readonly checks: { readonly done: number; readonly total: number; readonly failed: number } } | null;
}
