import type { DirsReply } from "../../shared/files.js";
import type { ContextParts, SettingsPatch, SettingsReply } from "../../shared/settings.js";
import type { GitReply } from "../../shared/git.js";

/** The page's calls to the host's own doors (`/desk/...`); the session cookie goes with each, the page adds nothing. */

/** A Work a notification points at (and the approval in it, if it is one). */
export interface OpenWork {
	readonly key: string;
	readonly sessionId: string;
	readonly decisionId?: string;
}

export class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const answer = (await response.json().catch(() => ({}))) as { message?: string };
	if (!response.ok) throw new Refusal(response.status, answer.message ?? `${response.status}`);
	return answer as T;
}

/** One folder of the folder browser (root null: the home folder). */
export const fetchDirs = (root: string | null, path: string): Promise<DirsReply> => call(`/desk/dirs?${new URLSearchParams({ ...(root === null ? {} : { root }), path }).toString()}`);

export const chooseFolder = (path: string): Promise<{ readonly key: string; readonly folder: string }> => call("/desk/folder", { path });
/** The system's own folder picker, on this computer: a path, or cancelled; a refusal (no picker here) sends the page to its own browser. */
export const pickFolder = (): Promise<{ readonly path?: string; readonly cancelled?: true }> => call("/desk/pick-folder", {});
export const fetchRecent = (): Promise<{ readonly recent: readonly { readonly folder: string; readonly path: string; readonly key: string }[] }> => call("/desk/recent");
export const fetchSettings = (session?: string): Promise<SettingsReply> => call(`/desk/settings${session === undefined ? "" : `?session=${encodeURIComponent(session)}`}`);
/** `key`: the folder the Work is in, so a Work's model change rebuilds it in its own space. */
export const saveSettings = (patch: SettingsPatch, key: string | null = null): Promise<SettingsReply> => call(`/desk/settings${key === null ? "" : `?key=${encodeURIComponent(key)}`}`, patch);
const withKey = (path: string, key: string | null, more: Record<string, string> = {}): string => {
	const q = new URLSearchParams({ ...(key === null ? {} : { key }), ...more }).toString();
	return q === "" ? path : `${path}?${q}`;
};
/** The rail's Changes from git; `draft`: the pull request dialog's starting title and body. */
export const fetchGit = (key: string | null): Promise<GitReply> => call(withKey("/desk/git", key));
export const fetchPrDraft = (key: string | null): Promise<{ readonly title: string; readonly body: string }> => call(withKey("/desk/git", key, { draft: "1" }));
/** On the person's confirm only: commit the ticked files; push and open the pull request. */
export const postCommit = (key: string | null, message: string, paths: readonly string[]): Promise<{ readonly sha: string }> => call(withKey("/desk/commit", key), { message, paths });
export const postPr = (key: string | null, title: string, body: string, session: string): Promise<{ readonly number: number; readonly url: string }> => call(withKey("/desk/pr", key), { title, body, session });
/** Link a Work to a pull request (its URL or number), or unlink it (null). */
export const linkPr = (key: string | null, session: string, pr: string | null): Promise<unknown> => call(withKey("/desk/work-pr", key), { session, pr });
/** Name a Work (empty clears the name, back to its first-request title); the answer is the name kept. */
export const renameWork = (key: string | null, session: string, name: string): Promise<{ readonly name: string | null }> => call(withKey("/desk/rename", key), { session, name });
/** What a Work's requests always carry (bytes), and its compaction sizes. */
export const fetchContext = (key: string | null, session: string): Promise<ContextParts> => call(withKey("/desk/context", key, { session }));
/** The files `@` can name in a Work's folder (git's list, else a bounded walk). */
export const fetchAtFiles = (key: string | null): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> => call(`/desk/at-files${key === null ? "" : `?key=${encodeURIComponent(key)}`}`);
export const saveKey = (profile: string, key: string): Promise<{ readonly ok: true }> => call("/desk/login", { profile, key });
/** Stop one background task of a Work (the rail's stop): the task manager's own stop, as `/tasks` does in the terminal. */
export const stopTask = (key: string | null, session: string, task: string): Promise<{ readonly stopped: boolean }> => call(`/desk/task-stop${key === null ? "" : `?key=${encodeURIComponent(key)}`}`, { session, task });
/** Fork a Work at the end of one of its runs; the answer is the new Work's id (the host refuses in words: a seq not at a run's end, a verdict still owed). */
export const forkWork = (key: string | null, session: string, atSeq?: number): Promise<{ readonly id: string }> => call(withKey("/desk/fork", key), { session, ...(atSeq === undefined ? {} : { atSeq }) });
/** Pin, archive or delete a Work (the sidebar's menu); a refusal comes back in words. */
export const actOnWork = (key: string | null, session: string, act: string): Promise<{ readonly ok: true }> => call(withKey("/desk/work", key), { session, act });
export const startDemo = (): Promise<{ readonly ok: true }> => call("/desk/demo", {});
export const sendPresence = (key: string | null, session: string, focused: boolean): Promise<unknown> => call("/desk/presence", { key: key ?? "", session, focused });
