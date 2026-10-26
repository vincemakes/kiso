import type { SettingsPatch, SettingsReply } from "../../shared/settings.js";

/** The page's calls to the host's own doors (`/desk/...`) and to the one narrow bridge the main process gives it. */

export interface OpenWork {
	readonly key: string;
	readonly sessionId: string;
	readonly decisionId: string;
}

declare global {
	interface Window {
		kisoDesktop?: { pickFolder(): Promise<string | null>; onOpenWork(handler: (target: OpenWork) => void): void };
	}
}

export class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const answer = (await response.json().catch(() => ({}))) as { message?: string };
	if (!response.ok) throw new Refusal(response.status, answer.message ?? `${response.status}`);
	return answer as T;
}

/** The system's folder dialog (null when cancelled, or when there is no bridge, as in a plain browser). */
export const pickFolder = (): Promise<string | null> => window.kisoDesktop?.pickFolder() ?? Promise.resolve(null);

export const chooseFolder = (token: string, path: string): Promise<{ readonly key: string; readonly folder: string }> => call(token, "/desk/folder", { path });
export const fetchRecent = (token: string): Promise<{ readonly recent: readonly { readonly folder: string; readonly path: string; readonly key: string }[] }> => call(token, "/desk/recent");
export const fetchSettings = (token: string, session?: string): Promise<SettingsReply> => call(token, `/desk/settings${session === undefined ? "" : `?session=${encodeURIComponent(session)}`}`);
export const saveSettings = (token: string, patch: SettingsPatch): Promise<SettingsReply> => call(token, "/desk/settings", patch);
export const saveKey = (token: string, profile: string, key: string): Promise<{ readonly ok: true }> => call(token, "/desk/login", { profile, key });
export const startDemo = (token: string): Promise<{ readonly ok: true }> => call(token, "/desk/demo", {});
export const sendPresence = (token: string, key: string | null, session: string, focused: boolean): Promise<unknown> => call(token, "/desk/presence", { key: key ?? "", session, focused });
