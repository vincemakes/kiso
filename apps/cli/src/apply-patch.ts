/**
 * 0.49.0 B6.2 / I4 — `kiso apply-patch <taskDir> [--allow-partial]
 * [--with-markers]`: adopt an implementer's collected patch into the
 * workspace. A writer owns an isolated workspace; adoption is a separate,
 * crash-honest effect.
 *
 * The collection (the subagent extension's collectWriter) left in the task
 * directory: `patch.json` (the files, their modes, whether the patch is
 * complete), `versions/<n>.base` and `versions/<n>.child` (each changed
 * file before and after the child), and the child's `acceptance.json`.
 *
 * PREPARE writes nothing: each file is merged three ways — base (the
 * snapshot the child started from), ours (the workspace now), theirs (the
 * child's) — with `git merge-file`'s algorithm, which never reads or writes
 * the index. Any conflict, or an entry this release does not adopt
 * (symlinks, submodules, a mode change on an existing file, a file and a
 * directory trading places, two names differing only in case), stops here
 * with nothing written.
 *
 * PUBLISH is per file and journaled (`<taskDir>/apply.jsonl`): each target
 * is revalidated against what PREPARE saw; a creation is no-clobber (link
 * or refuse, WR-1A ②'s rule); a modification is revalidated right before
 * its rename (WR-1A ③); a deletion is revalidated, then unlinked — the
 * same narrow check-to-effect window WR-1's conditional write has, never
 * called a compare-and-swap. A filesystem has no multi-file transaction,
 * so the promise is all-or-none PREPARE, never an atomic write: a late
 * revalidation failure ends `partial`, naming what was and was not
 * published, and nothing retries it.
 *
 * VERIFY: after a clean publication the patch's acceptance always runs
 * again in the workspace (the child's ran against the snapshot; the
 * workspace has what the snapshot never held — ignored files, a build
 * cache). It is re-resolved from the configuration by its NAME, never run
 * from the record; it touches no git state. Both verdicts are printed.
 * There is no automatic rollback. An interrupted verification is reported
 * as not completed (before it started) or unknown (while it ran), and never
 * retried by itself.
 *
 * Exit codes: 0 clean (whatever the acceptance said — two facts, printed),
 * 3 conflicted, 4 partial, 5 refused or unsupported, 1 failed.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectArtifacts, trustFor } from "@vincemakes/kiso-runtime";
import { loadProjectConfig, loadUserConfig, mergeConfigs, resolveProjectTrustPolicy } from "./config.js";

interface PatchFile {
	readonly path: string;
	readonly status: string;
	readonly baseMode: string;
	readonly mode: string;
}

interface PatchRecord {
	readonly base: string;
	readonly files: readonly PatchFile[];
	readonly completeness: "complete" | "partial";
	readonly applyable: boolean;
	readonly acceptance?: { readonly check?: string; readonly evaluator?: string };
}

type Action = "create" | "modify" | "delete";

interface Planned {
	readonly path: string;
	readonly action: Action;
	/** sha256 of the target as PREPARE saw it, or "absent" */
	readonly expected: string;
	readonly content?: Buffer;
	readonly exec?: boolean;
}

const ABSENT = "absent";
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export async function applyPatch(args: readonly string[], cwd: string = process.cwd()): Promise<number> {
	const taskDir = args.find((a) => !a.startsWith("--"));
	const allowPartial = args.includes("--allow-partial");
	const withMarkers = args.includes("--with-markers");
	if (taskDir === undefined) {
		console.error("usage: kiso apply-patch <task directory> [--allow-partial] [--with-markers]");
		return 5;
	}
	let patch: PatchRecord;
	try {
		patch = JSON.parse(readFileSync(join(taskDir, "patch.json"), "utf8")) as PatchRecord;
	} catch (err) {
		console.error(`apply-patch: no collected patch in ${taskDir} (${(err as Error).message})`);
		return 1;
	}
	const journal = join(taskDir, "apply.jsonl");
	const prior = readJournal(journal);
	if (prior.length > 0) {
		const ended = prior.find((r) => r.type === "apply_terminal");
		if (ended !== undefined) {
			console.error(`apply-patch: this patch was already adopted (${String(ended.outcome)}); nothing was done`);
			return 5;
		}
		console.error(interruptedReport(prior));
		return 1;
	}
	if (!patch.applyable && !allowPartial) {
		console.error("apply-patch: the child was stopped, so this patch is partial; adopt it only with --allow-partial");
		return 5;
	}
	let root: string;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		console.error("apply-patch: run it inside the workspace's git repository");
		return 5;
	}
	const unsupported = unsupportedOf(patch, root);
	if (unsupported.length > 0) {
		console.error(`apply-patch: not adopted — this release adopts regular files only:\n${unsupported.map((u) => `  ${u}`).join("\n")}\nIntegrate it by hand, or delegate again.`);
		return 5;
	}

	// ── PREPARE: nothing in the workspace changes ──────────────────────────
	const planned: Planned[] = [];
	const conflicts: string[] = [];
	const scratch = mkdtempSync(join(tmpdir(), "kiso-apply-"));
	try {
		patch.files.forEach((f, n) => {
			const target = join(root, f.path);
			const ours = readOrNull(target);
			const expected = ours === null ? ABSENT : sha(ours);
			const base = f.status === "A" ? null : readFileSync(join(taskDir, "versions", `${n}.base`));
			const theirs = f.status === "D" ? null : readFileSync(join(taskDir, "versions", `${n}.child`));
			const exec = f.mode === "100755";
			if (f.status === "A") {
				if (ours === null) planned.push({ path: f.path, action: "create", expected, content: theirs!, exec });
				else if (!ours.equals(theirs!)) conflicts.push(`${f.path}: created by the child, and it exists in the workspace with other content`);
				return;
			}
			if (f.status === "D") {
				if (ours === null) return; // already gone
				if (ours.equals(base!)) planned.push({ path: f.path, action: "delete", expected });
				else conflicts.push(`${f.path}: deleted by the child, and changed in the workspace since`);
				return;
			}
			// a modification
			if (ours === null) {
				conflicts.push(`${f.path}: changed by the child, and deleted in the workspace since`);
				return;
			}
			if (ours.equals(base!)) planned.push({ path: f.path, action: "modify", expected, content: theirs! });
			else if (ours.equals(theirs!)) return; // the workspace already has it
			else {
				const merged = mergeThree(scratch, ours, base!, theirs!);
				if (merged.conflicts === 0) planned.push({ path: f.path, action: "modify", expected, content: merged.content });
				else if (withMarkers) planned.push({ path: f.path, action: "modify", expected, content: merged.content });
				else conflicts.push(`${f.path}: ${merged.conflicts} conflicting ${merged.conflicts === 1 ? "hunk" : "hunks"}\n${hunks(merged.content)}`);
			}
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	if (conflicts.length > 0) {
		console.error(`apply-patch: nothing was written — the patch conflicts with the workspace:\n${conflicts.map((c) => `  ${c}`).join("\n")}\nResolve by hand, apply with --with-markers and fix the markers with edit_file, or delegate again on the current tree.`);
		return 3;
	}

	// test-only: KISO_TEST_APPLY_HOOK names a module whose afterPrepare() /
	// afterPublish(path) run between the steps — the races a gate needs on cue
	const hook = process.env.KISO_TEST_APPLY_HOOK === undefined ? undefined : ((await import(process.env.KISO_TEST_APPLY_HOOK)) as { afterPrepare?: () => void; afterPublish?: (path: string) => void });
	hook?.afterPrepare?.();

	// ── PUBLISH: per file, revalidated, journaled ───────────────────────────
	const record = (r: Record<string, unknown>): void => appendFileSync(journal, `${JSON.stringify({ ...r, ts: Date.now() })}\n`);
	record({ type: "apply_planned", patchSha256: sha(readFileSync(join(taskDir, "patch.diff"))), files: planned.map((p) => ({ path: p.path, action: p.action, expected: p.expected })) });
	const published: string[] = [];
	for (const p of planned) {
		const target = join(root, p.path);
		const why = publish(target, p);
		if (why !== null) {
			record({ type: "apply_terminal", outcome: "partial", published, stoppedAt: p.path, reason: why });
			const rest = planned.map((q) => q.path).filter((q) => !published.includes(q));
			console.error(`apply-patch: PARTIAL — ${p.path}: ${why}\n  published: ${published.length > 0 ? published.join(", ") : "none"}\n  not published: ${rest.join(", ")}\nNothing is retried or rolled back; read the files and decide.`);
			return 4;
		}
		published.push(p.path);
		record({ type: "apply_file_published", path: p.path, action: p.action });
		hook?.afterPublish?.(p.path);
	}
	record({ type: "publication_complete", files: published.length });
	console.log(`apply-patch: adopted ${published.length} ${published.length === 1 ? "file" : "files"}: ${published.join(", ") || "(the workspace already had every change)"}`);

	// ── VERIFY: the acceptance again, in the workspace ──────────────────────
	const child = readOrNull(join(taskDir, "acceptance.json"));
	const childVerdict = child === null ? "none" : (JSON.parse(child.toString("utf8")) as { passed?: boolean }).passed === true ? "PASSED" : "FAILED";
	if (patch.acceptance === undefined) {
		record({ type: "apply_terminal", outcome: "clean" });
		console.log(`child acceptance: ${childVerdict} · workspace acceptance: none named — the merge was textual only`);
		return 0;
	}
	const resolved = await resolveAcceptance(patch.acceptance, root);
	if (typeof resolved === "string") {
		record({ type: "apply_terminal", outcome: "clean", acceptance: "unresolved", reason: resolved });
		console.log(`child acceptance: ${childVerdict} · workspace acceptance: not run — ${resolved}`);
		return 0;
	}
	record({ type: "acceptance_started", ...resolved.label });
	const v = await runInWorkspace(resolved, root);
	record({ type: "acceptance_result", passed: v.passed, exitCode: v.exitCode });
	record({ type: "apply_terminal", outcome: "clean" });
	console.log(`child acceptance: ${childVerdict} · workspace acceptance: ${v.passed ? "PASSED" : "FAILED"} (exit ${v.exitCode ?? "killed"})${v.passed ? "" : `\n${v.tail}`}`);
	return 0;
}

/** What an interrupted adoption left — the journal's facts, nothing guessed. */
function interruptedReport(records: readonly Record<string, unknown>[]): string {
	const files = records.filter((r) => r.type === "apply_file_published").map((r) => String(r.path));
	const planned = (records.find((r) => r.type === "apply_planned")?.files as { path: string }[] | undefined)?.map((f) => f.path) ?? [];
	if (records.some((r) => r.type === "acceptance_started")) {
		return `apply-patch: an earlier adoption was interrupted — every file was published (${files.join(", ")}); its workspace acceptance started and its outcome is UNKNOWN. Nothing is retried: run the check yourself.`;
	}
	if (records.some((r) => r.type === "publication_complete")) {
		return `apply-patch: an earlier adoption was interrupted — every file was published (${files.join(", ")}); its workspace acceptance was NOT COMPLETED. Nothing is retried: run the check yourself.`;
	}
	const rest = planned.filter((p) => !files.includes(p));
	return `apply-patch: an earlier adoption was interrupted mid-publication — published: ${files.join(", ") || "none"}; not published: ${rest.join(", ") || "none"}. Nothing is retried or rolled back; read the files and decide.`;
}

/** B6.2's scope for 0.49: regular files created, modified or deleted. */
function unsupportedOf(patch: PatchRecord, root: string): string[] {
	const out: string[] = [];
	const lower = new Map<string, string>();
	for (const f of patch.files) {
		const key = f.path.toLowerCase();
		const seen = lower.get(key);
		if (seen !== undefined && seen !== f.path) out.push(`${f.path}: differs from ${seen} only in case`);
		lower.set(key, f.path);
		if (!["A", "M", "D"].includes(f.status)) out.push(`${f.path}: a type change (${f.status})`);
		if ([f.mode, f.baseMode].some((m) => m === "120000")) out.push(`${f.path}: a symlink`);
		if ([f.mode, f.baseMode].some((m) => m === "160000")) out.push(`${f.path}: a submodule`);
		if (f.status === "M" && f.mode !== f.baseMode) out.push(`${f.path}: a mode change (${f.baseMode} → ${f.mode})`);
		const target = join(root, f.path);
		try {
			if (lstatSync(target).isDirectory()) out.push(`${f.path}: a directory in the workspace`);
		} catch {
			// absent — a creation, or already deleted
		}
		if (f.status === "A") {
			// a new name whose case-folded twin already exists (macOS, Windows)
			try {
				const twin = readdirSync(dirname(target)).find((e) => e.toLowerCase() === basename(target).toLowerCase() && e !== basename(target));
				if (twin !== undefined) out.push(`${f.path}: the workspace has ${twin}, differing only in case`);
			} catch {
				// the directory does not exist yet
			}
		}
	}
	return out;
}

/** git merge-file's algorithm on scratch copies — the index never read. */
function mergeThree(scratch: string, ours: Buffer, base: Buffer, theirs: Buffer): { content: Buffer; conflicts: number } {
	const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(scratch, n));
	writeFileSync(o!, ours);
	writeFileSync(b!, base);
	writeFileSync(t!, theirs);
	const r = spawnSync("git", ["merge-file", "-p", "-L", "workspace", "-L", "base", "-L", "child", o!, b!, t!], { maxBuffer: 256 * 1024 * 1024 });
	if (r.status === null || r.status < 0) throw new Error(`git merge-file failed: ${String(r.stderr)}`);
	return { content: r.stdout, conflicts: r.status };
}

/** The conflicting hunks of a merged text, to name them. */
function hunks(merged: Buffer): string {
	const lines = merged.toString("utf8").split("\n");
	const out: string[] = [];
	let inside = false;
	for (const l of lines) {
		if (l.startsWith("<<<<<<< ")) inside = true;
		if (inside) out.push(`    ${l}`);
		if (l.startsWith(">>>>>>> ")) inside = false;
		if (out.length > 60) {
			out.push("    …");
			break;
		}
	}
	return out.join("\n");
}

/** One file, revalidated against PREPARE; null when published. */
function publish(target: string, p: Planned): string | null {
	const now = (): string => {
		const b = readOrNull(target);
		return b === null ? ABSENT : sha(b);
	};
	if (now() !== p.expected) return "it changed after the merge was prepared";
	if (p.action === "delete") {
		unlinkSync(target);
		return null;
	}
	mkdirSync(dirname(target), { recursive: true });
	const tmp = join(dirname(target), `.${basename(target)}.kiso-apply-${process.pid}`);
	writeFileSync(tmp, p.content!);
	if (p.action === "create") {
		chmodSync(tmp, p.exec === true ? 0o755 : 0o644);
		// WR-1A ②: link(2) or refusal — no-clobber, fail closed
		try {
			linkSync(tmp, target);
			return null;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "EEXIST" ? "it was created in the workspace after the merge was prepared" : `it could not be created atomically (${(err as NodeJS.ErrnoException).code ?? "link failed"})`;
		} finally {
			rmSync(tmp, { force: true });
		}
	}
	chmodSync(tmp, statSync(target).mode & 0o7777);
	// WR-1A ③: still what the merge was prepared against, right before the rename
	if (now() !== p.expected) {
		rmSync(tmp, { force: true });
		return "it changed while the adoption was writing";
	}
	renameSync(tmp, target);
	return null;
}

/** The acceptance by its NAME, from the configuration (a trusted project's
 *  too, never asked here) — or why it cannot run. */
async function resolveAcceptance(acceptance: NonNullable<PatchRecord["acceptance"]>, root: string): Promise<{ command: string; args: readonly string[]; label: Record<string, string> } | string> {
	const user = loadUserConfig();
	let project = null;
	if (resolveProjectTrustPolicy(user ?? {}) !== "never") {
		const artifacts = await projectArtifacts(root);
		if (artifacts !== null && trustFor(artifacts.root, artifacts.digest)?.decision === "granted") project = loadProjectConfig(root, true);
	}
	const merged = mergeConfigs(user, project);
	if (acceptance.check !== undefined) {
		const command = merged.checks?.[acceptance.check];
		if (command === undefined) return `the check "${acceptance.check}" is no longer configured`;
		return { command: process.platform === "win32" ? "bash" : "/bin/sh", args: ["-c", command], label: { check: acceptance.check } };
	}
	if (acceptance.evaluator !== undefined) {
		if (!(merged.evaluators ?? []).includes(acceptance.evaluator)) return `the evaluator ${acceptance.evaluator} is no longer listed`;
		return { command: acceptance.evaluator, args: [root], label: { evaluator: acceptance.evaluator } };
	}
	return "the patch names no acceptance";
}

/** The check in the workspace — no git state touched, its tail kept. */
function runInWorkspace(r: { command: string; args: readonly string[] }, root: string): Promise<{ passed: boolean; exitCode: number | null; tail: string }> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(r.command, [...r.args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		const keep = (d: Buffer): void => {
			out = (out + d.toString("utf8")).slice(-2_048);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("error", (err) => resolve({ passed: false, exitCode: null, tail: err.message }));
		child.on("exit", (code) => resolve({ passed: code === 0, exitCode: code, tail: out }));
	});
}

function readOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

function readJournal(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

function git(cwd: string, args: readonly string[]): string {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout;
}
