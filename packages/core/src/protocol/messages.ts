/**
 * L1 — the message types.
 *
 * This is the conversation history the kernel hands to `adapter.stream()`.
 * A `Message` is tagged by role; `ToolSpec` is the minimal projection an
 * adapter advertises to the model.
 *
 * WHY the content of a user/tool message is `string | ContentBlock[]`:
 * the string form is the common case and stays cheap, while the array form
 * carries images. Forcing every caller into the array shape to serve the
 * 5% that need vision is a tax paid on every line of product code.
 *
 * See ADR-0003 (sum type) and ADR-0008 (tool contract).
 *
 * This module is types-only: it compiles to nothing.
 */

export type Role = "user" | "assistant" | "tool";

/** A text segment. Equivalent to plain `string` content, but interleavable. */
export interface TextContentBlock {
	readonly type: "text";
	readonly text: string;
}

/**
 * An image input.
 *
 * - `sourceType: "url"`    — the PROVIDER fetches it. atto never downloads.
 * - `sourceType: "base64"` — `data` holds raw base64 with no `data:` prefix;
 *                            `mediaType` is then required.
 *
 * Exactly one of `url` / `data` must be set for the declared `sourceType`.
 * Adapters do NOT re-validate this — a mismatch surfaces as a provider 400.
 * That is deliberate: a second validation layer that disagrees with the
 * provider's is worse than none.
 */
export interface ImageContentBlock {
	readonly type: "image";
	readonly sourceType: "url" | "base64";
	readonly url?: string;
	readonly data?: string;
	readonly mediaType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * Provenance — where a message actually came from.
 *
 * The model treats this as evidence about intent; a "user" line that the UI
 * recycled from a suggestion chip is NOT user intent, and a model that cannot
 * tell the difference drifts on its own recycled wording (Claude Code
 * #60087). The kernel preserves the label; product code decides how to render
 * it. Defaults (when absent): role `user` → "user", role `assistant` →
 * "model", role `tool` → "tool_result".
 */
export type MessageSource =
	| "user"
	| "suggestion"
	| "tool_result"
	| "subagent"
	| "system"
	| "model";

export interface UserMessage {
	readonly role: "user";
	readonly content: string | readonly ContentBlock[];
	readonly source?: MessageSource;
}

export interface AssistantTextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface AssistantToolUseBlock {
	readonly type: "tool_use";
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export type AssistantBlock = AssistantTextBlock | AssistantToolUseBlock;

export interface AssistantMessage {
	readonly role: "assistant";
	readonly blocks: readonly AssistantBlock[];
	readonly source?: MessageSource;
}

/**
 * Sent back to the model after a tool ran.
 *
 * `tags` are product-defined labels that the kernel honors but never defines.
 * The canonical use is marking a result as do-not-compact (a safety notice, a
 * billing receipt, a trace anchor). kiso prescribes no vocabulary: the kernel
 * matches tags it was configured with and ignores the rest.
 */
export interface ToolResultMessage {
	readonly role: "tool";
	readonly callId: string;
	readonly content: string | readonly ContentBlock[];
	readonly isError: boolean;
	readonly source?: MessageSource;
	readonly tags?: readonly string[];
	/**
	 * The seq of the `tool_result` EVENT this message was projected from —
	 * the stable identity compaction uses to name WHICH result it replaced
	 * (五: the callId may repeat across runs). DERIVED, never persisted: the
	 * projection attaches it as a non-enumerable field, so it is invisible
	 * to deep equality with seed messages and never survives a re-derive
	 * from anywhere but the log.
	 */
	readonly eventSeq?: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * What the adapter advertises to the model.
 *
 * Deliberately minimal: the full tool (handler, repair, concurrency, dedup)
 * is L3-internal and an adapter must never see it. An adapter that can reach
 * the handler will eventually call it, and then the kernel is no longer the
 * only thing that runs tools.
 */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}
