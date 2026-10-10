/**
 * 0.49.0 B6.2 / I4 — `kiso apply-patch`: adopting a writer's collected
 * patch. PREPARE merges every file three ways and writes nothing on a
 * conflict or an unsupported entry; PUBLISH is per file, revalidated and
 * journaled, a creation never overwrites, and a late change ends PARTIAL;
 * VERIFY runs the acceptance again in the workspace, always, with no
 * rollback; an interrupted adoption is reported from its journal, never
 * retried. The person's index is never touched.
 *
 * Each case builds a scratch repository (the workspace) and a task
 * directory as collectWriter leaves it: patch.json, versions/, patch.diff.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch } from "../src/apply-patch.js";

type Spec = { path: string; status: "A" | "M" | "D"; base?: string; child?: string; baseMode?: string; mode?: string };

let ws: string;
let taskDir: string;
let home: string;
const saved = { ...process.env };
let out: string[];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "kiso-apply-"));
	ws = join(dir, "ws");
	taskDir = join(dir, "task");
	home = join(dir, "home");
	for (const d of [ws, taskDir, home]) mkdirSync(d, { recursive: true });
	process.env.KISO_HOME = home;
	delete process.env.KISO_TEST_APPLY_HOOK;
	execFileSync("git", ["init", "-q"], { cwd: ws });
	out = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

/** The workspace: committed files, then optional uncommitted edits. */
function workspace(committed: Record<string, string>, edits: Record<string, string> = {}): void {
	for (const [p, c] of Object.entries(committed)) {
		mkdirSync(join(ws, p, ".."), { recursive: true });
		writeFileSync(join(ws, p), c);
	}
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: ws });
	for (const [p, c] of Object.entries(edits)) writeFileSync(join(ws, p), c);
}

/** The task directory as the collection leaves it. */
function task(files: Spec[], extra: Record<string, unknown> = {}): void {
	mkdirSync(join(taskDir, "versions"), { recursive: true });
	files.forEach((f, n) => {
		if (f.base !== undefined) writeFileSync(join(taskDir, "versions", `${n}.base`), f.base);
		if (f.child !== undefined) writeFileSync(join(taskDir, "versions", `${n}.child`), f.child);
	});
	writeFileSync(join(taskDir, "patch.diff"), "(the diff)\n");
	const record = { base: "b".repeat(40), bytes: 11, completeness: "complete", applyable: true, files: files.map((f) => ({ path: f.path, status: f.status, baseMode: f.baseMode ?? (f.status === "A" ? "000000" : "100644"), mode: f.mode ?? (f.status === "D" ? "000000" : "100644") })), ...extra };
	writeFileSync(join(taskDir, "patch.json"), JSON.stringify(record));
}

const lines = (n: number, mark: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const journal = () => (existsSync(join(taskDir, "apply.jsonl")) ? readFileSync(join(taskDir, "apply.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; outcome?: string; path?: string }) : []);
const indexBytes = () => readFileSync(join(ws, ".git", "index"));

describe("0.49.0 B6.2 — PREPARE: all or none", () => {
	it("an edit on another line merges cleanly with the workspace's uncommitted edit; the index is untouched", async () => {
		workspace({ "a.txt": lines(20) }, { "a.txt": lines(20, { 2: "line 2 WORKSPACE" }) });
		task([{ path: "a.txt", status: "M", base: lines(20), child: lines(20, { 18: "line 18 CHILD" }) }]);
		const before = indexBytes();
		expect(await applyPatch([taskDir], ws)).toBe(0);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe(lines(20, { 2: "line 2 WORKSPACE", 18: "line 18 CHILD" }));
		expect(indexBytes().equals(before)).toBe(true);
		expect(journal().map((r) => r.type)).toEqual(["apply_planned", "apply_file_published", "publication_complete", "apply_terminal"]);
		expect(out.join("\n")).toMatch(/workspace acceptance: none named — the merge was textual only/);
	});

	it("an edit on the same line writes nothing and names the hunk; --with-markers writes the markers", async () => {
		workspace({ "a.txt": lines(5) }, { "a.txt": lines(5, { 3: "line 3 WORKSPACE" }) });
		task([{ path: "a.txt", status: "M", base: lines(5), child: lines(5, { 3: "line 3 CHILD" }) }]);
		expect(await applyPatch([taskDir], ws)).toBe(3);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe(lines(5, { 3: "line 3 WORKSPACE" }));
		expect(journal()).toEqual([]);
		expect(out.join("\n")).toMatch(/a\.txt: 1 conflicting hunk[\s\S]*<<<<<<< workspace[\s\S]*line 3 CHILD[\s\S]*>>>>>>> child/);
		expect(await applyPatch([taskDir, "--with-markers"], ws)).toBe(0);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toMatch(/<<<<<<< workspace\nline 3 WORKSPACE\n=======\nline 3 CHILD\n>>>>>>> child/);
	});

	it("one conflict among several files: nothing at all is written", async () => {
		workspace({ "a.txt": lines(5), "b.txt": "b\n" }, { "a.txt": lines(5, { 1: "MINE" }) });
		task([
			{ path: "b.txt", status: "M", base: "b\n", child: "b changed\n" },
			{ path: "a.txt", status: "M", base: lines(5), child: lines(5, { 1: "THEIRS" }) },
		]);
		expect(await applyPatch([taskDir], ws)).toBe(3);
		expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("b\n");
	});

	it("unsupported entries refuse the whole patch: a symlink, a mode change, a name differing only in case", async () => {
		workspace({ "a.txt": "a\n", "README.md": "r\n" });
		for (const spec of [
			{ path: "link", status: "A", child: "a.txt", mode: "120000" },
			{ path: "a.txt", status: "M", base: "a\n", child: "a\n", baseMode: "100644", mode: "100755" },
			{ path: "readme.md", status: "A", child: "x\n" },
		] as Spec[]) {
			task([spec]);
			out = [];
			expect(await applyPatch([taskDir], ws), spec.path).toBe(5);
			expect(out.join("\n")).toMatch(/adopts regular files only/);
		}
		expect(existsSync(join(ws, "link"))).toBe(false);
	});

	it("a created executable keeps its bit; a deletion of an unchanged file deletes it", async () => {
		workspace({ "gone.txt": "g\n" });
		task([
			{ path: "bin/run.sh", status: "A", child: "#!/bin/sh\necho hi\n", mode: "100755" },
			{ path: "gone.txt", status: "D", base: "g\n" },
		]);
		expect(await applyPatch([taskDir], ws)).toBe(0);
		expect(statSync(join(ws, "bin/run.sh")).mode & 0o111).not.toBe(0);
		expect(existsSync(join(ws, "gone.txt"))).toBe(false);
	});

	it("a partial patch (its child was stopped) is adopted only with --allow-partial; an adopted one never twice", async () => {
		workspace({ "a.txt": "a\n" });
		task([{ path: "a.txt", status: "M", base: "a\n", child: "a2\n" }], { completeness: "partial", applyable: false });
		expect(await applyPatch([taskDir], ws)).toBe(5);
		expect(await applyPatch([taskDir, "--allow-partial"], ws)).toBe(0);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a2\n");
		expect(await applyPatch([taskDir, "--allow-partial"], ws)).toBe(5);
		expect(out.join("\n")).toMatch(/already adopted/);
	});
});

describe("0.49.0 I4 — PUBLISH: per file, revalidated, never clobbering", () => {
	function hook(src: string): void {
		const p = join(taskDir, "..", "hook.mjs");
		writeFileSync(p, src);
		process.env.KISO_TEST_APPLY_HOOK = p;
	}

	it("a target created between PREPARE and PUBLISH is never overwritten: PARTIAL, the person's file intact", async () => {
		workspace({ "keep.txt": "k\n" });
		task([{ path: "new.txt", status: "A", child: "from the child\n" }]);
		hook(`import { writeFileSync } from "node:fs"; export function afterPrepare() { writeFileSync(${JSON.stringify(join(ws, "new.txt"))}, "the person's own\\n"); }`);
		expect(await applyPatch([taskDir], ws)).toBe(4);
		expect(readFileSync(join(ws, "new.txt"), "utf8")).toBe("the person's own\n");
		expect(journal().at(-1)).toMatchObject({ type: "apply_terminal", outcome: "partial" });
	});

	it("revalidation fails on the 2nd of 3 files: one published and journaled, the rest named, nothing retried", async () => {
		workspace({ "1.txt": "1\n", "2.txt": "2\n", "3.txt": "3\n" });
		task(["1", "2", "3"].map((n) => ({ path: `${n}.txt`, status: "M" as const, base: `${n}\n`, child: `${n} child\n` })));
		hook(`import { writeFileSync } from "node:fs"; export function afterPublish(p) { if (p === "1.txt") writeFileSync(${JSON.stringify(join(ws, "2.txt"))}, "2 edited meanwhile\\n"); }`);
		expect(await applyPatch([taskDir], ws)).toBe(4);
		expect(readFileSync(join(ws, "1.txt"), "utf8")).toBe("1 child\n");
		expect(readFileSync(join(ws, "2.txt"), "utf8")).toBe("2 edited meanwhile\n");
		expect(readFileSync(join(ws, "3.txt"), "utf8")).toBe("3\n");
		expect(journal().filter((r) => r.type === "apply_file_published").map((r) => r.path)).toEqual(["1.txt"]);
		expect(out.join("\n")).toMatch(/published: 1\.txt\n {2}not published: 2\.txt, 3\.txt/);
		// a re-run refuses: the journal has a terminal
		expect(await applyPatch([taskDir], ws)).toBe(5);
	});

	it("an adoption interrupted mid-publication (kill -9) is reported from its journal, never resumed", async () => {
		workspace({ "1.txt": "1\n", "2.txt": "2\n" });
		task([
			{ path: "1.txt", status: "M", base: "1\n", child: "1c\n" },
			{ path: "2.txt", status: "M", base: "2\n", child: "2c\n" },
		]);
		writeFileSync(join(taskDir, "apply.jsonl"), `${JSON.stringify({ type: "apply_planned", files: [{ path: "1.txt" }, { path: "2.txt" }] })}\n${JSON.stringify({ type: "apply_file_published", path: "1.txt" })}\n`);
		expect(await applyPatch([taskDir], ws)).toBe(1);
		expect(out.join("\n")).toMatch(/interrupted mid-publication — published: 1\.txt; not published: 2\.txt/);
		expect(readFileSync(join(ws, "2.txt"), "utf8")).toBe("2\n");
	});

	it("a verification interrupted before it started is NOT COMPLETED; during it, UNKNOWN — neither is retried", async () => {
		workspace({ "a.txt": "a\n" });
		task([{ path: "a.txt", status: "M", base: "a\n", child: "a2\n" }]);
		const done = `${JSON.stringify({ type: "apply_planned", files: [{ path: "a.txt" }] })}\n${JSON.stringify({ type: "apply_file_published", path: "a.txt" })}\n${JSON.stringify({ type: "publication_complete" })}\n`;
		writeFileSync(join(taskDir, "apply.jsonl"), done);
		expect(await applyPatch([taskDir], ws)).toBe(1);
		expect(out.join("\n")).toMatch(/workspace acceptance was NOT COMPLETED/);
		writeFileSync(join(taskDir, "apply.jsonl"), `${done}${JSON.stringify({ type: "acceptance_started", check: "t" })}\n`);
		out = [];
		expect(await applyPatch([taskDir], ws)).toBe(1);
		expect(out.join("\n")).toMatch(/its outcome is UNKNOWN/);
	});
});

describe("0.49.0 B6.3 — VERIFY: the acceptance always runs again in the workspace, no rollback", () => {
	it("a clean adoption runs the named check from the configuration; both verdicts are printed; a failure keeps the files", async () => {
		writeFileSync(join(home, "config.json"), JSON.stringify({ checks: { has: "test -f a.txt && grep -q a2 a.txt", never: "exit 7" } }));
		workspace({ "a.txt": "a\n" });
		task([{ path: "a.txt", status: "M", base: "a\n", child: "a2\n" }], { acceptance: { check: "has" } });
		writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify({ passed: true }));
		expect(await applyPatch([taskDir], ws)).toBe(0);
		expect(out.join("\n")).toMatch(/child acceptance: PASSED · workspace acceptance: PASSED \(exit 0\)/);
		expect(journal().map((r) => r.type)).toEqual(["apply_planned", "apply_file_published", "publication_complete", "acceptance_started", "acceptance_result", "apply_terminal"]);

		// a failing workspace check is a fact beside the adoption, never a rollback
		const dir2 = mkdtempSync(join(tmpdir(), "kiso-apply2-"));
		taskDir = join(dir2, "task");
		mkdirSync(taskDir);
		writeFileSync(join(ws, "b.txt"), "b\n");
		task([{ path: "b.txt", status: "M", base: "b\n", child: "b2\n" }], { acceptance: { check: "never" } });
		out = [];
		expect(await applyPatch([taskDir], ws)).toBe(0);
		expect(out.join("\n")).toMatch(/workspace acceptance: FAILED \(exit 7\)/);
		expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("b2\n");
	});

	it("a check no longer configured is not run from the record: the adoption says why", async () => {
		workspace({ "a.txt": "a\n" });
		task([{ path: "a.txt", status: "M", base: "a\n", child: "a2\n" }], { acceptance: { check: "gone" } });
		expect(await applyPatch([taskDir], ws)).toBe(0);
		expect(out.join("\n")).toMatch(/workspace acceptance: not run — the check "gone" is no longer configured/);
	});
});

