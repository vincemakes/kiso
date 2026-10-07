/**
 * XP-1 — the durable execution profile (the ratified spec §3).
 *
 * ONE product contract: a session must know what will answer its next
 * request after a restart. The profile is a durable session fact OUTSIDE
 * the event log — ADR-0051 §6's OUT class ("session metadata that is not
 * an event"), so no contract amendment is spent on persistence; the §6
 * purity gate extends instead: the correctness derivation never reads it.
 *
 * The sidecar is `<id>.meta.json` (the adjudicated namespaced file — the
 * profile is its first tenant, SX-1's naming joins later), written
 * FAIL-CLOSED: temp → fsync(file) → rename → fsync(parent directory),
 * full replacement per revision. A new session writes revision 1 BEFORE
 * its first durable event; an unreadable sidecar is BLOCKED, never
 * silently treated as absent (the "corrupt = legacy = today's defaults"
 * misclassification is the exact silent rebuild the spec forbids).
 *
 * Never a secret: the profile carries the profile NAME and env-var-shaped
 * references at most — no key, token, or credential material.
 */

import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ToolRegistry } from "@vincemakes/kiso-core";
import type { ReasoningSetting } from "./provider/metadata.js";

export interface ProfileModelRef {
	readonly providerId: string;
	readonly apiId: string;
	readonly modelId: string;
	readonly endpoint?: string;
}

/** One tool of the recorded surface — the INVENTORY itself, not only a
 *  digest: a single hash can say "changed" but never WHAT changed, and
 *  the drift protocol must tell compatible additions from removals and
 *  schema changes. */
export interface ProfileToolRecord {
	readonly name: string;
	readonly schemaHash: string;
	readonly descriptionHash: string;
}

export interface ExecutionProfile {
	/** monotone per session, from 1. */
	readonly revision: number;
	/** ISO time of this revision. */
	readonly at: string;
	/** the RESOLVED model id — recorded even for unscoped bindings: the
	 *  session must know what answers its next request either way. */
	readonly modelId: string;
	/** null = an unscoped binding (SDK-injected adapter). */
	readonly provider: ProfileModelRef | null;
	/** the config profile NAME — the credential reference is at most the
	 *  env-var name the config carries; never the secret. */
	readonly profileName: string | null;
	/** 0.40.0: the realpath of the root the session STARTED in — history,
	 *  not configuration. Set at revision 1 and carried by every later
	 *  revision; null when the start is unknown (a legacy session's first
	 *  revision, or a sidecar written before the field existed). */
	readonly workspace: string | null;
	readonly reasoning: ReasoningSetting;
	readonly systemPromptDigest: string;
	/** sorted by name; the digest below is DERIVED from this inventory. */
	readonly tools: readonly ProfileToolRecord[];
	readonly toolManifestDigest: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function toolInventory(registry: ToolRegistry): readonly ProfileToolRecord[] {
	return registry
		.toSpecs()
		.map((spec) => ({
			name: spec.name,
			schemaHash: sha(JSON.stringify(spec.inputSchema ?? null)),
			descriptionHash: sha(spec.description ?? ""),
		}))
		.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function buildProfile(input: {
	readonly revision: number;
	readonly modelId: string;
	readonly provider: ProfileModelRef | null;
	readonly profileName?: string | null;
	/** An INPUT, never derived here: revision 1 passes the starting root,
	 *  every later writer passes the prior revision's value. */
	readonly workspace?: string | null;
	readonly reasoning?: ReasoningSetting;
	readonly systemPrompt?: string;
	readonly registry: ToolRegistry;
}): ExecutionProfile {
	const tools = toolInventory(input.registry);
	return {
		revision: input.revision,
		at: new Date().toISOString(),
		modelId: input.modelId,
		provider: input.provider,
		profileName: input.profileName ?? null,
		workspace: input.workspace ?? null,
		reasoning: input.reasoning ?? { thinking: "default", effort: "default" },
		systemPromptDigest: sha(input.systemPrompt ?? ""),
		tools,
		toolManifestDigest: sha(JSON.stringify(tools)),
	};
}

export function profilePath(root: string, sessionId: string): string {
	return join(root, `${sessionId}.meta.json`);
}

/** The sidecar's tenants as they are on disk NOW — the writer of one
 *  tenant carries the other's bytes through untouched. An unreadable file
 *  yields {}: the writer that follows replaces it (the profile path's own
 *  fail-closed read is readProfile, which a writer never bypasses). */
function currentTenants(root: string, sessionId: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(profilePath(root, sessionId), "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Atomic, fail-closed write: a reader sees the previous revision or the
 *  new one, never a torn file — and the RENAME itself is made durable by
 *  the parent-directory fsync. 0.40.0 dogfood: the file holds two tenants
 *  (`profile`, `summary`); writing one preserves the other. */
export function writeProfile(root: string, sessionId: string, profile: ExecutionProfile): void {
	writeTenants(root, sessionId, { ...currentTenants(root, sessionId), profile });
}

/** The 0.40.0 dogfood's `summary` tenant — what the session list reads
 *  instead of the log. Preserves the `profile` tenant byte for byte. */
export function writeSummary(root: string, sessionId: string, summary: import("./session-summary.js").SessionSummary): void {
	writeTenants(root, sessionId, { ...currentTenants(root, sessionId), summary });
}

/** The summary tenant, or null (no sidecar, no summary, or unreadable). */
export function readSummary(root: string, sessionId: string): import("./session-summary.js").SessionSummary | null {
	const t = currentTenants(root, sessionId).summary as Record<string, unknown> | undefined;
	return t !== undefined && typeof t.updatedAt === "number" ? (t as unknown as import("./session-summary.js").SessionSummary) : null;
}

/** Graphite R3d — the name the person gave the session (`/name`): the
 *  sidecar's third tenant, beside `profile` and `summary`, carried
 *  through their writes untouched as they are through its. Session
 *  metadata, not an event (ADR-0051 §6's OUT class, the profile's own
 *  footing): the derivation never reads it; the lists and the title do,
 *  the derived title (`sessionTitle`) the fallback. Null when unnamed or
 *  unreadable. */
export function readSessionName(root: string, sessionId: string): string | null {
	const n = currentTenants(root, sessionId).name;
	return typeof n === "string" && n.trim() !== "" ? n : null;
}

/** Name the session, or clear its name (`null`). Atomic and fail-closed
 *  like every tenant's write; the others' bytes ride through. */
export function writeSessionName(root: string, sessionId: string, name: string | null): void {
	const tenants = { ...currentTenants(root, sessionId) };
	delete tenants.name;
	writeTenants(root, sessionId, name === null ? tenants : { ...tenants, name });
}

function writeTenants(root: string, sessionId: string, tenants: Record<string, unknown>): void {
	const path = profilePath(root, sessionId);
	const tmpDir = mkdtempSync(join(root, ".meta-"));
	const tmp = join(tmpDir, "meta.json");
	try {
		// DF-0322-F1: 0600 on the file kiso CREATES. The mode rides the temp
		// because rename preserves it, and rename is the only path by which
		// this file comes into existence. Existing files are not migrated —
		// R6's choice, kept.
		writeFileSync(tmp, `${JSON.stringify(tenants, null, "\t")}\n`, { mode: 0o600 });
		// Windows: only a write-capable handle can be flushed, and no
		// directory opens as a file — the rename is not flushed there (a
		// process crash loses nothing; the power-loss contract is P6's)
		const windows = process.platform === "win32";
		const fd = openSync(tmp, windows ? "r+" : "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
		if (!windows) {
			const dirFd = openSync(dirname(path), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

export type ProfileReadResult =
	| { readonly kind: "ok"; readonly profile: ExecutionProfile }
	| { readonly kind: "absent" }
	| { readonly kind: "corrupt"; readonly error: string };

export function readProfile(root: string, sessionId: string): ProfileReadResult {
	const path = profilePath(root, sessionId);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return { kind: "absent" };
		return { kind: "corrupt", error: String((err as Error).message ?? err) };
	}
	try {
		const parsed = JSON.parse(raw) as { profile?: ExecutionProfile };
		// 0.40.0 dogfood: a sidecar that holds ONLY the summary tenant (a legacy
		// session the list summarised) has no profile — absent, never corrupt:
		// "corrupt" BLOCKS the session from opening, and nothing is wrong
		if (parsed !== null && typeof parsed === "object" && !("profile" in parsed)) return { kind: "absent" };
		const p = parsed.profile;
		if (
			p === undefined ||
			typeof p.revision !== "number" ||
			typeof p.at !== "string" ||
			typeof p.modelId !== "string" ||
			typeof p.systemPromptDigest !== "string" ||
			typeof p.toolManifestDigest !== "string" ||
			!Array.isArray(p.tools)
		) {
			return { kind: "corrupt", error: "the profile tenant is missing or malformed" };
		}
		// 0.40.0: a sidecar written before `workspace` existed (and one whose
		// `profileName` no writer ever filled) reads as null — unknown, never
		// a guess. The reader stays open: no new key is required.
		return {
			kind: "ok",
			profile: { ...p, profileName: typeof p.profileName === "string" ? p.profileName : null, workspace: typeof p.workspace === "string" ? p.workspace : null },
		};
	} catch (err) {
		return { kind: "corrupt", error: String((err as Error).message ?? err) };
	}
}

export type ProfileDrift =
	| { readonly kind: "clean" }
	/** the tool surface or the composed prompt moved — NAMED and surfaced
	 *  (never presented as restored), but composition is per-process BY
	 *  ARCHITECTURE here (extensions, modes, the E5-ratified task flip,
	 *  subagent roles), so it never refuses an open. */
	| { readonly kind: "surface-changed"; readonly notes: readonly string[] }
	/** new tools only — every recorded tool present and identical. */
	| { readonly kind: "compatible-additions"; readonly added: readonly string[] }
	/** WHO ANSWERS changed — NAMED, and recorded as the next revision under
	 *  the CURRENT configuration. Owner-ruled 2026-09-21: a changed binding
	 *  never blocks a resume — the person may simply have switched models. */
	| { readonly kind: "material"; readonly reasons: readonly string[] };

/** The drift protocol's classifier — computed from the INVENTORY diff,
 *  never from digest inequality alone: every recorded tool present with
 *  identical hashes plus new names = compatible additions (a one-line
 *  notice); a missing name, a changed hash, a provider/model divergence,
 *  or a system-prompt divergence = MATERIAL (the change is NAMED and
 *  recorded as the next revision under the CURRENT configuration — it
 *  blocks nothing; a digest mismatch is never presented as restoration). */
export function assessProfileDrift(
	recorded: ExecutionProfile,
	current: {
		readonly provider: ProfileModelRef | null;
		/** The model THIS process would run — needed because an unscoped binding
		 *  has no provider ref to carry it. */
		readonly modelId: string;
		readonly systemPromptDigest: string;
		readonly tools: readonly ProfileToolRecord[];
	},
): ProfileDrift {
	const reasons: string[] = [];
	const notes: string[] = [];
	const r = recorded.provider;
	const c = current.provider;
	if ((r === null) !== (c === null)) {
		reasons.push(`the recorded binding is ${r === null ? "unscoped" : `${r.providerId}/${r.modelId}`} but the current process serves ${c === null ? "an unscoped adapter" : `${c.providerId}/${c.modelId}`}`);
	} else if (r !== null && c !== null) {
		// WHO ANSWERS is an identity, and `providerId` alone is not one:
		// `custom` names a CLASS — two custom endpoints are two different
		// places to spend — so an endpoint (or API flavour) that moved is a
		// changed binding like any other. Found in review of this round.
		if (r.providerId !== c.providerId) reasons.push(`the recorded provider is ${r.providerId} but the current process serves ${c.providerId}`);
		if (r.apiId !== c.apiId) reasons.push(`the recorded API is ${r.apiId} but the current process serves ${c.apiId}`);
		if ((r.endpoint ?? null) !== (c.endpoint ?? null)) reasons.push(`the recorded endpoint is ${r.endpoint ?? "(none)"} but the current process serves ${c.endpoint ?? "(none)"}`);
	}
	// THE MODEL TOO — the owner's ruling of 2026-09-21, taken on review: the
	// CONFIGURATION wins, including a model switch inside one provider (`--model`
	// and the config are never silently ignored on a resume). This is compared
	// even when BOTH sides are unscoped, where there is no provider ref to carry
	// it, and it covers the ref's own `modelId` as well (the same fact, stamped
	// by the same builder).
	if (r !== null && c !== null && (r.modelId !== c.modelId || recorded.modelId !== current.modelId)) {
		reasons.push(`the recorded model is ${recorded.modelId} but the current process serves ${current.modelId}`);
	} else if (r === null && c === null && recorded.modelId !== current.modelId) {
		reasons.push(`the recorded model is ${recorded.modelId} but the current process serves ${current.modelId} (both bindings are unscoped)`);
	}
	if (recorded.systemPromptDigest !== current.systemPromptDigest) {
		notes.push(`the composed system prompt differs from the recorded one (${recorded.systemPromptDigest.slice(0, 12)}… → ${current.systemPromptDigest.slice(0, 12)}…)`);
	}
	const currentByName = new Map(current.tools.map((t) => [t.name, t]));
	const added: string[] = [];
	for (const t of recorded.tools) {
		const now = currentByName.get(t.name);
		if (now === undefined) {
			notes.push(`the recorded tool "${t.name}" is not loaded in this process`);
		} else if (now.schemaHash !== t.schemaHash) {
			notes.push(`the tool "${t.name}" changed its schema since it was recorded`);
		}
		currentByName.delete(t.name);
	}
	for (const name of currentByName.keys()) added.push(name);
	if (reasons.length > 0) return { kind: "material", reasons };
	if (notes.length > 0) return { kind: "surface-changed", notes };
	if (added.length > 0) return { kind: "compatible-additions", added };
	return { kind: "clean" };
}
