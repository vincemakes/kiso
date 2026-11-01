import type { State, Step } from "./model.js";
import { editDiff, type DiffLine } from "./diff.js";

/**
 * What the panels need that is not drawing: which panel is open, the one
 * address the preview may load, the addresses a dev server prints, and the
 * files the latest run changed (from the edit and write calls on the log).
 */

/** `open`: one file of the folder, opened from a chip (its path is the focus) */
export type PanelKind = "term" | "diff" | "web" | "files" | "open";
export type PanelMode = "closed" | "half" | "full";

/**
 * The preview loads only a page on this computer: http on `localhost` or
 * `127.0.0.1`, no credentials in the address, and never this app's own host
 * (its port is `ownPort`). Returns the normalized address, or null.
 */
export function previewUrl(raw: string, ownPort: string): string | null {
	const text = raw.trim();
	// `localhost:5173` is a host and a port, not a scheme
	const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `http://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return null;
	if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
	if ((url.port === "" ? "80" : url.port) === ownPort) return null;
	return url.href;
}

/** The first local addresses a command printed (a dev server's "Local: http://localhost:5173/"), without repeats. */
export function discoverUrls(lines: readonly string[], ownPort: string): string[] {
	const found: string[] = [];
	for (const line of lines) {
		for (const m of line.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s'"<>),]*/g)) {
			const url = previewUrl(m[0].replace(/[.;:]+$/, ""), ownPort);
			if (url !== null && !found.includes(url)) found.push(url);
		}
	}
	return found;
}

export interface Change {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly lines: readonly DiffLine[];
	/** a file the run created (the write's "created" tag) */
	readonly created: boolean;
	/** false when a write replaced a file whole: its lines are the new content, not a count of what changed */
	readonly exact: boolean;
}

/** The path a step wrote, as the folder sees it (`root` is the folder's real path; absolute paths inside it are made relative). */
export function relativeTo(root: string | null, path: string): string {
	return root !== null && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//, "");
}

/** The files the latest run changed, in the order it first touched them; a file edited twice shows both edits. */
export function changesOf(state: State, root: string | null): Change[] {
	const turn = state.turns.at(-1);
	if (turn === undefined) return [];
	const byPath = new Map<string, { lines: DiffLine[]; created: boolean; exact: boolean }>();
	for (const item of turn.items) {
		if (item.kind !== "step" || item.status !== "done" || (item.name !== "edit_file" && item.name !== "write_file")) continue;
		const step: Step = item;
		const raw = step.input?.["path"];
		if (typeof raw !== "string") continue;
		const path = relativeTo(root, raw);
		const entry = byPath.get(path) ?? { lines: [], created: false, exact: true };
		if (step.name === "write_file") {
			const content = typeof step.input?.["content"] === "string" ? (step.input["content"] as string) : "";
			entry.lines.push(...content.split("\n").map((text): DiffLine => ({ kind: "add", text })));
			if (step.output?.created === true) entry.created = true;
			else entry.exact = false;
		} else entry.lines.push(...editDiff(step.input));
		byPath.set(path, entry);
	}
	return [...byPath].map(([path, e]) => ({ path, created: e.created, exact: e.exact, lines: e.lines, added: e.lines.filter((l) => l.kind === "add").length, removed: e.lines.filter((l) => l.kind === "del").length }));
}
