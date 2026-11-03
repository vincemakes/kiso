import { readSessionName, writeSessionName } from "@vincemakes/kiso-runtime/internal";

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
