/**
 * 0.40.0 (the owner's dogfood: a session of one project resumed from another) —
 * one session folder per project, and the one-time move into them.
 *
 * The layout and the move, over real directories: folders named by the
 * workspace and identified by `workspace.json`; the placement of recorded,
 * inferred and unknown legacy sessions; a live lock skipped; a child and a
 * trace following their session; the manifest landing before any move;
 * a re-run that finds nothing; the reverse.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalPath,
	claimProjectDir,
	encodeWorkspace,
	folderWorkspace,
	parentOfChild,
	projectDirFor,
	projectLayoutActive,
	sessionFiles,
	unknownDir,
} from "../src/projects.js";
import { countPlan, INFER_MIN_MENTIONS, planMigration, reverseMigration, runMigration } from "../src/session-migration.js";

// .native, as the product resolves: on Windows it expands an 8.3 short name
// (the runner's temp dir is RUNNER~1), the JS realpath does not
const fresh = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), "kiso-projects-")));

/** A repository on disk: the inference maps paths to the nearest `.git`. */
function repo(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, ".git"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

/** A legacy session: a log whose tool calls name `paths`, and, when given,
 *  a profile that recorded `workspace`. */
function legacySession(home: string, id: string, opts: { readonly paths?: readonly string[]; readonly workspace?: string; readonly lock?: string; readonly trace?: boolean } = {}): void {
	const dir = join(home, "sessions");
	mkdirSync(join(dir, "traces"), { recursive: true });
	const events = [
		{ runId: "r", ts: 1, event: { seq: 0, type: "user_input", content: "go" } },
		...(opts.paths ?? []).map((path, i) => ({ runId: "r", ts: 2 + i, event: { seq: 1 + i, type: "tool_call_end", callId: `c${i}`, name: "read_file", input: { path } } })),
		{ runId: "r", ts: 99, event: { seq: 99, type: "terminal", outcome: { kind: "completed" } } },
	];
	writeFileSync(join(dir, `${id}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	if (opts.workspace !== undefined) {
		const profile = { revision: 1, at: "2026-09-18T00:00:00.000Z", modelId: "m", provider: null, profileName: null, systemPromptDigest: "d", toolManifestDigest: "t", tools: [], workspace: opts.workspace };
		writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ profile }));
	}
	if (opts.lock !== undefined) writeFileSync(join(dir, `${id}.lock`), opts.lock);
	if (opts.trace === true) writeFileSync(join(dir, "traces", `${id}.jsonl`), `{"kind":"request"}\n`);
}

describe("the folder of a project", () => {
	it("is the realpath with every non-alphanumeric turned into '-'", () => {
		expect(encodeWorkspace("/Users/me/Desktop/devv/project-b")).toBe("-Users-me-Desktop-devv-project-b");
	});

	it("records whose it is, and another realpath that encodes alike gets a suffixed folder, never this one", () => {
		const home = fresh();
		const a = projectDirFor(home, "/w/b-c");
		claimProjectDir(a, "/w/b-c");
		expect(folderWorkspace(a)).toBe("/w/b-c");
		const b = projectDirFor(home, "/w/b/c");
		expect(encodeWorkspace("/w/b/c")).toBe(encodeWorkspace("/w/b-c"));
		expect(b).not.toBe(a);
		expect(b.startsWith(`${a}-`)).toBe(true);
		// the owner of a folder is never rewritten by a later claim
		claimProjectDir(a, "/w/other");
		expect(folderWorkspace(a)).toBe("/w/b-c");
		// and the first workspace keeps finding its own folder
		expect(projectDirFor(home, "/w/b-c")).toBe(a);
	});

	it("a pinned KISO_SESSIONS_DIR, or a reversed migration, turns the layout off", () => {
		const home = fresh();
		expect(projectLayoutActive(home, {})).toBe(true);
		expect(projectLayoutActive(home, { KISO_SESSIONS_DIR: join(home, "sessions") })).toBe(false);
		mkdirSync(join(home, "projects"), { recursive: true });
		writeFileSync(join(home, "projects", ".migration-reversed"), "x");
		expect(projectLayoutActive(home, {})).toBe(false);
	});

	it("on a case-insensitive disk, two spellings of one directory are one project", () => {
		const root = fresh();
		const dir = join(root, "Proj");
		mkdirSync(dir);
		const other = join(root, "proj");
		if (!existsSync(other)) return; // a case-sensitive disk: nothing to fold
		expect(canonicalPath(other)).toBe(dir);
	});

	it("a child's id names its parent, in both historical forms", () => {
		expect(parentOfChild("sub-2026-09-08T04-45-04-71c1-01df667ca87a8de31fddeebf-2-explorer")).toBe("2026-09-08T04-45-04-71c1");
		expect(parentOfChild("sub-2026-09-05T13-47-10-936c-1-reviewer")).toBe("2026-09-05T13-47-10-936c");
		expect(parentOfChild("2026-09-05T13-47-10-936c")).toBeNull();
	});

	it("a session's log moves LAST", () => {
		expect(sessionFiles("s").at(-1)).toBe("s.jsonl");
	});
});

/** The one-time move sorts pre-0.40 legacy sessions by the POSIX paths
 *  their tool calls name. A Windows install never held a legacy session
 *  (Windows was install-refused before and after 0.40), so its inference
 *  cases are POSIX-only; the move's file handling runs everywhere. */
const LEGACY_POSIX = process.platform === "win32";

describe("the one-time move", () => {
	function world() {
		const root = fresh();
		const home = join(root, "kiso-home");
		const alpha = repo(root, "alpha");
		const beta = repo(root, "beta");
		const many = (dir: string, n: number): string[] => Array.from({ length: n }, (_, i) => join(dir, "src", `f${i}.ts`));
		legacySession(home, "rec", { workspace: beta, trace: true });
		legacySession(home, "inf", { paths: many(alpha, INFER_MIN_MENTIONS), trace: true });
		legacySession(home, "sub-inf-0123456789abcdef01234567-1-explorer", { paths: [] });
		legacySession(home, "few", { paths: many(alpha, INFER_MIN_MENTIONS - 1) });
		legacySession(home, "split", { paths: [...many(alpha, 7), ...many(beta, 3)] });
		legacySession(home, "none", {});
		legacySession(home, "open", { paths: many(alpha, 5), lock: JSON.stringify({ pid: process.pid, token: "t" }) });
		legacySession(home, "released", { paths: many(beta, 4), lock: "" });
		legacySession(home, "kisohome", { paths: many(join(home, "sessions"), 5) });
		return { root, home, alpha, beta };
	}

	it.skipIf(LEGACY_POSIX)("places recorded, inferred and unknown sessions, skips a live lock, and a child follows its parent", () => {
		const { home, alpha, beta } = world();
		const plan = planMigration(home, { userHome: home });
		const by = new Map(plan.map((p) => [p.id, p]));
		expect(by.get("rec")).toMatchObject({ reason: "recorded", workspace: beta, to: projectDirFor(home, beta) });
		expect(by.get("inf")).toMatchObject({ reason: "inferred", workspace: alpha, evidence: { root: alpha, mentions: 3, total: 3 } });
		expect(by.get("sub-inf-0123456789abcdef01234567-1-explorer")).toMatchObject({ reason: "inferred", workspace: alpha, parent: "inf" });
		// below the thresholds: unknown, with the evidence kept for the record
		expect(by.get("few")).toMatchObject({ reason: "unknown", to: unknownDir(home), evidence: { mentions: 2 } });
		expect(by.get("split")).toMatchObject({ reason: "unknown", evidence: { root: alpha, mentions: 7, total: 10 } });
		expect(by.get("none")).toMatchObject({ reason: "unknown" });
		expect(by.get("none")!.evidence).toBeUndefined();
		// a live holder: not moved now; a released (empty) lock: moved
		expect(by.get("open")).toMatchObject({ reason: "skipped-live", to: null });
		expect(by.get("released")).toMatchObject({ reason: "inferred", workspace: beta });
		// paths inside KISO_HOME are no project's
		expect(by.get("kisohome")).toMatchObject({ reason: "unknown" });
		expect(countPlan(plan)).toEqual({ recorded: 1, inferred: 3, unknown: 4, skippedLive: 1 });
		// children move before their parent
		expect(plan.findIndex((p) => p.id.startsWith("sub-"))).toBeLessThan(plan.findIndex((p) => p.id === "inf"));
	});

	it.skipIf(LEGACY_POSIX)("a linked worktree's paths belong to its main repository", () => {
		const root = fresh();
		const home = join(root, "kiso-home");
		const main = repo(root, "main");
		const wt = join(root, "wt");
		mkdirSync(join(wt, "src"), { recursive: true });
		writeFileSync(join(wt, ".git"), `gitdir: ${main}/.git/worktrees/wt\n`);
		legacySession(home, "w", { paths: [join(wt, "src", "a.ts"), join(wt, "src", "b.ts"), join(main, "src", "c.ts")] });
		expect(planMigration(home, { userHome: home })[0]).toMatchObject({ reason: "inferred", workspace: main, evidence: { mentions: 3, total: 3 } });
	});

	it.skipIf(LEGACY_POSIX)("moves trace, sidecar and log into the folder; a re-run finds only the open session; nothing is deleted", () => {
		const { home, alpha, beta } = world();
		const result = runMigration(home, planMigration(home, { userHome: home }))!;
		expect(result.moved).toBe(8);
		const betaDir = projectDirFor(home, beta);
		expect(folderWorkspace(betaDir)).toBe(beta);
		for (const f of ["rec.jsonl", "rec.meta.json", join("traces", "rec.jsonl")]) expect(existsSync(join(betaDir, f)), f).toBe(true);
		expect(existsSync(join(projectDirFor(home, alpha), "sub-inf-0123456789abcdef01234567-1-explorer.jsonl"))).toBe(true);
		expect(existsSync(join(unknownDir(home), "none.jsonl"))).toBe(true);
		expect(existsSync(join(home, "sessions", "open.jsonl"))).toBe(true);
		// idempotent: only the open one is still pending, and it is still skipped
		const again = planMigration(home, { userHome: home });
		expect(again.map((p) => [p.id, p.reason])).toEqual([["open", "skipped-live"]]);
		expect(runMigration(home, again)).toBeNull();
	});

	it("the manifest lands before the first move", () => {
		const { root, home } = world();
		const plan = planMigration(home, { userHome: home });
		// a target the move cannot create: the run stops at its first session
		const blocker = join(root, "a-file");
		writeFileSync(blocker, "");
		const broken = plan.map((p, i) => (i === 0 ? { ...p, to: join(blocker, "under") } : p));
		expect(() => runMigration(home, broken)).toThrow();
		const manifests = readdirManifests(home);
		expect(manifests).toHaveLength(1);
		const written = JSON.parse(readFileSync(manifests[0]!, "utf8")) as { completedAt: unknown; entries: unknown[] };
		expect(written.completedAt).toBeNull();
		expect(written.entries).toHaveLength(plan.length);
		// and nothing moved
		expect(existsSync(join(home, "sessions", `${plan[0]!.id}.jsonl`))).toBe(true);
	});

	it("a move interrupted part-way completes on the next run, where the first run was taking it", () => {
		const { home, beta } = world();
		const plan = planMigration(home, { userHome: home });
		const rec = plan.find((p) => p.id === "rec")!;
		// the crash: the manifest landed, the trace and the sidecar moved,
		// the log did not — and the sidecar was what recorded the workspace
		mkdirSync(join(home, "projects"), { recursive: true });
		writeFileSync(join(home, "projects", "migration-2026-09-18T00-00-00-000Z.json"), JSON.stringify({ version: 1, completedAt: null, entries: plan }));
		claimProjectDir(rec.to!, beta);
		mkdirSync(join(rec.to!, "traces"), { recursive: true });
		renameSync(join(home, "sessions", "traces", "rec.jsonl"), join(rec.to!, "traces", "rec.jsonl"));
		renameSync(join(home, "sessions", "rec.meta.json"), join(rec.to!, "rec.meta.json"));
		// the re-plan keeps the first decision instead of re-deciding from
		// a log whose record has gone ahead of it
		const again = planMigration(home, { userHome: home });
		expect(again.find((p) => p.id === "rec")).toMatchObject({ reason: "recorded", workspace: beta, to: rec.to });
		runMigration(home, again);
		expect(existsSync(join(rec.to!, "rec.jsonl"))).toBe(true);
		expect(existsSync(join(home, "sessions", "rec.jsonl"))).toBe(false);
	});

	it("the reverse puts every moved session back and switches the layout off", () => {
		const { home } = world();
		const result = runMigration(home, planMigration(home, { userHome: home }))!;
		const back = reverseMigration(home, result.manifest);
		expect(back).toEqual({ restored: 8, left: 0 });
		for (const id of ["rec", "inf", "few", "none", "released", "sub-inf-0123456789abcdef01234567-1-explorer"]) expect(existsSync(join(home, "sessions", `${id}.jsonl`)), id).toBe(true);
		expect(existsSync(join(home, "sessions", "traces", "rec.jsonl"))).toBe(true);
		expect(existsSync(join(home, "sessions", "rec.meta.json"))).toBe(true);
		expect(projectLayoutActive(home, {})).toBe(false);
	});
});

function readdirManifests(home: string): string[] {
	const dir = join(home, "projects");
	return (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.startsWith("migration-")).map((f) => join(dir, f));
}
