/**
 * E1 — extension approval policies: pure types, no runtime.
 *
 * An extension is a named bundle of optional capabilities: hooks (composed
 * AFTER the harness's own — 既有先行), tools (merged into the registry), and
 * approval policies (the loop's policy chain, decided BEFORE the human
 * flow). This file is types-only: loading and composition live in the
 * runtime package (loadExtensions) and the kernel loop.
 */

import type { HookHost } from "../kernel/hooks.js";
import type { Tool, ToolContext } from "../tools/tool.js";

/** The call a policy decides on — the tool's name and parsed input. */
export interface PolicyCall {
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

/**
 * A policy's verdict. `ask` defers to the existing human approval flow;
 * `deny` carries the reason the model sees; `allow` auto-approves.
 */
export type PolicyVerdict =
	| { readonly action: "allow" }
	| { readonly action: "deny"; readonly reason: string }
	| { readonly action: "ask" };

/** One approval policy — a pure decide function over a tool call. */
export interface ApprovalPolicy {
	readonly decide: (call: PolicyCall, ctx: ToolContext) => PolicyVerdict | Promise<PolicyVerdict>;
}

/**
 * A loaded extension. `name` is unique per installation (the loader rejects
 * duplicates loudly); hooks/tools/approvals are all optional.
 */
export interface KisoExtension {
	readonly name: string;
	readonly hooks?: HookHost;
	readonly tools?: readonly Tool[];
	readonly approvals?: readonly ApprovalPolicy[];
}
