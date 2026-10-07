/**
 * 0.40.0 — writes into `.git/**` and `.kiso/**` always ask (lead's ruling on
 * the read-only shell plan, 2026-09-18).
 *
 * Both directories hold configuration that RUNS. git executes commands its
 * repository config names — `core.fsmonitor` on `git status`,
 * `diff.external` and textconv on `git diff` — and a project's `.kiso/`
 * holds extensions and config. Under accept-edits a model could write
 * either unasked, and with the read-only shell allow a following
 * `git status` would run what it wrote without a person seeing any of it.
 *
 * So a write_file or edit_file whose path — as written, or once symlinks
 * are followed — passes through a `.git` or `.kiso` directory asks in
 * every asking tier: accept-edits' allow does not cover it, and neither
 * does a saved allow. With the don't-ask switch on it is therefore denied;
 * plan denies it anyway; full-access runs it, as full-access's shell could.
 */

import { relative, sep } from "node:path";
import type { PolicyCall, PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { resolveShellPath } from "./shell-words.js";
import { isDestructiveCall } from "./floor.js";
import { isRemoteBoundaryCall } from "./remote-boundary.js";

const PROTECTED = new Set([".git", ".kiso"]);
const WRITERS = new Set(["write_file", "edit_file"]);

export function isProtectedWrite(call: PolicyCall, workspaceRoot: string): boolean {
	if (!WRITERS.has(call.name)) return false;
	const path = call.input.path;
	if (typeof path !== "string") return false;
	// case folded: on a case-insensitive disk `.GIT/config` IS .git/config
	if (path.split(/[\\/]/).some((seg) => PROTECTED.has(seg.toLowerCase()))) return true;
	const { canonical } = resolveShellPath(workspaceRoot, workspaceRoot, path);
	return relative(resolveShellPath(workspaceRoot, workspaceRoot, ".").canonical, canonical)
		.split(sep)
		.some((seg) => PROTECTED.has(seg.toLowerCase()));
}

const ABSTAIN: PolicyVerdict = { action: "abstain" };

/**
 * The calls a saved allow never carries — they reach a person every time
 * in the asking tiers: a write into .git/ or .kiso/, a destructive
 * command (floor.ts, which also answers yes for a line it cannot read),
 * and a command across the remote boundary (remote-boundary.ts, 0.46.2).
 * create-coding-agent.ts wires it into every guarded saved allow.
 */
export function neverInheritedCall(call: PolicyCall, workspaceRoot: string): boolean {
	return isProtectedWrite(call, workspaceRoot) || isDestructiveCall(call) || isRemoteBoundaryCall(call);
}

/**
 * A saved allow ("yes, don't ask again for <tool>") allows by TOOL, so on
 * its own it would carry every later call of that tool — including the
 * ones kiso has decided must always reach a person. Wrapped wherever it
 * enters the chain, it ABSTAINS for those, and the tier's ask stands.
 * Everything else it decided, it still decides; its live `rules` handle
 * (the grant path mutates it) is the same object.
 */
export function guardSavedAllow(ext: KisoExtension, neverInherited: (call: PolicyCall) => boolean): KisoExtension {
	if (ext.name !== "dont-ask-again" || ext.approvals === undefined) return ext;
	return {
		...ext,
		approvals: ext.approvals.map((p) => ({
			decide: (call, ctx) => (neverInherited(call) ? ABSTAIN : p.decide(call, ctx)),
		})),
	};
}
