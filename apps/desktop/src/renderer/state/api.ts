import type { FileReply, TaskLogReply, TreeReply } from "../../shared/files.js";

/** The page's reads of the host's folder and task doors (GET only; the host decides what may be read). */

export class Refused extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function get<T>(token: string, path: string, params: Record<string, string | null>): Promise<T> {
	const query = Object.entries(params).flatMap(([k, v]) => (v === null ? [] : [`${k}=${encodeURIComponent(v)}`]));
	const response = await fetch(`${path}?${query.join("&")}`, { headers: { authorization: `Bearer ${token}` } });
	const body = (await response.json().catch(() => ({}))) as { message?: string };
	if (!response.ok) throw new Refused(response.status, body.message ?? `${response.status}`);
	return body as T;
}

export const fetchTree = (token: string, key: string | null, path: string): Promise<TreeReply> => get(token, "/desk/fs/tree", { key, path });
export const fetchFile = (token: string, key: string | null, path: string): Promise<FileReply> => get(token, "/desk/fs/file", { key, path });
export const fetchTaskLog = (token: string, key: string | null, session: string, task: string): Promise<TaskLogReply> => get(token, "/desk/task-log", { key, session, task });
