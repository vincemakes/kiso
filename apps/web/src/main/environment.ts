import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cdTargets, isGhPrCreate } from "@vincemakes/kiso-code/policy";
import type { EnvFolder, EnvRepo } from "../shared/settings.js";
import { Refusal } from "./files.js";
import { branchOf, githubOf } from "./folder-info.js";
import { tryRun } from "./git.js";
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

/** A pull request's branch from `gh`, asked once off the request (retried after a minute when it could not be read); the row shows it once known. */
const branches = new Map<string, { branch?: string; at: number }>();
function branchOfPr(url: string): string | undefined {
	const held = branches.get(url);
	if (held === undefined || (held.branch === undefined && Date.now() - held.at > 60_000)) {
		branches.set(url, { at: Date.now() });
		void tryRun(process.cwd(), "gh", ["pr", "view", url, "--json", "headRefName", "--jq", ".headRefName"], 8000).then((b) => b !== null && b !== "" && branches.set(url, { branch: b, at: Date.now() }));
	}
	return held?.branch;
}

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
	// both sources, one row per repository: the Work's own link (the person's latest word) first, then what the log printed
	const both = (log: readonly EnvRepo[]): readonly EnvRepo[] => [...(linked === undefined ? [] : [repoOf(linked)]), ...log].filter((r, i, all) => all.findIndex((x) => x.repo === r.repo) === i);
	if (held !== undefined && held.seq === seq) return { recent: held.recent, repos: both(held.repos) };
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
	return { recent: out.recent, repos: both(out.repos) };
}

const shown = (p: string): string => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

/** The rows, in the card's order: the primary, the added folders, then what only records. */
export function environmentRows(space: Space, session: string, linked: Pr | undefined): NonNullable<import("../shared/settings.js").EnvReply["rows"]> {
	const { added, damaged } = foldersOf(space, session);
	const { recent, repos } = derive(space, session, linked);
	const row = (kind: EnvFolder["kind"], path: string): EnvFolder => ({ kind, path, shown: shown(path), branch: branchOf(path), github: githubOf(path), missing: !existsSync(path) });
	const roots = [space.workspace, ...added.map((a) => a.path)];
	const inside = (d: string, root: string): boolean => d === root || d.startsWith(`${root}/`);
	// a recent folder in an added folder is not shown; one in the primary, or around any root, is shown but can never be added (nested)
	const folders = [row("primary", space.workspace), ...added.map((a) => row("added", a.path)), ...recent.filter((d) => !added.some((a) => inside(d, a.path)) && d !== space.workspace).map((d) => ({ ...row("recent", d), addable: !roots.some((r) => inside(d, r) || inside(r, d)) }))];
	const withBranch = repos.map((r) => ({ ...r, ...(branchOfPr(r.url) === undefined ? {} : { branch: branchOfPr(r.url)! }) }));
	return { folders, repos: withBranch, doors: process.platform === "darwin" ? ["reveal", "terminal"] : [], damaged };
}

/** Show in Finder / Open in terminal: by Work and row index, the path recomputed here, never taken from the page. */
export function openRow(space: Space, session: string, linked: Pr | undefined, index: number, door: string): void {
	const folder = environmentRows(space, session, linked).folders[index];
	if (folder === undefined || !existsSync(folder.path)) throw new Refusal(404, "that folder is not there any more");
	if (process.platform !== "darwin" || (door !== "reveal" && door !== "terminal")) throw new Refusal(501, "this host cannot open it");
	execFile("open", door === "reveal" ? ["-R", folder.path] : ["-a", "Terminal", folder.path], () => undefined);
}
