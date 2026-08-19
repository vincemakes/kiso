/**
 * WR-1 — the observed-revision stale-write guard's primitives, extracted
 * so the classification rules are unit-testable (WR-1A).
 *
 * The revision is a CONTENT-STATE WITNESS, never an epistemic proof: it
 * answers "has this file changed since the citation was issued", not
 * "did the model read this exact file" (no path binding — two files
 * with identical bytes share a token, harmlessly: the current bytes ARE
 * the cited state). The guard is against accidents, not adversaries.
 */

import { createHash } from "node:crypto";
import { linkSync, readFileSync, unlinkSync } from "node:fs";
import type { ToolResult } from "@vincemakes/kiso-core";

/** sha256 over RAW bytes (never the decoded string — UTF-8 replacement
 *  semantics would lie about the world), truncated to a 64-bit citation
 *  token. Truncation loses nothing the full digest would keep here: a
 *  non-cooperating writer wins the conditional-write window without
 *  ever touching the hash. */
export function contentRevision(bytes: Buffer): string {
	return `rev:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

/** The stale-write refusal: work refused BEFORE it starts — exactly what
 *  the `precondition` kind exists to say (and the reason the kernel's
 *  partial-effects note never rides one). */
export function precondition(content: string): ToolResult {
	return { content, isError: true, errorKind: "precondition" };
}

/**
 * WR-1A ①: a POST-EFFECT verification failure is FATAL — the rename
 * already happened, so `precondition` ("nothing ran") would make the
 * durable receipt lie about the world. The copy says the effect may
 * already have applied, and the kernel's non-idempotent note rides it.
 */
export function postEffectEscape(action: "write" | "edit", path: string): ToolResult {
	return {
		content: `${action}_file failed: ${path} escaped the workspace after replacement — the ${action} may already have applied`,
		isError: true,
		errorKind: "fatal",
	};
}

/**
 * WR-1A ②: the CREATION publish — link(2) or refusal, never a fallback.
 * link is atomic no-clobber: target absent → the entry appears; target
 * present → EEXIST, the loser is told LOUDLY. Any other failure refuses
 * too (fail closed): a platform that cannot give the atomic primitive
 * does not get to degrade "absent" into a clobber-capable rename — a
 * semantic guarantee that is unavailable is an honest refusal, never a
 * silent downgrade. Returns null on success; the temp is consumed
 * (linked then unlinked) or cleaned on every failure path.
 */
export function publishNewFile(tmp: string, full: string, path: string): ToolResult | null {
	try {
		linkSync(tmp, full);
		unlinkSync(tmp);
		return null;
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// already gone
		}
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return precondition(`write_file: ${path} already exists — read it and pass its revision to replace it`);
		}
		return precondition(`write_file: cannot publish ${path} atomically on this filesystem (${(err as NodeJS.ErrnoException).code ?? "link failed"}) — the no-clobber creation guarantee cannot be honored here`);
	}
}

/**
 * WR-1A ③: the immediate pre-rename revalidation — after staging, right
 * before the replacement commits, the target must STILL hash to the
 * cited revision. This shrinks the conditional-write window from
 * validate→stage→chmod→rename to check→rename (POSIX offers no
 * rename-if-content-equals, so the residual window is the narrowed
 * claim, stated as such). Returns null when the world still matches.
 */
export function revalidateBeforeRename(full: string, expectedRevision: string, tool: "write_file" | "edit_file", path: string): ToolResult | null {
	let current: string;
	try {
		current = contentRevision(readFileSync(full));
	} catch {
		return precondition(`${tool}: ${path} no longer exists — it changed after validation; read it again`);
	}
	if (current !== expectedRevision) {
		return precondition(`${tool}: ${path} changed since ${expectedRevision} — read it again, then re-apply the change`);
	}
	return null;
}
