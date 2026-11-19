import { readForkOrigin, readSessionName, readStartedBy, writeSessionName } from "@vincemakes/kiso-runtime/internal";

/** A Work's name: the runtime's own session-name store, the one the terminal's rename writes (a file beside the log, never the log).
 *  The runtime's titles read it (the listing re-reads a folder whose name file changed); empty clears it; at most 120 characters. */
export function rename(dir: string, sessionId: string, name: string): string | null {
	const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
	writeSessionName(dir, sessionId, clean === "" ? null : clean);
	return clean === "" ? null : clean;
}

/** Whether a Work has a name: the person's, or a title written before. */
export const named = (dir: string, sessionId: string): boolean => readSessionName(dir, sessionId) !== null;

/** A title made from the Work's first message, kept only while the Work is still unnamed: the person's name wins. */
export function titleIfUnnamed(dir: string, sessionId: string, title: string): void {
	if (title !== "" && !named(dir, sessionId)) writeSessionName(dir, sessionId, title);
}

/** ADR-0062 § 10b: a title made from a line the person took back goes with it, unless the name has changed since (the person's). */
export function untitle(dir: string, sessionId: string, title: string | undefined): boolean {
	if (title === undefined || readSessionName(dir, sessionId) !== title) return false;
	writeSessionName(dir, sessionId, null);
	return true;
}

/** A Work's name, else its id (for a message that names it). */
export const nameOf = (dir: string, sessionId: string): string => readSessionName(dir, sessionId) ?? sessionId;

/**
 * The nested sessions of a Work: those of THIS folder that name it as their parent (a fork's origin, else the Work that started it,
 * the order history.ts uses), and theirs in turn. A session another folder's Work started is not counted, the sidebar does not nest it
 * either. Deleting only a parent leaves its children as they are: a nested row needs a living parent, so they show at the top level
 * (each Work writes only its own files, a child is never edited from here); a completion notice for a deleted parent is dropped
 * by the sender (message-tool.ts), not sent.
 */
export function subtreeOf(dir: string, key: string, all: readonly string[], id: string): readonly string[] {
	const parentOf = (c: string): string | null => readForkOrigin(dir, c)?.session ?? ((by) => (by !== null && by.startsWith(`${key}/`) ? by.slice(key.length + 1) : null))(readStartedBy(dir, c));
	const out: string[] = [id];
	for (let i = 0; i < out.length; i++) for (const c of all) if (!out.includes(c) && parentOf(c) === out[i]) out.push(c);
	return out;
}
