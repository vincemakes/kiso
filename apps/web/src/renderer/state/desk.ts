import type { DirsReply } from "../../shared/files.js";
import type { SettingsPatch, SettingsReply } from "../../shared/settings.js";

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
export const fetchRecent = (): Promise<{ readonly recent: readonly { readonly folder: string; readonly path: string; readonly key: string }[] }> => call("/desk/recent");
export const fetchSettings = (session?: string): Promise<SettingsReply> => call(`/desk/settings${session === undefined ? "" : `?session=${encodeURIComponent(session)}`}`);
export const saveSettings = (patch: SettingsPatch): Promise<SettingsReply> => call("/desk/settings", patch);
export const saveKey = (profile: string, key: string): Promise<{ readonly ok: true }> => call("/desk/login", { profile, key });
export const startDemo = (): Promise<{ readonly ok: true }> => call("/desk/demo", {});
export const sendPresence = (key: string | null, session: string, focused: boolean): Promise<unknown> => call("/desk/presence", { key: key ?? "", session, focused });
