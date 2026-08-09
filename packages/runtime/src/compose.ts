/**
 * the ergonomics batch B4 (pure move) — the E1/E2 composition helpers, moved verbatim
 * from session.ts: the extension system-prompt appends, the extension
 * hook composition (the existing come first), and the loop's microcompact config lookup.
 */

import type { HookContext, HookHost, KisoExtension, ToolRegistry } from "@vincemakes/kiso-core";
import type { SessionConfig } from "./session.js";

/**
 * 0.1.40 (R-C item 1) — the tool substitution table: the fixed vocabulary
 * (the CC content in kiso's voice, each line bound to the tool that makes
 * it true) filtered to the ACTIVE tool set + each active tool's ONE-line
 * snippet + its guideline bullets. The full descriptions NEVER enter the
 * system prompt — the provider transmits them in the JSON schema anyway
 * (never pay twice). Deterministic: same registry → same table.
 */
const TOOL_RULES: ReadonlyArray<{ readonly tool: string; readonly line: string }> = [
	{ tool: "read_file", line: "read files with read_file, never shell cat/head/tail" },
	{ tool: "search_text", line: "search with search_text, never shell grep/rg" },
	{ tool: "list_dir", line: "list with list_dir, never ls" },
	{ tool: "shell", line: "reserve shell for real system commands" },
];

/** The table, or "" when the registry is empty (no vocabulary, no tools). */
export function composeToolTable(registry: ToolRegistry): string {
	const tools = registry.list();
	if (tools.length === 0) return "";
	const active = new Set(tools.map((t) => t.name));
	const lines = [
		"Tool use:",
		...TOOL_RULES.filter((r) => active.has(r.tool)).map((r) => `- ${r.line}`),
		// the parallel directive: the window applies to every active turn.
		"- batch independent tool calls into one reply — they run in parallel",
		...tools.flatMap((t) => (t.promptSnippet === undefined ? [] : [`- ${t.promptSnippet}`])),
	];
	const guidelines = tools.flatMap((t) => (t.promptGuidelines ?? []).map((g) => `- ${t.name}: ${g}`));
	if (guidelines.length > 0) lines.push("Active tool guidelines:", ...guidelines);
	return lines.join("\n");
}

/**
 * E2: the session's systemPrompt plus every extension's append, in LOAD
 * order, \n\n-joined — deterministic (same extension list → same prompt).
 * No appends → the base passes through byte-identical.
 */
export function composeSystemPrompt(base: string | undefined, extensions: readonly KisoExtension[]): string | undefined {
	const appends = extensions.flatMap((e) => (e.systemPrompt?.append === undefined ? [] : [e.systemPrompt.append]));
	if (appends.length === 0) return base;
	return base === undefined ? appends.join("\n\n") : `${base}\n\n${appends.join("\n\n")}`;
}

/**
 * E1: extension hooks compose AFTER the agent's own (the existing come first — the existing
 * hook sees every event first). Observers all run, in order; onUserMessage
 * and onPreTool — the FIRST decisive answer wins (the existing hook
 * outranks extensions; defers fall through); onPostTool folds — each
 * transforms the previous result. Returns the existing host unchanged when
 * no extension provides hooks.
 */
export function composeHooks(existing: HookHost | undefined, extensions: readonly KisoExtension[]): HookHost | undefined {
	const extHooks = extensions.flatMap((e) => (e.hooks === undefined ? [] : [e.hooks]));
	if (extHooks.length === 0) return existing;
	const out: HookHost = { ...existing };
	const sources: readonly HookHost[] = existing === undefined ? extHooks : [existing, ...extHooks];
	type Observer = (payload: never, ctx: HookContext) => Promise<void>;
	const observers = (key: (h: HookHost) => Observer | undefined): Observer | undefined => {
		const handlers = sources.map(key).filter((h): h is Observer => h !== undefined);
		if (handlers.length <= 1) return handlers[0];
		return async (payload, ctx) => {
			for (const h of handlers) await h(payload, ctx);
		};
	};
	for (const key of ["onPreLlm", "onEvent", "onPreCompact", "onPostCompact", "onPause", "onStop"] as const) {
		const handler = observers((h) => h[key]);
		if (handler !== undefined) (out as Record<string, unknown>)[key] = handler;
	}
	const messageHandlers = sources
		.map((h) => h.onUserMessage)
		.filter((h): h is NonNullable<HookHost["onUserMessage"]> => h !== undefined);
	if (messageHandlers.length === 1) {
		out.onUserMessage = messageHandlers[0]!; // length 1 guarantees the element
	} else if (messageHandlers.length > 1) {
		// re-review E1-P2: the pipe + veto short-circuit — each handler sees the
		// message as the PREVIOUS one left it (the existing come first), and a null (veto)
		// anywhere ends the chain immediately: never "no opinion" for the
		// next handler to outvote. Adding an extension can therefore never
		// make the chain MORE permissive (the approval chain's deny>ask>allow
		// monotonicity, on the message side).
		out.onUserMessage = async (msg, ctx) => {
			let current = msg;
			for (const h of messageHandlers) {
				const r = await h(current, ctx);
				if (r === null) return null;
				current = r;
			}
			return current;
		};
	}
	const preToolHandlers = sources
		.map((h) => h.onPreTool)
		.filter((h): h is NonNullable<HookHost["onPreTool"]> => h !== undefined);
	if (preToolHandlers.length === 1) {
		out.onPreTool = preToolHandlers[0]!;
	} else if (preToolHandlers.length > 1) {
		out.onPreTool = async (call, ctx) => {
			for (const h of preToolHandlers) {
				const d = await h(call, ctx);
				if (d.action !== "defer") return d;
			}
			return { action: "defer" };
		};
	}
	const postToolHandlers = sources
		.map((h) => h.onPostTool)
		.filter((h): h is NonNullable<HookHost["onPostTool"]> => h !== undefined);
	if (postToolHandlers.length === 1) {
		out.onPostTool = postToolHandlers[0]!;
	} else if (postToolHandlers.length > 1) {
		out.onPostTool = async (call, result, ctx) => {
			let r = result;
			for (const h of postToolHandlers) r = await h(call, r, ctx);
			return r;
		};
	}
	return out;
}

/**
 * E2: the loop's microcompact config — the session's own microcompact wins;
 * otherwise the FIRST extension providing a compaction config supplies it.
 * An extension config without a threshold contributes nothing (a boundary
 * needs a threshold to ever fire).
 */
export function microcompactFor(config: SessionConfig): { readonly thresholdTokens: number; readonly keepResults?: number } | undefined {
	if (config.microcompact !== undefined) return config.microcompact;
	for (const ext of config.extensions ?? []) {
		const c = ext.compaction;
		if (c !== undefined && c.thresholdTokens !== undefined) {
			return { thresholdTokens: c.thresholdTokens, ...(c.keepResults !== undefined ? { keepResults: c.keepResults } : {}) };
		}
	}
	return undefined;
}
