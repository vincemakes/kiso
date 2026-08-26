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
	readonly profileName?: string;
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
		reasoning: input.reasoning ?? { thinking: "default", effort: "default" },
		systemPromptDigest: sha(input.systemPrompt ?? ""),
		tools,
		toolManifestDigest: sha(JSON.stringify(tools)),
	};
}

export function profilePath(root: string, sessionId: string): string {
	return join(root, `${sessionId}.meta.json`);
}

/** Atomic, fail-closed write: a reader sees the previous revision or the
 *  new one, never a torn file — and the RENAME itself is made durable by
 *  the parent-directory fsync. */
export function writeProfile(root: string, sessionId: string, profile: ExecutionProfile): void {
	const path = profilePath(root, sessionId);
	const tmpDir = mkdtempSync(join(root, ".meta-"));
	const tmp = join(tmpDir, "meta.json");
	try {
		writeFileSync(tmp, `${JSON.stringify({ profile }, null, "\t")}\n`);
		const fd = openSync(tmp, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
		const dirFd = openSync(dirname(path), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
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
		return { kind: "ok", profile: p };
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
	/** WHO ANSWERS changed — the one class that blocks without an
	 *  explicit acknowledgement. */
	| { readonly kind: "material"; readonly reasons: readonly string[] };

/** The drift protocol's classifier — computed from the INVENTORY diff,
 *  never from digest inequality alone: every recorded tool present with
 *  identical hashes plus new names = compatible additions (a one-line
 *  notice); a missing name, a changed hash, a provider/model divergence,
 *  or a system-prompt divergence = MATERIAL (explicit resolution; a
 *  digest mismatch is never presented as restoration). */
export function assessProfileDrift(
	recorded: ExecutionProfile,
	current: { readonly provider: ProfileModelRef | null; readonly systemPromptDigest: string; readonly tools: readonly ProfileToolRecord[] },
): ProfileDrift {
	const reasons: string[] = [];
	const notes: string[] = [];
	const r = recorded.provider;
	const c = current.provider;
	if ((r === null) !== (c === null)) {
		reasons.push(`the recorded binding is ${r === null ? "unscoped" : `${r.providerId}/${r.modelId}`} but the current process serves ${c === null ? "an unscoped adapter" : `${c.providerId}/${c.modelId}`}`);
	} else if (r !== null && c !== null && r.providerId !== c.providerId) {
		reasons.push(`the recorded provider is ${r.providerId} but the current process serves ${c.providerId}`);
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
