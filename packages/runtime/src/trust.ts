/**
 * E3 — project-level capability is trusted by CONTENT DIGEST, not by
 * directory (ADR-0037). A cloned repo's .kiso runs code on this machine
 * (extensions load into the agent, mcp.json spawns servers, skills inject
 * prompt text), so a trust decision is a decision about THE FILES, and it
 * dies the moment the files change.
 *
 * projectArtifacts(cwd) discovers <cwd>/.kiso/{extensions/*.mjs, mcp.json,
 * skills/<name>/SKILL.md} — the exact three artifact kinds — and returns a
 * manifest (one sha256 per file) plus a BUNDLE digest: sha256 over the
 * sorted relative paths and their contents. Any file change changes the
 * bundle digest, which invalidates every prior trust record.
 *
 * The trust store (~/.kiso/trust.jsonl, KISO_HOME respected) is a simple
 * append-only memo of human verdicts: {root, digest, decision, ts} per
 * line, the LAST record matching (root, digest) wins. Its tolerance is
 * deliberately different from the session store: trust.jsonl is NOT an
 * event stream — a corrupt line means "no record" for that line (skip,
 * never throw), because a lost grant only re-asks the human and a lost
 * refusal also only re-asks; there is no trajectory to preserve.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type TrustDecision = "granted" | "refused";

export interface TrustRecord {
	/** realpath of the trusted .kiso directory — the thing being trusted. */
	readonly root: string;
	/** bundle sha256 of the project's .kiso artifacts at decision time. */
	readonly digest: string;
	readonly decision: TrustDecision;
	/** ISO timestamp of the decision. */
	readonly ts: string;
}

export interface ProjectArtifact {
	/** path relative to the .kiso dir, e.g. "extensions/lint-rules.mjs". */
	readonly path: string;
	readonly kind: "extension" | "mcp" | "skill";
	/** sha256 (hex) of this file's content — the listing shows a short prefix. */
	readonly digest: string;
}

export interface ProjectArtifacts {
	/** realpath of the .kiso directory — the trust record's root. */
	readonly root: string;
	readonly files: readonly ProjectArtifact[];
	/** bundle sha256 (hex) over the sorted paths + contents. */
	readonly digest: string;
}

/**
 * Discover <cwd>/.kiso's artifacts. The skills scan is ONE level
 * (<name>/SKILL.md) — the same scan the skills extension performs, so the
 * digest covers exactly what gets loaded; anything deeper is inert and not
 * part of the trust decision. Returns null when there is no .kiso dir or
 * no recognized artifacts (an empty .kiso has nothing to gate).
 */
export async function projectArtifacts(cwd: string): Promise<ProjectArtifacts | null> {
	const kisoDir = join(cwd, ".kiso");
	try {
		await stat(kisoDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const root = await realpath(kisoDir);

	const entries: { path: string; buf: Buffer }[] = [];
	for (const f of await readdirOrEmpty(join(root, "extensions"))) {
		if (!f.endsWith(".mjs")) continue;
		entries.push({ path: `extensions/${f}`, buf: await readFile(join(root, "extensions", f)) });
	}
	try {
		entries.push({ path: "mcp.json", buf: await readFile(join(root, "mcp.json")) });
	} catch (err) {
		if (!isMissing(err)) throw err;
	}
	for (const dir of await readdirOrEmpty(join(root, "skills"))) {
		try {
			entries.push({ path: `skills/${dir}/SKILL.md`, buf: await readFile(join(root, "skills", dir, "SKILL.md")) });
		} catch (err) {
			if (!isMissing(err)) throw err; // a file named like a dir → ENOTDIR: inert, skip
		}
	}
	if (entries.length === 0) return null;

	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const files = entries.map((e) => ({ path: e.path, kind: kindOf(e.path), digest: sha256(e.buf) }));
	return { root, files, digest: bundleDigest(entries) };
}

function bundleDigest(entries: readonly { path: string; buf: Buffer }[]): string {
	const h = createHash("sha256");
	for (const e of entries) {
		h.update(e.path);
		h.update("\n");
		h.update(e.buf);
		h.update("\0");
	}
	return h.digest("hex");
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function kindOf(path: string): ProjectArtifact["kind"] {
	if (path.startsWith("extensions/")) return "extension";
	if (path === "mcp.json") return "mcp";
	return "skill";
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (err) {
		if (isMissing(err)) return [];
		throw err;
	}
}

function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR";
}

function trustFile(): string {
	return join(process.env.KISO_HOME ?? join(homedir(), ".kiso"), "trust.jsonl");
}

/**
 * The last record matching (root, digest) — append-only, last wins. A
 * corrupt line is skipped (trust is a memo, not an event stream — see the
 * module comment). Callers pass the realpath'd root from projectArtifacts.
 */
export function trustFor(root: string, digest: string): TrustRecord | null {
	let text: string;
	try {
		text = readFileSync(trustFile(), "utf8");
	} catch {
		return null; // no trust file = no records
	}
	let found: TrustRecord | null = null;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			continue; // corrupt line = no record
		}
		if (!isTrustRecord(rec)) continue;
		if (rec.root === root && rec.digest === digest) found = rec;
	}
	return found;
}

/** Append one verdict. The same (root, digest) may be re-recorded — the
 *  newest record wins on read. */
export function recordTrust(record: { root: string; digest: string; decision: TrustDecision; ts?: string }): void {
	const home = process.env.KISO_HOME ?? join(homedir(), ".kiso");
	mkdirSync(home, { recursive: true });
	appendFileSync(
		join(home, "trust.jsonl"),
		`${JSON.stringify({ root: record.root, digest: record.digest, decision: record.decision, ts: record.ts ?? new Date().toISOString() })}\n`,
		"utf8",
	);
}

function isTrustRecord(v: unknown): v is TrustRecord {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Partial<TrustRecord>;
	return typeof r.root === "string" && typeof r.digest === "string" && (r.decision === "granted" || r.decision === "refused") && typeof r.ts === "string";
}
