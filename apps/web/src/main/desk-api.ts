import type { IncomingMessage } from "node:http";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { canonicalPath, claimProjectDir, projectDirFor } from "@vincemakes/kiso-code/config";
import { deskRead } from "./fs-routes.js";
import { existing, Refusal } from "./files.js";
import { listDirs, validateFolder } from "./folders.js";
import { folderInfo } from "./folder-info.js";
import type { History } from "./history.js";
import type { Notice, Presence } from "./approvals.js";
import type { Settings } from "./settings.js";
import type { Space } from "./space.js";
import type { SettingsPatch } from "../shared/settings.js";

/**
 * The page's own doors (everything under `/desk/`), behind the host's guard: settings, a Work's environment, the folder's tree
 * and files, task logs, which paths exist (the chips), the history, picking a folder, signing in with a key, the demo, and the page's presence. Each answers
 * `{ status, body }`; a body never holds a credential.
 */

export interface DeskContext {
	readonly home: string;
	readonly settings: Settings;
	readonly current: Space;
	readonly history: History;
	readonly spaceFor: (key: string) => Space | null;
	readonly setPresence: (p: Presence) => void;
	readonly notices: (seq: number) => { readonly seq: number; readonly notices: readonly Notice[] };
}

const json = (status: number, body: unknown): { readonly status: number; readonly body: unknown } => ({ status, body });
const BODY_CAP = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (text.length > BODY_CAP) throw new Refusal(413, "too large");
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// fall through
	}
	throw new Refusal(400, "a JSON object is expected");
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function deskApi(ctx: DeskContext, req: IncomingMessage, url: URL): Promise<{ readonly status: number; readonly body: unknown }> {
	const path = url.pathname;
	const where = url.searchParams.get("key");
	const space = where === null || where === "" ? ctx.current : ctx.spaceFor(where);
	const post = req.method === "POST";
	try {
		if (path === "/desk/fs/tree" || path === "/desk/fs/file" || path === "/desk/task-log") {
			if (space === null) return json(404, {});
			return req.method === "GET" ? deskRead(url, space) : json(405, {});
		}
		if (path === "/desk/exists") {
			if (space === null) return json(404, {});
			return post ? json(200, { found: existing(realpathSync(space.workspace), (await readJson(req))["paths"]) }) : json(405, {});
		}
		if (path === "/desk/env") {
			if (space === null) return json(404, {});
			return req.method === "GET" ? json(200, folderInfo(space.workspace, ctx.settings.tierOf(url.searchParams.get("session") ?? undefined))) : json(405, {});
		}
		if (path === "/desk/history") return req.method === "GET" ? json(200, await ctx.history.snapshot({ key: ctx.current.key, dir: ctx.current.dir }, url.searchParams.get("fresh") ?? undefined)) : json(405, {});
		if (path === "/desk/settings") {
			if (post) ctx.settings.apply((await readJson(req)) as SettingsPatch);
			else if (req.method !== "GET") return json(405, {});
			return json(200, ctx.settings.snapshot(url.searchParams.get("session") ?? undefined));
		}
		if (path === "/desk/folder" && post) {
			const workspace = validateFolder((await readJson(req))["path"]);
			const dir = projectDirFor(ctx.home, workspace);
			claimProjectDir(dir, workspace);
			ctx.settings.addRecent(workspace);
			ctx.settings.write({ lastFolder: workspace });
			const opened = ctx.spaceFor(basename(dir));
			return opened === null ? json(500, {}) : json(200, { key: opened.key, folder: basename(workspace) });
		}
		if (path === "/desk/recent" && req.method === "GET") {
			const rows = ctx.settings.recents().flatMap((p) => {
				try {
					const real = validateFolder(p);
					return [{ folder: basename(real), path: real, key: basename(projectDirFor(ctx.home, canonicalPath(real))) }];
				} catch {
					return [];
				}
			});
			return json(200, { recent: rows });
		}
		if (path === "/desk/login" && post) {
			const b = await readJson(req);
			ctx.settings.saveKey(str(b["profile"]) ?? "", b["key"]);
			return json(200, { ok: true });
		}
		if (path === "/desk/demo" && post) {
			await ctx.settings.startDemo();
			return json(200, { ok: true });
		}
		if (path === "/desk/notices" && req.method === "GET") return json(200, ctx.notices(Number(url.searchParams.get("after") ?? "0") || 0));
		if (path === "/desk/dirs" && req.method === "GET") return json(200, listDirs(url.searchParams.get("root"), url.searchParams.get("path") ?? ""));
		if (path === "/desk/presence" && post) {
			const b = await readJson(req);
			const key = str(b["key"]) ?? "";
			ctx.setPresence({ key: key === "" ? ctx.current.key : key, session: str(b["session"]) ?? "", focused: b["focused"] === true, at: Date.now() });
			return json(200, { ok: true });
		}
		return json(404, {});
	} catch (error) {
		if (error instanceof Refusal) return json(error.status, { code: "refused", message: error.message });
		return json(500, { code: "internal", message: "failed" });
	}
}
