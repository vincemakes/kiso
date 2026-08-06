/**
 * E1 — extension approval policies: pure types, no runtime.
 *
 * An extension is a named bundle of optional capabilities: hooks (composed
 * AFTER the harness's own — the existing come first), tools (merged into the registry), and
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
 * `deny` carries the reason the model sees; `allow` auto-approves;
 * `abstain` is NO opinion — the policy does not speak (it neither allows,
 * denies, nor asks), and the chain composes only over the SPEAKING
 * verdicts. An all-abstain chain falls to the ask flow (the human
 * decides; absent a channel, an honest denial) — abstaining is never a
 * silent allow (ADR-0042: `allow` as "no opinion" auto-approved tools no
 * policy meant to approve and misattributed decidedBy to a non-speaker).
 */
export type PolicyVerdict =
	| { readonly action: "allow" }
	| { readonly action: "deny"; readonly reason: string }
	| { readonly action: "ask" }
	| { readonly action: "abstain" };

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
	/**
	 * E2: the extension's compaction config — supplies the loop's microcompact
	 * parameters (threshold + optional keepResults) when the session config
	 * does not set its own microcompact.
	 */
	readonly compaction?: { readonly thresholdTokens?: number; readonly keepResults?: number };
	/**
	 * E2: EXTEND the system prompt — append-only, never replace (a replace
	 * is a footgun; appends guarantee "adding an extension never removes
	 * existing guidance" — the monotonicity family of the approval chain's
	 * deny>ask>allow and the veto short-circuit). The session's own
	 * systemPrompt comes first, then each extension's append in load order,
	 * \n\n-joined.
	 */
	readonly systemPrompt?: { readonly append: string };
	/**
	 * 0.1.26 (MCP lazy connection): an optional LIVE flag — the CLI's banner renders
	 * "name (connecting…)" while it is true. Soft surface: absent = no
	 * marker (the default).
	 */
	readonly connecting?: boolean;
	/**
	 * finding #8 (P1): the extension's shutdown action — the closing of external
	 * resources it holds (child processes, connections). The LOADER is
	 * responsible for calling it.
	 */
	readonly dispose?: () => Promise<void> | void;
}
