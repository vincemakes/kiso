import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cdTargets, isGhPrCreate } from "@vincemakes/kiso-code/policy";
import type { EnvFolder, EnvRepo } from "../shared/settings.js";
import { Refusal } from "./files.js";
import { branchOf, githubOf } from "./folder-info.js";
import { prOfUrl, type Pr } from "./prs.js";
import type { Space } from "./space.js";
import { foldersOf } from "./work-folders.js";

/**
 * A Work's Environment rows. Recent folders and Repositories are DERIVED from the log and granted nothing (plan rev 4.1, 4 and 5):
 * a folder this Work's shell moved into (a literal `cd` in a call that did not fail), a repository it has a pull request in (a parsed
 * `gh pr create` whose result is not an error, else the Work's linked one). Cached by the log's last seq; nothing is stored.
 */
const RECENT_MAX = 8;
const cache = new Map<string, { readonly seq: number; readonly recent: readonly string[]; readonly repos: readonly EnvRepo[] }>();

const isDir = (p: string): boolean => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const repoOf = (pr: Pr): EnvRepo => ({ repo: /github\.com\/([\w.-]+\/[\w.-]+)\//.exec(pr.url)![1]!, number: pr.number, url: pr.url });

function derive(space: Space, session: string, linked: Pr | undefined): { readonly recent: readonly string[]; readonly repos: readonly EnvRepo[] } {
	const records = space.store.load(session);
	const seq = records.at(-1)?.event.seq ?? -1;
	const held = cache.get(session);
	const base = linked === undefined ? [] : [repoOf(linked)];
	if (held !== undefined && held.seq === seq) return { recent: held.recent, repos: held.repos.length > 0 || base.length === 0 ? held.repos : base };
	const calls = new Map<string, string>();
	const recent: string[] = [];
	const repos: EnvRepo[] = [];
	for (const { event: e } of records) {
		if (e.type === "tool_call_end" && e.name === "shell" && typeof (e.input as { command?: unknown }).command === "string") calls.set(e.callId, (e.input as { command: string }).command);
		if (e.type !== "tool_result" || e.isError || !calls.has(e.callId)) continue;
		const line = calls.get(e.callId)!;
		for (const dir of cdTargets(line, space.workspace, homedir())) if (isDir(dir)) recent.unshift(dir);
		const text = typeof e.content === "string" ? e.content : e.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		const pr = isGhPrCreate(line) ? prOfUrl(text) : null;
		if (pr !== null) repos.unshift(repoOf(pr));
	}
	const kept = [...new Set(recent)].filter((d, _, all) => !all.some((o) => o !== d && d.startsWith(`${o}/`))).slice(0, RECENT_MAX);
	const out = { seq, recent: kept, repos: repos.filter((r, i) => repos.findIndex((x) => x.repo === r.repo) === i) };
	cache.set(session, out);
	return { recent: out.recent, repos: out.repos.length > 0 || base.length === 0 ? out.repos : base };
}

const shown = (p: string): string => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

/** The rows, in the card's order: the primary, the added folders, then what only records. */
export function environmentRows(space: Space, session: string, linked: Pr | undefined): NonNullable<import("../shared/settings.js").EnvReply["rows"]> {
	const { added, damaged } = foldersOf(space, session);
	const { recent, repos } = derive(space, session, linked);
	const row = (kind: EnvFolder["kind"], path: string): EnvFolder => ({ kind, path, shown: shown(path), branch: branchOf(path), github: githubOf(path), missing: !existsSync(path) });
	const known = new Set([space.workspace, ...added.map((a) => a.path)]);
	const folders = [row("primary", space.workspace), ...added.map((a) => row("added", a.path)), ...recent.filter((d) => !known.has(d)).map((d) => row("recent", d))];
	return { folders, repos, doors: process.platform === "darwin" ? ["reveal", "terminal"] : [], damaged };
}

/** Show in Finder / Open in terminal: by Work and row index, the path recomputed here, never taken from the page. */
export function openRow(space: Space, session: string, linked: Pr | undefined, index: number, door: string): void {
	const folder = environmentRows(space, session, linked).folders[index];
	if (folder === undefined || !existsSync(folder.path)) throw new Refusal(404, "that folder is not there any more");
	if (process.platform !== "darwin" || (door !== "reveal" && door !== "terminal")) throw new Refusal(501, "this host cannot open it");
	execFile("open", door === "reveal" ? ["-R", folder.path] : ["-a", "Terminal", folder.path], () => undefined);
}
