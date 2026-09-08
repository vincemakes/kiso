/**
 * The OpenAI Responses adapter — one adapter, two targets.
 *
 * Plain `fetch` plus a hand-rolled SSE reader: no SDK, no new dependency.
 * The Responses dialect is small enough that a vendor client would buy
 * nothing here and would bring its own retry policy, which this tree
 * refuses (the kernel is the sole retry authority — CX-1 F8).
 *
 * The TARGET is inferred from the options the factory is handed, never
 * from a separate switch that could disagree with them:
 *   { apiKey }  → the first-party Responses API (api.openai.com/v1/responses)
 *   { oauth }   → the ChatGPT subscription backend
 *                 (chatgpt.com/backend-api/codex/responses)
 * The `oauth` thunk is called ONCE PER REQUEST, so a token that expires
 * mid-session is refreshed by whoever owns the credential store — the
 * adapter never caches a token and never refreshes one itself.
 *
 * Design source: the reference implementation's client for this backend
 * (MIT) — base URL resolution, the header set, the `plan_type` /
 * `resets_at` rate-limit wording, and the SSE frame split are reused as
 * DESIGN; no block is copied, and the code here is kiso's.
 *
 * Invariants (the same the two older adapters prove):
 *  - `usage` always precedes the final `stop`;
 *  - no terminal event ⇒ `usage { known:false }` then `stop { reason:"error" }`;
 *  - a tool call's id is captured once and never changes mid-stream;
 *  - exactly ONE fetch per stream — no retry loop lives here;
 *  - every non-2xx becomes `mapApiError(status, message, retryAfterMs)`.
 */

import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import type { AdapterEvent, ContinuationEntry, StopReason } from "@vincemakes/kiso-core";
import type { AssistantBlock, ContentBlock, Message, ToolSpec } from "@vincemakes/kiso-core";
import { mapApiError, parseRetryAfter } from "@vincemakes/kiso-core";

/** The ChatGPT backend's own token, resolved fresh for each request. */
export interface ResponsesOAuthToken {
	readonly access: string;
	readonly accountId: string;
}

export interface OpenAIResponsesProviderConfig {
	/** First-party target: the API key. */
	readonly apiKey?: string;
	/** ChatGPT target: the token thunk, awaited once per request. */
	readonly oauth?: () => Promise<ResponsesOAuthToken>;
	/** Overrides the target's default base URL (tests and proxies). */
	readonly baseUrl?: string;
	/** The ChatGPT backend's prefix-cache key — the session id, so one
	 *  session's requests share a cache lane. Sent only to that target. */
	readonly promptCacheKey?: string;
	/** MG-1 (A5): the adapter's replay identity. The kernel STAMPS a
	 *  turn's continuation with the run's own scope, so the identity this
	 *  adapter matches against on the NEXT turn must be the one the
	 *  runtime resolved — passed in rather than re-derived here, so the
	 *  two sides cannot drift. (They can: an API key configured against
	 *  the ChatGPT origin resolves to "chatgpt" by origin and "openai" by
	 *  target, and the symptom would be reasoning that silently never
	 *  replays.) Absent — a direct SDK consumer — falls back to the
	 *  target's own identity. */
	readonly scope?: OpenAIResponsesScope;
}

/** The provider-identity half of the continuation scope; `apiId` is
 *  constant for this adapter and `modelId` is per-request. */
export interface OpenAIResponsesScope {
	readonly providerId: string;
}

const FIRST_PARTY_BASE = "https://api.openai.com/v1";
const CHATGPT_BASE = "https://chatgpt.com/backend-api";

/**
 * The provider rejects `max_output_tokens` below 16 with a 400. kiso does
 * NOT clamp it: a silently raised cap is a request the caller did not
 * make, and the caller asked for a bound. The refusal happens before the
 * request so the failure names the setting rather than the vendor's 400.
 */
const MIN_OUTPUT_TOKENS = 16;

/** MG-1 (A5): this adapter's continuation entries — one whole reasoning
 *  output item, serialized verbatim. */
const ENTRY_KIND = "openai-responses.item";
const API_ID = "openai-responses";

interface Target {
	/** Which endpoint this is — the label on every error, and the reason a
	 *  401 here names `kiso login chatgpt`. NOT the continuation scope's
	 *  identity: that one is the runtime's (see `scope` above). */
	readonly providerId: "openai" | "chatgpt";
	readonly url: string;
	headers(): Promise<Record<string, string>>;
	/** The body fields only this target accepts. */
	readonly extraBody: Readonly<Record<string, unknown>>;
}

/** `<base>/responses`, tolerating a base that already names the path. */
function firstPartyUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

/** `<base>/codex/responses` — the vendor's own path for this backend,
 *  tolerating a base that already names part of it (the reference
 *  implementation's resolution, kept as design). */
function chatgptUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveTarget(config: OpenAIResponsesProviderConfig): Target {
	const oauth = config.oauth;
	if (oauth !== undefined) {
		return {
			providerId: "chatgpt",
			url: chatgptUrl(config.baseUrl ?? CHATGPT_BASE),
			headers: async () => {
				const token = await oauth();
				return {
					authorization: `Bearer ${token.access}`,
					"chatgpt-account-id": token.accountId,
					originator: "kiso",
					"OpenAI-Beta": "responses=experimental",
				};
			},
			// The backend rejects `store: true`; with nothing stored, the
			// reasoning items have to come back on the next turn, which is
			// what `include` asks for and what the continuation replays.
			extraBody: {
				store: false,
				include: ["reasoning.encrypted_content"],
				...(config.promptCacheKey !== undefined ? { prompt_cache_key: config.promptCacheKey } : {}),
			},
		};
	}
	return {
		providerId: "openai",
		url: firstPartyUrl(config.baseUrl ?? FIRST_PARTY_BASE),
		headers: async () => ({ authorization: `Bearer ${config.apiKey ?? ""}` }),
		extraBody: {},
	};
}

export function createOpenAIResponsesProvider(config: OpenAIResponsesProviderConfig = {}): Adapter {
	const target = resolveTarget(config);
	const scopeProviderId = config.scope?.providerId ?? target.providerId;
	return {
		async *stream(options: StreamOptions): AsyncIterable<AdapterEvent> {
			if (options.maxTokens !== undefined && options.maxTokens < MIN_OUTPUT_TOKENS) {
				throw {
					code: "invalid_request",
					retryable: false,
					message: `[${target.providerId}] maxTokens ${options.maxTokens} is below the Responses API floor of ${MIN_OUTPUT_TOKENS} — raise it; kiso never silently raises a cap you set`,
				};
			}
			const body = buildBody(options, target, scopeProviderId);
			const response = await requestOnce(target, body, options.signal);
			yield* mapStream(response, options, target, scopeProviderId);
		},
	};
}

// ── The request ────────────────────────────────────────────────────────

function buildBody(options: StreamOptions, target: Target, scopeProviderId: string): Record<string, unknown> {
	return {
		model: options.model,
		stream: true,
		// The system prompt is the Responses dialect's `instructions`.
		// Absent means ABSENT — no default assistant prompt is invented.
		...(options.systemPrompt !== undefined ? { instructions: options.systemPrompt } : {}),
		input: toInput(options.messages, options.model, scopeProviderId),
		...(options.tools?.length ? { tools: options.tools.map(toResponsesTool) } : {}),
		// XP-1: the RESOLVED effort. The registry's `wire` string names the
		// dialect parameter for a human reader and never reaches an
		// adapter — the dialect path is this adapter's own knowledge, and
		// the level is transported as handed. Absent adds NO key.
		...(options.reasoning?.effort !== undefined ? { reasoning: { effort: options.reasoning.effort } } : {}),
		...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...target.extraBody,
	};
}

function toResponsesTool(tool: ToolSpec): Record<string, unknown> {
	// No `strict`: the flag changes the PROVIDER's validation semantics,
	// and kiso's schemas are already closed worlds validated by the kernel
	// (PH-1a.1). Sending it would claim a second, disagreeing validator.
	return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

function toInputContent(content: string | readonly ContentBlock[]): Record<string, unknown>[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((block) =>
		block.type === "text"
			? { type: "input_text", text: block.text }
			: {
					type: "input_image",
					detail: "auto",
					// A base64 block becomes a REAL data URL; a URL-sourced
					// block passes the provider URL through.
					image_url:
						block.sourceType === "base64"
							? `data:${block.mediaType ?? "image/png"};base64,${block.data ?? ""}`
							: (block.url ?? ""),
				},
	);
}

/** A tool result is text on this dialect. An image is turned into an
 *  EXPLICIT note saying what was omitted and why — never dropped in
 *  silence (the same honesty the compat adapter keeps). */
function toToolResultOutput(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content
		.map((b) =>
			b.type === "text"
				? b.text
				: `[image omitted — Responses tool results carry text only: ${b.sourceType === "base64" ? `${b.mediaType ?? "image"} (${b.data?.length ?? 0} base64 chars)` : `url ${b.url ?? ""}`}]`,
		)
		.join("");
}

function toOutputItem(block: AssistantBlock): Record<string, unknown> {
	if (block.type === "text") {
		// No `id`: this dialect accepts a replayed assistant message
		// without one, and inventing an item id would be a fabricated
		// provider fact.
		return {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: block.text, annotations: [] }],
			status: "completed",
		};
	}
	// No `id` here either — an item id pairs a function_call with a stored
	// reasoning item, and under `store: false` there is nothing to pair
	// with. `call_id` is the identity the kernel and the provider share.
	return { type: "function_call", call_id: block.callId, name: block.name, arguments: JSON.stringify(block.input) };
}

/** MG-1 (A5): the stored reasoning items replay ONLY to the scope that
 *  produced them — provider AND api AND model. A mismatched or absent
 *  envelope replays nothing; an entry that no longer parses is skipped
 *  rather than killing the request. */
function continuationItems(msg: Message & { role: "assistant" }, model: string, providerId: string): unknown[] {
	const c = msg.continuation;
	if (c === undefined) return [];
	const s = c.scope;
	if (s.providerId !== providerId || s.apiId !== API_ID || s.modelId !== model) return [];
	const out: unknown[] = [];
	for (const e of c.entries) {
		if (e.kind !== ENTRY_KIND) continue;
		try {
			out.push(JSON.parse(e.data));
		} catch {
			// opaque bytes that no longer parse must not kill the request
		}
	}
	return out;
}

function toInput(messages: readonly Message[], model: string, providerId: string): unknown[] {
	const out: unknown[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: toInputContent(msg.content) });
		} else if (msg.role === "assistant") {
			// The reasoning items come FIRST, in emission order: the
			// provider reads the turn back in the order it produced it.
			out.push(...continuationItems(msg, model, providerId), ...msg.blocks.map(toOutputItem));
		} else {
			out.push({ type: "function_call_output", call_id: msg.callId, output: toToolResultOutput(msg.content) });
		}
	}
	return out;
}

/**
 * EXACTLY ONE fetch. No retry loop lives here: the kernel owns the retry
 * budget, and a second attempt underneath it would run outside that
 * budget and outside the request trace (CX-1 F8).
 */
async function requestOnce(target: Target, body: unknown, signal: StreamOptions["signal"]): Promise<Response> {
	const headers = {
		"content-type": "application/json",
		accept: "text/event-stream",
		...(await target.headers()),
	};
	let response: Response;
	try {
		response = await fetch(target.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			...(signal !== undefined ? { signal: signal as AbortSignal } : {}),
		});
	} catch (err) {
		throw toTransportError(err, target.providerId);
	}
	if (!response.ok) throw await toHttpError(response, target.providerId);
	return response;
}

// ── The stream ─────────────────────────────────────────────────────────

/** The frames this adapter reads. Everything else on the wire is ignored
 *  rather than guessed at — an unknown frame type is not an error. */
interface ResponsesFrame {
	readonly type?: string;
	readonly output_index?: number;
	readonly delta?: string;
	readonly arguments?: string;
	readonly item?: ResponsesItem;
	readonly response?: ResponsesResponse;
	readonly code?: string;
	readonly message?: string;
}

interface ResponsesItem {
	readonly type?: string;
	readonly call_id?: string;
	readonly name?: string;
	readonly arguments?: string;
	readonly encrypted_content?: string;
}

interface ResponsesResponse {
	readonly status?: string;
	readonly usage?: {
		readonly input_tokens?: number;
		readonly output_tokens?: number;
		readonly input_tokens_details?: { readonly cached_tokens?: number } | null;
	} | null;
	readonly incomplete_details?: { readonly reason?: string } | null;
	readonly error?: { readonly code?: string; readonly message?: string } | null;
}

/** One output index's live state: whether a text block is open, or the
 *  tool-call identity every later frame for that index must agree with. */
type Slot = { readonly kind: "text" } | { kind: "tool"; readonly callId: string; readonly name: string; sent: string };

interface StreamState {
	readonly slots: Map<number, Slot>;
	readonly entries: ContinuationEntry[];
	sawToolCall: boolean;
	terminal: boolean;
}

async function* mapStream(response: Response, options: StreamOptions, target: Target, scopeProviderId: string): AsyncGenerator<AdapterEvent> {
	const state: StreamState = { slots: new Map(), entries: [], sawToolCall: false, terminal: false };
	const frames = readSSE(response, options.signal, target.providerId);
	try {
		for (;;) {
			let step: IteratorResult<ResponsesFrame>;
			try {
				step = await frames.next();
			} catch (err) {
				// A cancellation is the CALLER's act and a protocol failure
				// is the provider's — both propagate unchanged. What is left
				// is the connection dying mid-stream: a RETRYABLE network
				// error, thrown as the two older adapters throw it, so the
				// kernel's stream-cut recovery (F4: void the draft durably,
				// then retry) engages. The trailing guard below is for a
				// stream that ENDED cleanly without a terminal frame — a
				// truncated turn the provider chose to end, not a cut.
				if (isAbort(err) || options.signal?.aborted || isStructured(err)) throw err;
				throw toTransportError(err, target.providerId);
			}
			if (step.done) break;
			// Outside the try on purpose: a mapping failure (unparseable
			// tool arguments, an id that changed, an error frame) is this
			// adapter's own verdict and must never be mistaken for a cut.
			yield* mapFrame(step.value, state, options.model, target.providerId, scopeProviderId);
			if (state.terminal) break;
		}
	} finally {
		// Closes the reader and removes the abort listener on EVERY exit —
		// including the consumer abandoning the iteration mid-turn.
		await frames.return(undefined);
	}
	if (state.terminal) return;
	// The trailing guard: a stream that never reached a terminal response
	// is a truncated turn. Usage is UNKNOWN (nulls, never a free turn),
	// the stop is an explicit error, and nothing follows it.
	yield usageEvent(undefined);
	yield stopEvent("error", state, options.model, scopeProviderId);
}

function* mapFrame(frame: ResponsesFrame, state: StreamState, model: string, providerId: string, scopeProviderId: string): Generator<AdapterEvent> {
	const index = frame.output_index ?? 0;
	switch (frame.type) {
		case "response.output_item.added": {
			const item = frame.item;
			if (item === undefined) break;
			if (item.type === "message") {
				state.slots.set(index, { kind: "text" });
				yield { seq: 0, type: "text_start" };
			} else if (item.type === "function_call") {
				yield* openToolCall(state, index, item);
			}
			// A reasoning item needs no slot: its text arrives as flat
			// `thinking` events that carry no index, and the item itself
			// is captured whole at its done frame.
			break;
		}
		case "response.output_text.delta":
		case "response.refusal.delta": {
			if (frame.delta === undefined) break;
			// A delta never precedes its start: an index that has no open
			// text block gets one here rather than the text being dropped.
			if (state.slots.get(index)?.kind !== "text") {
				state.slots.set(index, { kind: "text" });
				yield { seq: 0, type: "text_start" };
			}
			yield { seq: 0, type: "text_delta", text: frame.delta };
			break;
		}
		case "response.reasoning_text.delta":
		case "response.reasoning_summary_text.delta":
			// ONE flat `thinking` event — the contract has no
			// start/delta/end for reasoning, and the two reasoning
			// dialects (raw text and summary) are the same stream to a
			// reader.
			if (frame.delta !== undefined && frame.delta !== "") yield { seq: 0, type: "thinking", text: frame.delta };
			break;
		case "response.function_call_arguments.delta": {
			const slot = state.slots.get(index);
			// An arguments delta carries no identity of its own, so an
			// index with no open call has nothing to attribute it to.
			if (slot?.kind !== "tool" || frame.delta === undefined) break;
			slot.sent += frame.delta;
			yield { seq: 0, type: "tool_call_input_delta", callId: slot.callId, inputJsonDelta: frame.delta };
			break;
		}
		case "response.function_call_arguments.done": {
			const slot = state.slots.get(index);
			const args = frame.arguments;
			if (slot?.kind !== "tool" || args === undefined) break;
			// Only the SUFFIX the deltas did not carry: the accumulated
			// input must equal the arguments exactly once. A final value
			// that is not an extension of what was streamed emits nothing
			// — the authoritative arguments still arrive with the item's
			// done frame.
			if (!args.startsWith(slot.sent)) break;
			const suffix = args.slice(slot.sent.length);
			slot.sent = args;
			if (suffix !== "") yield { seq: 0, type: "tool_call_input_delta", callId: slot.callId, inputJsonDelta: suffix };
			break;
		}
		case "response.output_item.done": {
			const item = frame.item;
			if (item === undefined) break;
			if (item.type === "message") {
				state.slots.delete(index);
				yield { seq: 0, type: "text_end" };
			} else if (item.type === "function_call") {
				yield* closeToolCall(state, index, item, providerId);
			} else if (item.type === "reasoning") {
				// MG-1 (A5): the WHOLE item, verbatim — the encrypted
				// payload IS the model's state, and only an item that
				// carries one is worth replaying (the first-party target
				// asks for no encrypted content, so it produces none).
				if (typeof item.encrypted_content === "string" && item.encrypted_content !== "") {
					state.entries.push({ kind: ENTRY_KIND, required: true, data: JSON.stringify(item) });
				}
			}
			break;
		}
		case "response.completed":
		case "response.incomplete": {
			state.terminal = true;
			const response = frame.response;
			// usage BEFORE stop, both read from the SAME frame: a usage
			// taken from anywhere else would belong to another response.
			yield usageEvent(response?.usage ?? undefined);
			yield stopEvent(stopReasonOf(response, state.sawToolCall), state, model, scopeProviderId);
			break;
		}
		case "error":
			throw mapApiError(undefined, `[${providerId}] stream error: ${frame.message ?? frame.code ?? "no detail"}`);
		case "response.failed":
			throw mapApiError(undefined, `[${providerId}] response failed: ${failureDetail(frame.response)}`);
		default:
			break;
	}
}

function* openToolCall(state: StreamState, index: number, item: ResponsesItem): Generator<AdapterEvent> {
	const callId = item.call_id ?? "";
	const name = item.name ?? "";
	state.slots.set(index, { kind: "tool", callId, name, sent: item.arguments ?? "" });
	yield { seq: 0, type: "tool_call_start", callId, name };
}

function* closeToolCall(state: StreamState, index: number, item: ResponsesItem, providerId: string): Generator<AdapterEvent> {
	const open = state.slots.get(index);
	const callId = item.call_id ?? "";
	if (open?.kind !== "tool") {
		// The done frame carries the whole identity, so a call whose added
		// frame never arrived still gets its start before its end — an end
		// without a start would be a forged event order.
		yield* openToolCall(state, index, item);
	} else if (open.callId !== callId) {
		// round 9's rule, one dialect over: the id is captured ONCE. A
		// different id under the same index is a protocol violation, never
		// a silent switch — start, deltas and end share one identity.
		throw {
			code: "invalid_request",
			retryable: false,
			message: `[${providerId}] tool call at output index ${index} changed id mid-stream: ${open.callId} → ${callId}`,
		};
	}
	state.slots.delete(index);
	state.sawToolCall = true;
	const raw = item.arguments === undefined || item.arguments === "" ? "{}" : item.arguments;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		// NEVER a silent repair and never a null input passed off as an
		// empty call: the model asked for something this adapter cannot
		// state, so the turn fails loudly.
		throw {
			code: "invalid_request",
			retryable: false,
			message: `[${providerId}] tool call ${callId} sent arguments that are not a JSON object: ${raw.slice(0, 200)}`,
		};
	}
	yield {
		seq: 0,
		type: "tool_call_end",
		callId,
		name: item.name ?? (open?.kind === "tool" ? open.name : ""),
		input: parsed as Record<string, unknown>,
	};
}

function usageEvent(usage: ResponsesResponse["usage"]): AdapterEvent {
	if (usage === undefined || usage === null) {
		return { seq: 0, type: "usage", inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null, known: false };
	}
	return {
		seq: 0,
		type: "usage",
		// RAW, as the provider reports it: `input_tokens` INCLUDES the
		// cached prefix on this dialect, and the runtime's canonicalizer
		// owns the subtraction. Doing it here too would bill the cached
		// tokens away twice.
		inputTokens: usage.input_tokens ?? null,
		outputTokens: usage.output_tokens ?? null,
		cacheRead: usage.input_tokens_details?.cached_tokens ?? null,
		// The Responses API reports no cache-creation count; null is the
		// honest answer, never a zero.
		cacheWrite: null,
		known: true,
	};
}

function stopEvent(reason: StopReason, state: StreamState, model: string, scopeProviderId: string): AdapterEvent {
	return {
		seq: 0,
		type: "stop",
		reason,
		// A5: the captured items ride the stop as opaque entries with a
		// self-reported scope; the kernel re-stamps it (adapters are not
		// trusted). `required` is unconditional here: under `store: false`
		// the next request is INVALID without them.
		...(state.entries.length > 0
			? { continuation: { scope: { providerId: scopeProviderId, apiId: API_ID, modelId: model }, entries: state.entries } }
			: {}),
	};
}

function stopReasonOf(response: ResponsesResponse | undefined, sawToolCall: boolean): StopReason {
	if (response?.status === "completed") return sawToolCall ? "tool_use" : "end_turn";
	if (response?.status === "incomplete") {
		return response.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "error";
	}
	// failed, cancelled, a status this adapter has never seen, or none at
	// all: an error, never degraded into a clean end.
	return "error";
}

function failureDetail(response: ResponsesResponse | undefined): string {
	const error = response?.error;
	if (error !== undefined && error !== null) return `${error.code ?? "unknown"}: ${error.message ?? "no message"}`;
	const reason = response?.incomplete_details?.reason;
	return reason !== undefined ? `incomplete: ${reason}` : "no error details in the response";
}

/**
 * The SSE reader: frames are separated by a blank line, and a frame's
 * `data:` lines join with newlines. `[DONE]` is a sentinel, not an event.
 * The abort signal reaches BOTH the fetch (above) and this reader, and
 * the listener is removed in `finally` — an adapter that leaves a
 * listener on a long-lived signal leaks one per turn.
 */
async function* readSSE(response: Response, signal: StreamOptions["signal"], providerId: string): AsyncGenerator<ResponsesFrame> {
	const body = response.body;
	if (body === null) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			// Checked after the read, not only before: a cancel resolves a
			// pending read rather than rejecting it, and a turn the caller
			// stopped must not look like a clean end of stream.
			if (signal?.aborted) throw abortError();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const frame = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = frame
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim())
					.join("\n");
				if (data !== "" && data !== "[DONE]") yield parseFrame(data, providerId);
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {
			// already closed or errored — there is nothing left to release
		}
	}
}

function parseFrame(data: string, providerId: string): ResponsesFrame {
	try {
		return JSON.parse(data) as ResponsesFrame;
	} catch {
		// A frame that is not JSON is a PROTOCOL failure, not a truncated
		// turn: it is reported rather than folded into the trailing guard.
		throw mapApiError(undefined, `[${providerId}] malformed SSE frame: ${data.slice(0, 200)}`);
	}
}

function abortError(): Error {
	const err = new Error("the request was aborted");
	err.name = "AbortError";
	return err;
}

function isAbort(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Already a StructuredError (this adapter's own verdict, or the kernel's
 *  shape from mapApiError) — it travels unchanged. */
function isStructured(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && "retryable" in err;
}

// ── Errors ─────────────────────────────────────────────────────────────

/** `retry-after-ms` (the vendor's millisecond header) wins over the HTTP
 *  `Retry-After`; neither is ever shortened. */
function retryAfterOf(headers: Headers): number | undefined {
	const ms = headers.get("retry-after-ms");
	if (ms !== null && /^\d+$/.test(ms.trim())) return Number(ms.trim());
	return parseRetryAfter(headers.get("retry-after"));
}

async function toHttpError(response: Response, providerId: string): Promise<unknown> {
	const raw = await response.text().catch(() => "");
	let message = raw !== "" ? raw : response.statusText || "request failed";
	let planNote = "";
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: unknown; plan_type?: unknown; resets_at?: unknown } };
		const err = parsed.error;
		if (err !== undefined && err !== null) {
			if (typeof err.message === "string" && err.message !== "") message = err.message;
			// The subscription backend's quota facts belong in the MESSAGE a
			// human reads. They never become retryAfterMs: `resets_at` is
			// when the plan's window rolls over, not when this request may
			// be retried, and feeding it to the kernel's backoff would park
			// a session for hours on the provider's say-so. The label
			// already names WHICH provider said it, so the note does not.
			const plan = typeof err.plan_type === "string" ? ` (${err.plan_type.toLowerCase()} plan)` : "";
			const mins = typeof err.resets_at === "number" ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000)) : undefined;
			if (plan !== "" || mins !== undefined) {
				planNote = ` — usage limit${plan}${mins !== undefined ? `, resets in ~${mins} min` : ""}`;
			}
		}
	} catch {
		// not JSON: the raw body is the message, which is the honest one
	}
	const signIn = response.status === 401 && providerId === "chatgpt" ? " — run `kiso login chatgpt`" : "";
	return mapApiError(response.status, `[${providerId}] request failed: ${message}${planNote}${signIn}`, retryAfterOf(response.headers));
}

function toTransportError(err: unknown, providerId: string): unknown {
	// A cancellation is the CALLER's own act: it propagates unchanged, so
	// it never reaches the kernel wearing `retryable: true` and gets the
	// turn the caller stopped run again.
	if (isAbort(err)) return err;
	const message = err instanceof Error ? err.message : String(err);
	return { code: "network", retryable: true, message: `[${providerId}] request failed: ${message}` };
}
