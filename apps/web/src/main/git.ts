import { execFile } from "node:child_process";
import { Refusal } from "./files.js";
import type { GitFile, GitReply } from "../shared/git.js";

/**
 * The rail's Changes from git, and the one write it can make on the person's word: commit the files they ticked, push the branch
 * and open a pull request with `gh`. Reads are bounded (a timeout each, nothing on a folder outside git); the writes run only
 * from the dialog's confirm (POST), never by themselves, and refuse what they cannot do in words.
 */

const run = (cwd: string, cmd: string, args: readonly string[], timeout = 3000): Promise<string> =>
	new Promise((resolve, reject) =>
		execFile(cmd, [...args], { cwd, timeout, maxBuffer: 1 << 23, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } }, (err, out, errOut) => (err === null ? resolve(out) : reject(new Error((errOut || err.message).trim())))),
	);
const tryRun = (cwd: string, cmd: string, args: readonly string[], timeout?: number): Promise<string | null> => run(cwd, cmd, args, timeout).then((o) => o.trim(), () => null);

let ghSignedIn: Promise<boolean> | null = null;
/** `gh auth status`, asked once per host process: a sign-in does not come and go between two clicks. */
const ghReady = (cwd: string): Promise<boolean> => (ghSignedIn ??= tryRun(cwd, "gh", ["auth", "status"], 5000).then((o) => o !== null));

async function baseOf(cwd: string): Promise<string | null> {
	const head = await tryRun(cwd, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (head !== null) return head.replace(/^origin\//, "");
	for (const name of ["main", "master"]) if ((await tryRun(cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== null) return name;
	return null;
}

/** The changed paths and their two-letter codes (`git status -z`: NUL-separated, so a path with a space or a quote is read whole; a rename gives its new path). */
async function statusOf(cwd: string): Promise<Map<string, string>> {
	const out = (await run(cwd, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "")).split("\0");
	const map = new Map<string, string>();
	for (let i = 0; i < out.length; i++) {
		const e = out[i]!;
		if (e.length < 4) continue;
		map.set(e.slice(3), e.slice(0, 2));
		if (e[0] === "R" || e[0] === "C") i += 1; // the old path follows a rename or a copy
	}
	return map;
}

/** The base as a ref to compare with: origin's copy when there is one (what the PR is judged against), else the local branch. */
const baseRef = async (cwd: string, base: string): Promise<string> => ((await tryRun(cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])) !== null ? `origin/${base}` : base);

export async function gitOf(cwd: string): Promise<GitReply> {
	const none: GitReply = { repo: false, branch: null, base: null, ahead: 0, files: [], dirty: false, canPr: false, pr: null };
	if ((await tryRun(cwd, "git", ["rev-parse", "--is-inside-work-tree"])) !== "true") return none;
	const branch = await tryRun(cwd, "git", ["symbolic-ref", "--short", "HEAD"]);
	const base = await baseOf(cwd);
	const ref = base === null ? null : await baseRef(cwd, base);
	const fork = ref === null ? null : await tryRun(cwd, "git", ["merge-base", ref, "HEAD"]);
	const ahead = ref === null ? 0 : Number((await tryRun(cwd, "git", ["rev-list", "--count", `${ref}..HEAD`])) ?? 0);
	const dirty = await statusOf(cwd);
	const numstat = fork === null ? "" : await run(cwd, "git", ["diff", "--numstat", "-z", "--no-renames", fork]).catch(() => "");
	const files = new Map<string, GitFile>();
	for (const entry of numstat.split("\0").filter((l) => l !== "")) {
		const [a, r, path] = entry.split("\t") as [string, string, string];
		files.set(path, { path, added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r), state: "modified", dirty: dirty.has(path) });
	}
	for (const [path, code] of dirty) {
		const state = code.includes("?") || code.includes("A") ? "new" : code.includes("D") ? "deleted" : "modified";
		files.set(path, { ...(files.get(path) ?? { path, added: null, removed: null }), state, dirty: true });
	}
	const remote = await tryRun(cwd, "git", ["remote", "get-url", "origin"]);
	const canPr = branch !== null && base !== null && branch !== base && remote !== null && (await ghReady(cwd));
	let pr: GitReply["pr"] = null;
	if (canPr) {
		const json = await tryRun(cwd, "gh", ["pr", "view", "--json", "number,title,url,state,statusCheckRollup"], 6000);
		if (json !== null) {
			const p = JSON.parse(json) as { number: number; title: string; url: string; state: string; statusCheckRollup?: readonly { status?: string; conclusion?: string }[] };
			const checks = p.statusCheckRollup ?? [];
			pr = { number: p.number, title: p.title, url: p.url, state: p.state, checks: { total: checks.length, done: checks.filter((c) => c.status === "COMPLETED").length, failed: checks.filter((c) => c.conclusion === "FAILURE").length } };
		}
	}
	return { repo: true, branch, base, ahead, files: [...files.values()], dirty: dirty.size > 0, canPr, pr };
}

/** Commit the files the person ticked, with their message: those paths only (never `git add -A`), so nothing they did not see is committed. */
export async function commit(cwd: string, message: string, paths: readonly string[]): Promise<{ readonly sha: string }> {
	if (message.trim() === "") throw new Refusal(400, "a commit needs a message");
	if (paths.length === 0) throw new Refusal(400, "no file was chosen");
	const listed = await statusOf(cwd);
	const strange = paths.filter((p) => !listed.has(p));
	if (strange.length > 0) throw new Refusal(400, `not a changed file of this folder: ${strange.join(", ")}`);
	await run(cwd, "git", ["add", "--", ...paths]);
	await run(cwd, "git", ["commit", "-m", message, "--", ...paths]).catch((e: Error) => {
		throw new Refusal(409, `git refused the commit: ${e.message}`);
	});
	return { sha: (await run(cwd, "git", ["rev-parse", "--short", "HEAD"])).trim() };
}

/** Push the branch and open its pull request into the base; refused with the reason when the folder cannot. */
export async function openPr(cwd: string, title: string, body: string): Promise<{ readonly number: number; readonly url: string }> {
	const g = await gitOf(cwd);
	if (!g.canPr || g.branch === null || g.base === null) throw new Refusal(409, "a pull request needs a branch other than the base, a remote named origin, and gh signed in");
	if (g.dirty) throw new Refusal(409, "commit the changes first: a pull request carries commits, not the working tree");
	if (g.ahead === 0) throw new Refusal(409, `${g.branch} has no commit that ${g.base} does not have`);
	if (title.trim() === "") throw new Refusal(400, "a pull request needs a title");
	await run(cwd, "git", ["push", "-u", "origin", "HEAD"], 60_000).catch((e: Error) => {
		throw new Refusal(409, `git push failed: ${e.message}`);
	});
	const out = await run(cwd, "gh", ["pr", "create", "--base", g.base, "--head", g.branch, "--title", title, "--body", body], 60_000).catch((e: Error) => {
		throw new Refusal(409, `gh pr create failed: ${e.message}`);
	});
	const url = out.trim().split("\n").pop() ?? "";
	return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url };
}

/** The dialog's starting draft from the branch's own commits: one commit gives its subject; several, the branch's name and a list. */
export async function prDraft(cwd: string): Promise<{ readonly title: string; readonly body: string }> {
	const g = await gitOf(cwd);
	if (g.base === null) return { title: "", body: "" };
	const ref = await baseRef(cwd, g.base);
	const subjects = ((await tryRun(cwd, "git", ["log", "--format=%s", `${ref}..HEAD`])) ?? "").split("\n").filter((s) => s !== "").reverse();
	if (subjects.length === 1) return { title: subjects[0]!, body: "" };
	return { title: (g.branch ?? "").replace(/^[^/]*\//, "").replace(/[-_]/g, " "), body: subjects.map((s) => `- ${s}`).join("\n") };
}
