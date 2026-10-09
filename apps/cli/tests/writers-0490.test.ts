/**
 * 0.49.0 B — the writers: a private snapshot, the parent's collection, the
 * join, and a verifier behind an implementer, through the subagent
 * extension's real delegate tool, a real TaskManager over the process
 * runner (with the CLI's collector), and scripted children.
 *
 * B6.1/I3: a writer works in a task-private repository holding the person's
 * working tree as it was at dispatch — uncommitted edits and untracked
 * files, never ignored ones — and nothing is written into the person's
 * repository. Over the cap, or with a tree that will not hold still, the
 * delegation is refused before any child starts.
 * B1: the collection records the patch (by path, never inline), each
 * changed file's two versions, the child's acceptance, then removes the
 * workspace; only `collected` ends the writer. B2: a verifier `after` an
 * implementer gets its tree (base plus patch) and starts in its group.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createSubagent, { collectWriter, snapshotWorkspace } from "@vincemakes/kiso-subagent-ext";
import { TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend } from "@vincemakes/kiso-tools-node";

const RUNNER = fileURLToPath(new URL("../../../packages/tools-node/dist/task-runner.js", import.meta.url));

/** The scripted writer: an implementer writes new.txt (CHILD_EDIT) in its
 *  cwd and edits a.txt; a verifier records whether it sees new.txt. Then
 *  the answer and the record that commits it. CHILD_SLEEP_MS delays it. */
const CHILD = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const role = /-(explorer|reviewer|implementer|verifier)$/.exec(args[args.indexOf("chat") + 1])?.[1] ?? "x";
setTimeout(() => {
	if (role === "implementer") {
		writeFileSync("new.txt", "NEW-FROM-THE-CHILD\\n");
		if (existsSync("a.txt")) writeFileSync("a.txt", readFileSync("a.txt", "utf8").replace("line 9", "line 9 CHILD"));
	}
	if (role === "verifier") appendFileSync(process.env.VERIFIER_LOG, JSON.stringify({ cwd: process.cwd(), sees: existsSync("new.txt") ? readFileSync("new.txt", "utf8") : null }) + "\\n");
	const result = at("--result-file");
	writeFileSync(result, "the " + role + " did it\\n\\nUNRESOLVED\\nnone\\n");
	writeFileSync(join(dirname(result), "result.json"), JSON.stringify({ outcome: "completed", endedBy: "completed", requests: 3, toolCalls: 2, model: "m", profile: null }));
}, Number(process.env.CHILD_SLEEP_MS ?? "0"));
`;

const saved = { ...process.env };
const savedCwd = process.cwd();
let dir: string;
let repo: string;
let manager: TaskManager;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kiso-writers-"));
	repo = join(dir, "repo");
	const home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	mkdirSync(repo);
	writeFileSync(join(dir, "child.mjs"), CHILD, "utf8");
	for (const k of ["KISO_SUBAGENT_DEPTH", "KISO_DELEGATION_CONFIG_JSON", "CHILD_SLEEP_MS", "KISO_TEST_SNAPSHOT_TOUCH", "KISO_TEST_SNAPSHOT_TOUCH_ALWAYS"]) delete process.env[k];
	Object.assign(process.env, { KISO_HOME: home, KISO_SESSIONS_DIR: join(home, "sessions"), KISO_SUBAGENT_BIN: join(dir, "child.mjs"), VERIFIER_LOG: join(dir, "verifier.jsonl") });
	git(["init", "-q"]);
	writeFileSync(join(repo, ".gitignore"), "secret.env\n");
	writeFileSync(join(repo, "a.txt"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	git(["add", "-A"]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
	process.chdir(repo);
	const created: TaskManager = new TaskManager({ root: join(home, "sessions", "s1.tasks"), backend: processTaskBackend({ runnerPath: RUNNER }), pollMs: 50, collect: (info) => collectWriter(info, created) });
	manager = created;
});

afterEach(async () => {
	await manager.stopAll();
	manager.close();
	process.chdir(savedCwd);
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

async function delegate(input: Record<string, unknown>, host: Record<string, unknown> = {}): Promise<{ content: string; isError: boolean }> {
	const ext = await createSubagent({ tasks: (sid: string | undefined) => (sid === "s1" ? manager : undefined), joinMs: 30_000, ...host } as never);
	const tool = ext.tools!.find((t) => t.name === "delegate")!;
	return (await tool.execute(input, { signal: new AbortController().signal, sessionId: "s1", executionId: "ex-w" } as never)) as { content: string; isError: boolean };
}

/** The person's repository, as git reports it — what a snapshot must not change. */
function fingerprint(): string {
	return JSON.stringify({
		objects: git(["count-objects", "-v"]),
		refs: git(["for-each-ref"]),
		index: readFileSync(join(repo, ".git", "index")).toString("base64"),
		stash: git(["stash", "list"]),
		worktrees: existsSync(join(repo, ".git", "worktrees")) ? readdirSync(join(repo, ".git", "worktrees")) : [],
		status: git(["--no-optional-locks", "status", "--porcelain=v1", "-z"]),
	});
}

describe("0.49.0 B6.1 / I3 — the writer's private snapshot", () => {
	it("holds the uncommitted edit and the untracked file, never the ignored one; the person's repository is unchanged", () => {
		writeFileSync(join(repo, "a.txt"), "edited, not committed\n");
		writeFileSync(join(repo, "untracked.txt"), "u\n");
		writeFileSync(join(repo, "secret.env"), "KEY=1\n");
		const before = fingerprint();
		const ws = join(dir, "snap");
		const s = snapshotWorkspace(repo, ws);
		expect(fingerprint()).toBe(before);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("edited, not committed\n");
		expect(readFileSync(join(ws, "untracked.txt"), "utf8")).toBe("u\n");
		expect(existsSync(join(ws, "secret.env"))).toBe(false);
		expect(git(["status", "--porcelain"], ws)).toBe(""); // the snapshot is committed: the writer's base
		expect(s.base).not.toBe(s.head);
		expect(readFileSync(join(ws, ".git", "objects", "info", "alternates"), "utf8")).toContain(join(realpathSync(repo), ".git", "objects"));
	});

	it("names with a newline, a quote and a space survive the machine-format manifest", () => {
		for (const name of ["with space.txt", 'quote".txt', "new\nline.txt"]) writeFileSync(join(repo, name), `${name}\n`);
		const ws = join(dir, "snap");
		snapshotWorkspace(repo, ws);
		for (const name of ["with space.txt", 'quote".txt', "new\nline.txt"]) expect(readFileSync(join(ws, name), "utf8")).toBe(`${name}\n`);
	});

	it("over the cap: refused, never HEAD instead", () => {
		writeFileSync(join(repo, "big.bin"), Buffer.alloc(4096));
		expect(() => snapshotWorkspace(repo, join(dir, "snap"), 1024)).toThrow(/would copy 4096 bytes, over 1024 bytes; commit, stash or shrink the workspace/);
		expect(existsSync(join(dir, "snap"))).toBe(false);
	});

	it("a tree that moved during the capture is captured again; one that keeps moving is refused", () => {
		const touched = join(repo, "busy.txt");
		writeFileSync(touched, "busy\n");
		process.env.KISO_TEST_SNAPSHOT_TOUCH = touched;
		const ws = join(dir, "snap");
		snapshotWorkspace(repo, ws); // moved once: the second capture holds
		expect(readFileSync(join(ws, "busy.txt"), "utf8")).toBe("busy\nx");
		process.env.KISO_TEST_SNAPSHOT_TOUCH_ALWAYS = "1";
		expect(() => snapshotWorkspace(repo, join(dir, "snap2"))).toThrow(/changed while the snapshot was being captured/);
		expect(existsSync(join(dir, "snap2"))).toBe(false);
	});
});

describe("0.49.0 B1 — an implementer, joined and collected", () => {
	it("its section names the patch and the command that adopts it; the patch is never inline; its workspace is gone", async () => {
		writeFileSync(join(repo, "a.txt"), readFileSync(join(repo, "a.txt"), "utf8").replace("line 2", "line 2 PERSON"));
		const r = await delegate({ tasks: [{ role: "implementer", task: "add new.txt" }] });
		expect(r.isError).toBe(false);
		const taskDir = join(process.env.KISO_HOME!, "sessions", "s1.tasks", "t1");
		expect(r.content).toContain(`patch: ${join(taskDir, "patch.diff")} (2 files: a.txt, new.txt)`);
		expect(r.content).toMatch(/· child acceptance: none\n {2}apply: node \S+ apply-patch \S+t1/);
		expect(r.content).not.toContain("NEW-FROM-THE-CHILD");
		const patch = JSON.parse(readFileSync(join(taskDir, "patch.json"), "utf8")) as { files: { path: string; status: string }[]; applyable: boolean };
		expect(patch.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A new.txt", "M a.txt"]);
		expect(patch.applyable).toBe(true);
		// the child started from the person's uncommitted edit (B6.1), so its version of a.txt has both
		const n = patch.files.findIndex((f) => f.path === "a.txt");
		expect(readFileSync(join(taskDir, "versions", `${n}.child`), "utf8")).toMatch(/line 2 PERSON[\s\S]*line 9 CHILD/);
		expect(manager.get("t1")!.collection).toEqual({ outcome: "collected" });
		const sub = readdirSync(join(process.env.KISO_HOME!, "sessions", "subagent")).find((f) => f.endsWith("-implementer"))!;
		expect(existsSync(join(process.env.KISO_HOME!, "sessions", "subagent", sub, "ws"))).toBe(false);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).not.toContain("CHILD"); // adoption is a separate effect
	}, 60_000);

	it("the child's acceptance runs in its tree after it completes, and rides the handoff", async () => {
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: { has: "grep -q NEW-FROM-THE-CHILD new.txt" }, profiles: [] });
		const r = await delegate({ tasks: [{ role: "implementer", task: "add new.txt", acceptance: { check: "has" } }] });
		expect(r.content).toContain("child acceptance: PASSED");
		expect(JSON.parse(readFileSync(join(process.env.KISO_HOME!, "sessions", "s1.tasks", "t1", "acceptance.json"), "utf8"))).toMatchObject({ passed: true, exitCode: 0 });
	}, 60_000);

	it("a resumed collection never runs the acceptance twice (kill -9 between steps)", async () => {
		const counter = join(dir, "acceptance-runs");
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: { count: `echo run >> '${counter}'` }, profiles: [] });
		await delegate({ tasks: [{ role: "implementer", task: "add new.txt", acceptance: { check: "count" } }] });
		const journal = join(process.env.KISO_HOME!, "sessions", "s1.tasks", "t1", "journal.jsonl");
		// the crash window: everything recorded but `collected`
		writeFileSync(journal, readFileSync(journal, "utf8").split("\n").filter((l) => !l.includes('"type":"collected"')).join("\n"));
		await collectWriter(manager.get("t1")!, manager);
		expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
		expect(manager.get("t1")!.collection).toEqual({ outcome: "collected" });
	}, 60_000);

	it("a stopped implementer's patch is partial and not applyable; no acceptance runs", async () => {
		process.env.CHILD_SLEEP_MS = "20000";
		process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: { has: "true" }, profiles: [] });
		const r = await delegate({ tasks: [{ role: "implementer", task: "add new.txt", acceptance: { check: "has" } }], background: true });
		expect(r.content).toMatch(/writers work in a snapshot of it taken now/);
		await new Promise((res) => setTimeout(res, 1_500));
		expect(manager.stop("t1", "model")).toBe(true);
		const w = await manager.awaitSettled("t1", "end", 20_000);
		expect(w.settled).toBe(true);
		expect(manager.get("t1")!.collection?.outcome).toBe("stopped");
		const taskDir = join(process.env.KISO_HOME!, "sessions", "s1.tasks", "t1");
		expect(JSON.parse(readFileSync(join(taskDir, "patch.json"), "utf8"))).toMatchObject({ completeness: "partial", applyable: false });
		expect(existsSync(join(taskDir, "acceptance.json"))).toBe(false);
	}, 60_000);
});

describe("0.49.0 B2 — a verifier after an implementer", () => {
	it("is started by the implementer's collection, in base plus its patch, in the same group", async () => {
		const r = await delegate({ tasks: [{ role: "implementer", task: "add new.txt" }, { role: "verifier", task: "check new.txt", after: "1" }] });
		expect(r.content).toMatch(/its verifier runs as task t2, in base plus this patch/);
		const v = manager.get("t2")!;
		expect(v.executionId).toBe("ex-w");
		expect(v.agent).toMatchObject({ role: "verifier", collect: true });
		await manager.awaitSettled("t2", "end", 20_000);
		const seen = JSON.parse(readFileSync(process.env.VERIFIER_LOG!, "utf8").trim()) as { sees: string | null };
		expect(seen.sees).toBe("NEW-FROM-THE-CHILD\n");
		expect(manager.get("t2")!.collection?.outcome).toBe("collected"); // a verifier's writes are never collected: only its end
		expect(existsSync(join(process.env.KISO_HOME!, "sessions", "s1.tasks", "t2", "patch.json"))).toBe(false);
	}, 60_000);

	it("an `after` that names an earlier call's implementer is refused: its tree was collected and removed", async () => {
		const r = await delegate({ tasks: [{ role: "verifier", task: "check", after: "1" }] });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/`after` must give the 1-based index of an earlier implementer in this call/);
		expect(manager.list()).toEqual([]);
	});
});

describe("0.49.0 B4 — the writer cap", () => {
	it("a batch that does not fit starts nothing, and builds no workspace", async () => {
		const r = await delegate({ tasks: Array.from({ length: 5 }, (_, i) => ({ role: "implementer", task: `change ${i}` })) });
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/the writer cap is 4; this call asks for 5/);
		expect(manager.list()).toEqual([]);
		const art = join(process.env.KISO_HOME!, "sessions", "subagent");
		expect(existsSync(art) ? readdirSync(art).filter((f) => existsSync(join(art, f, "ws"))) : []).toEqual([]);
	});
});
