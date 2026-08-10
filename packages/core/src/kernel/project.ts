/**
 * L2 — the reducer: messages are a PURE projection of the event log.
 *
 * ADR-0002 says the log is the single truth. These two functions are what
 * make that claim enforceable: `projectMessages(log.all)` rebuilds the exact
 * message array the loop hands to the adapter, and `messagesToEvents`
 * encodes seed history into the log. Round-trip property:
 * `projectMessages(messagesToEvents(m)) === m` — pinned by tests, and
 * LOSSLESS (Area 6): `source`, `tags`, image content blocks, and assistant
 * text-block boundaries survive the round trip.
 *
 * The loop no longer keeps a parallel `messages` array: every adapter call
 * derives from the log, so there is one store and the replay of `seq` 0..N
 * reproduces the run exactly.
 *
 * Events with no message shape (usage, stop, thinking, terminal, the
 * compaction events' own records) are skipped by the projection;
 * `compacted` applies the EXACT persisted replacements verbatim — it never
 * re-runs the compaction algorithm (a future version could differ, A group/D
 * group); `microcompacted` boundaries re-derive the cleared view from the
 * stream itself (deterministic and idempotent); `summarized` (ADR-0044)
 * replaces its covered range with one assistant summary message. All
 * three are persisted facts — the replay equals the live run. See ADR-0002.
 */

import type { Event } from "../protocol/events.js";
import type { EventInput } from "./event-log.js";
import type {
	AssistantBlock,
	AssistantMessage,
	Message,
	MessageSource,
	ToolResultMessage,
	UserMessage,
} from "../protocol/messages.js";

/**
 * C area: tools whose output is eligible for microcompact clearing — reads,
 * listings, searches, and shell output. write/edit outputs are short and
 * never cleared. Exported so the loop's boundary computation (bootstrap #3)
 * counts exactly the results the projection can clear.
 */
export const MICROCOMPACTABLE = new Set(["read_file", "list_dir", "search_text", "shell"]);

/** The tag that makes a tool result un-clearable (C area). */
export const DO_NOT_COMPACT = "do-not-compact";

/**
 * C area: the fixed placeholder for a cleared tool output, derived ONLY from
 * the event stream (deterministic across replay): the tool's name and its
 * primary argument (the first string-valued field of its input).
 */
function microPlaceholder(name: string, arg: string | undefined): string {
	return arg === undefined
		? `[old tool output cleared: ${name}]`
		: `[old tool output cleared: ${name} ${arg}]`;
}

/** The first string-valued argument of a tool input, if any. */
function primaryArg(input: Readonly<Record<string, unknown>> | null | undefined): string | undefined {
	if (input === null || input === undefined) return undefined;
	for (const value of Object.values(input)) {
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

/**
 * Rebuild the message array from events. Deterministic and order-sensitive:
 * replaying the same log always produces the same messages — BYTE FOR BYTE
 * (D area): the same event prefix derives the same message prefix; the only
 * events that change already-derived messages are `microcompacted`
 * boundaries and `summarized` facts, which are themselves persisted facts
 * (their replay derives the same projection every time).
 *
 * Text block boundaries are preserved: `text_end` closes the current text
 * block (an explicit boundary); `text_start` after a block opens a new one.
 * A stream of deltas WITHOUT `text_end` (the adapters' common shape) closes
 * at the next block/tool/result boundary.
 */
export function projectMessages(events: readonly (Event | EventInput)[]): readonly Message[] {
	const out: Message[] = [];
	let blocks: AssistantBlock[] = [];
	let text: string | null = null;
	let assistantSource: MessageSource | undefined;

	const pushText = (): void => {
		if (text !== null) {
			blocks.push({ type: "text", text });
			text = null;
		}
	};
	// bootstrap P1: the reasoning of the turn being built, accumulated from its
	// `thinking` events and attached to the assistant message at flush —
	// deterministic (same events → same messages → same request body, D area).
	let pendingReasoning: string | null = null;
	const flushAssistant = (): void => {
		pushText();
		if (blocks.length === 0) {
			assistantSource = undefined;
			return;
		}
		const callIds = blocks.filter((b) => b.type === "tool_use").map((b) => b.callId);
		const reasoning = pendingReasoning;
		pendingReasoning = null;
		out.push({
			role: "assistant",
			blocks: [...blocks],
			...(assistantSource !== undefined ? { source: assistantSource } : {}),
			...(reasoning !== null ? { reasoning } : {}),
		} satisfies AssistantMessage);
		blocks = [];
		assistantSource = undefined;
		// P1: the closed assistant's calls whose results are NOT already
		// buffered are pending — their results land later (post-stop late
		// results, the straddle's shape). The mid-execution inputs hold
		// until those results flush.
		// the guard keeps a still-pending pair holding when a call-less
		// assistant closes mid-hold (the empty set would release the input)
		const buffered = new Set(resultBuf.map((r) => r.callId));
		if (callIds.length > 0) pendingCalls = new Set(callIds.filter((c) => !buffered.has(c)));
	};

	// C group/round 6: vetoed/rewritten user inputs. Collect the replacement map
	// first — the FINAL replacement for each input wins (later replacements
	// never produce extra messages), and the replacement renders AT THE
	// INPUT'S OWN POSITION: the original is skipped, the final non-null
	// content speaks for it there, a null content is a true veto (nothing
	// at that position).
	const replaced = new Map<
		number,
		{ content: string | readonly import("../protocol/messages.js").ContentBlock[] | null; source?: MessageSource }
	>();
	for (const ev of events) {
		if (ev.type === "user_input_replaced") {
			replaced.set(ev.replaces, {
				content: ev.content,
				...(ev.source !== undefined ? { source: ev.source } : {}),
			});
		}
	}
	// C area: callId → {name, input} for the microcompact placeholder.
	const callMeta = new Map<string, { name: string; input: Readonly<Record<string, unknown>> | null }>();
	for (const ev of events) {
		if (ev.type === "tool_call_end") callMeta.set(ev.callId, { name: ev.name, input: ev.input });
	}
	// ADR-0044: summarized coverage — each `summarized` event covers the
	// range (previous coversToSeq, coversToSeq] of ORDINARY events. The
	// ranges are disjoint and in seq order; boundaries are turn boundaries
	// by construction (summaryBoundarySeq cuts before a user_input), so a
	// skipped event never splits a message. Each summary message renders
	// AT ITS BOUNDARY — the first event after the covered range — NOT at
	// the summarized event itself: the event sits at the log's END (the
	// kept rounds live between the boundary and it), and the summary must
	// precede the kept conversation in reading order.
	const summaryRanges: { from: number; to: number; summary: string }[] = [];
	{
		let prev = -1;
		for (const ev of events) {
			if (ev.type === "summarized") {
				summaryRanges.push({ from: prev, to: ev.coversToSeq, summary: ev.summary });
				prev = ev.coversToSeq;
			}
		}
	}
	// R-E 0.1.43 (Gap B): a model_output_abandoned marker voids the range
	// (voidFromSeq, its seq] — the abandoned draft's events. The ranges are
	// disjoint and in seq order; the skip below treats them exactly like the
	// summary ranges (the marker itself renders nothing and skips itself).
	// R-E 0.1.44 (the void scope sentence): the void range voids MODEL
	// OUTPUT only — text_delta / thinking / tool_call_* — never the
	// framework's facts (permission*, tool_execution, tool_result,
	// user_input, terminal). The summary ranges keep their blanket reach
	// (the summary replaces everything it covers).
	const MODEL_OUTPUT_TYPES = new Set([
		"text_delta",
		"thinking",
		"tool_call_start",
		"tool_call_input_delta",
		"tool_call_end",
	]);
	const voidRanges: { from: number; to: number }[] = [];
	for (const ev of events) {
		if (ev.type === "model_output_abandoned") voidRanges.push({ from: ev.voidFromSeq, to: (ev as { seq?: number }).seq ?? -1 });
	}
	const coveredBySummary = (seq: number): boolean => summaryRanges.some((r) => seq > r.from && seq <= r.to);
	const coveredByVoid = (seq: number): boolean => voidRanges.some((r) => seq > r.from && seq <= r.to);
	// Summaries render in range order as the pass crosses their boundaries.
	let renderedSummaries = 0;

	// 0.1.26 (ADR-0024 Amd, parallel execution): the tool results of ONE turn
	// are buffered and emitted in CALL order at the turn boundary. The
	// physical seq order is the COMPLETION order (started/receipt/result land
	// when each execution finishes — parallel), which must never enter the
	// projection: the same logical turn projects byte-identically whatever
	// the completion interleaving (the byte discipline — call order is the truth; completion order only affects
	// the moment of writing). `callOrder` is rebuilt per turn from the tool_call_end
	// events (their seq order IS the call order — the stream order).
	let resultBuf: { callId: string; message: ToolResultMessage }[] = [];
	const callOrder = new Map<string, number>();
	let callOrderNext = 0;
	// R-E 0.1.44 (sentence 1): the declarations that PROJECTED (their
	// tool_use blocks were actually pushed) — the pair-atomicity signal a
	// tool_result consults. A declaration the void skipped is not here, so
	// its (possibly post-marker) receipt drops — both or neither.
	const projectedDeclarations = new Set<string>();
	// P1 (0.1.42): the mid-execution input deferral. A user input arriving
	// while the last closed assistant's tool_calls are UNANSWERED (the
	// result lands later in the log — the boundary straddle's durable
	// shape) must never separate the call from its result: the request
	// [assistant, user, tool] is a real provider 400. Such inputs are
	// HELD and released right after the results flush — the mid-execution
	// input takes effect when the turn's execution completes.
	let pendingCalls = new Set<string>();
	let heldUsers: UserMessage[] = [];
	const flushResults = (force = false): void => {
		if (resultBuf.length > 0) {
			resultBuf.sort((a, b) => (callOrder.get(a.callId) ?? 0) - (callOrder.get(b.callId) ?? 0));
			for (const r of resultBuf) out.push(r.message);
			resultBuf = [];
			callOrder.clear();
			callOrderNext = 0;
		}
		// The held inputs release ONLY when the pair resolved (or the
		// projection ends — force): a still-pending pair must keep holding,
		// or the next user_input's leading flush would dump the inputs
		// between the call and its late result (the 400 again).
		if (force || pendingCalls.size === 0) {
			out.push(...heldUsers);
			heldUsers = [];
		}
	};

	let explicitAssistant = false;

	for (const ev of events) {
		// ADR-0044: covered events are replaced by their summary — seed
		// events (EventInput, no seq) precede any summarized fact and are
		// never covered. The summarized events themselves are exempt (their
		// own event sits inside the NEXT range's coverage; the boundary
		// render below is where their message lands).
		const evSeq = (ev as { seq?: number }).seq ?? -1;
		// R-E 0.1.44 (sentence 2): the VOID skip is type-filtered — model
		// output dies with the draft, the framework's facts never do (a
		// straddling tool_result inside the void range keeps its pair).
		if (ev.type !== "summarized" && (coveredBySummary(evSeq) || (MODEL_OUTPUT_TYPES.has(ev.type) && coveredByVoid(evSeq)))) continue;
		// The boundary render: every range whose end this event crosses
		// yields its assistant summary message, before this event renders.
		while (
			renderedSummaries < summaryRanges.length &&
			(ev as { seq?: number }).seq !== undefined &&
			(ev as { seq?: number }).seq! > summaryRanges[renderedSummaries]!.to
		) {
			flushAssistant();
			flushResults(); // the results follow the assistant in reading order
			out.push({
				role: "assistant",
				blocks: [{ type: "text", text: summaryRanges[renderedSummaries]!.summary }],
			} satisfies AssistantMessage);
			renderedSummaries += 1;
		}
		switch (ev.type) {
			case "user_input": {
				// 0.1.26: the previous turn closes here — the assistant
				// first, then its results in call order (the turn boundary).
				// round 6: the final replacement renders HERE, at the input's own
				// position — the original is skipped, the replacement event
				// itself produces nothing (a later replacement for the same
				// input never becomes a second message); a null content is a
				// true veto (nothing renders at that position).
				flushAssistant();
				flushResults();
				let content: UserMessage["content"] = ev.content;
				let source: MessageSource | undefined = ev.source;
				let veto = false;
				if ("seq" in ev && typeof ev.seq === "number" && replaced.has(ev.seq)) {
					const replacement = replaced.get(ev.seq)!;
					if (replacement.content === null) {
						veto = true;
					} else {
						content = replacement.content;
						source = replacement.source ?? ev.source;
					}
				}
				if (veto) break;
				const message = {
					role: "user",
					content,
					...(source !== undefined ? { source } : {}),
				} satisfies UserMessage;
				// P1: the mid-execution deferral — an input arriving while
				// the turn's calls are unanswered is HELD and released right
				// after the results flush (the pairing invariant: the
				// results must follow their calls before any user message).
				if (pendingCalls.size > 0) heldUsers.push(message);
				else out.push(message);
				break;
			}
			case "user_input_replaced":
				// The replacement already rendered at its input's position —
				// this event carries no message of its own (round 6).
				break;
			case "assistant_start":
				// D group: an explicit message boundary — close any open message
				// and begin a new one (adjacent assistants stay separate).
				flushAssistant();
				flushResults();
				explicitAssistant = true;
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "assistant_end":
				// Close the message; an EMPTY explicit message is preserved.
				if (explicitAssistant && blocks.length === 0 && text === null) {
					out.push({
						role: "assistant",
						blocks: [],
						...(assistantSource !== undefined ? { source: assistantSource } : {}),
					} satisfies AssistantMessage);
					assistantSource = undefined;
				} else {
					flushAssistant();
				}
				explicitAssistant = false;
				break;
			case "text_start":
				// An INTERNAL block boundary (a multi-block assistant
				// message) — never a turn boundary; no flush.
				pushText(); // an explicit boundary: a new block begins
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "text_end":
				pushText(); // an explicit boundary: the block closes
				break;
			case "text_delta":
				// 0.1.26: a text delta with BUFFERED RESULTS opens the NEXT
				// turn's stream — the previous turn closes HERE: its
				// assistant (closed at the stop), then its buffered results
				// in call order (the API requires each tool_calls message
				// to be followed by its tool messages — a real 400 without
				// the boundary). P1 (0.1.42): the flush keys on OPEN
				// assistant content — an open block or text proves the
				// model is still streaming THIS turn, and a same-turn
				// buffered result must stay buffered (flushing it here
				// split the turn's message — the fresh2 400).
				if (blocks.length === 0 && text === null && resultBuf.length > 0) flushResults();
				text = (text ?? "") + ev.text;
				break;
			case "tool_call_start":
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "tool_call_input_delta":
				break; // the parsed input arrives at tool_call_end
			case "tool_call_end":
				// 0.1.26: a tool_call_end with BUFFERED RESULTS opens the
				// NEXT turn's stream (the model called again) — the
				// previous turn's results close first; a same-turn call
				// keeps the assistant open. P1 (0.1.42): open assistant
				// content proves the same-turn call — the buffered results
				// close at the stop, NEVER here (flushing a same-turn
				// result at a later call_end split the turn's message —
				// the fresh2 400).
				if (blocks.length === 0 && text === null && resultBuf.length > 0) flushResults();
				pushText();
				projectedDeclarations.add(ev.callId);
				callOrder.set(ev.callId, callOrderNext++);
				blocks.push({
					type: "tool_use",
					callId: ev.callId,
					name: ev.name,
					input: ev.input ?? {},
				});
				break;
			case "tool_result": {
				// R-E 0.1.44 (sentence 1): PAIR ATOMICITY — a result whose
				// declaration never projected is dropped (both or neither).
				// The straddling receipt (declaration committed before the
				// stop, result landing inside the void) still projects — its
				// declaration is in the set; the voided draft's post-marker
				// receipt (0143) is the orphan — dropped here, kept in the
				// audit (persist facts, derive state).
				if (!projectedDeclarations.has(ev.callId)) break;
				// 0.1.26: NO flushAssistant — the streaming execution lands
				// results BETWEEN the turn's tool_call_ends; closing the
				// assistant here splits the turn's tool_calls message (the
				// API 400). The assistant stays open and closes at the turn
				// boundary with ALL its tool_use blocks.
				const message: ToolResultMessage = {
					role: "tool",
					callId: ev.callId,
					content: ev.content,
					isError: ev.isError,
					...(ev.source !== undefined ? { source: ev.source } : {}),
					...(ev.tags !== undefined ? { tags: ev.tags } : {}),
				};
				// round 5: the originating event's seq rides on the message as a
				// NON-ENUMERABLE correlation field — the stable identity
				// compaction uses to name WHICH result it replaced. Deep
				// equality with seed messages (which carry no such field)
				// still holds; a spread drops it, which is fine because the
				// projection re-derives everything fresh from the log.
				if ("seq" in ev && typeof ev.seq === "number") {
					Object.defineProperty(message, "eventSeq", { value: ev.seq, enumerable: false, configurable: true });
				}
				// 0.1.26: BUFFERED — the results flush in call order at the
				// turn boundary (flushResults), not in completion order.
				// P1: a pending call's result resolves the pair — the held
				// mid-execution inputs release with the flush.
				pendingCalls.delete(ev.callId);
				resultBuf.push({ callId: ev.callId, message });
				break;
			}
			case "microcompacted": {
				flushAssistant();
				flushResults(); // the results must be in `out` before the replacement pass
				flushAssistant();
				// C area: replace every eligible OLD tool result with the fixed
				// placeholder. Eligibility: the result's own event seq <= the
				// boundary, its tool in the whitelist, and no do-not-compact
				// tag. Deterministic — the boundary event IS the decision.
				const replaced = out.map((m) => {
					if (m.role !== "tool") return m;
					if (m.eventSeq === undefined || m.eventSeq > ev.beforeSeq) return m;
					const meta = callMeta.get(m.callId);
					if (meta === undefined || !MICROCOMPACTABLE.has(meta.name)) return m;
					if ((m.tags ?? []).includes(DO_NOT_COMPACT)) return m;
					return { ...m, content: microPlaceholder(meta.name, primaryArg(meta.input)) };
				});
				out.splice(0, out.length, ...replaced);
				break;
			}
			case "compacted": {
				flushAssistant();
				flushResults(); // the results must be in `out` before the replacement pass
				flushAssistant();
				// Apply the EXACT persisted replacements — never re-run the
				// compaction algorithm (a future version could differ). round 5:
				// v2 entries are keyed by the replaced tool-result EVENT's
				// seq, so only the specific result is rewritten — never a
				// same-callId sibling from another turn or run. round 4: v1
				// entries (round-three sessions, no eventSeq) replay with v1
				// semantics — every tool result with that callId is replaced,
				// exactly as the old framework did.
				const byEventSeq = new Map(
					ev.cleared.filter((c) => c.eventSeq !== undefined).map((c) => [c.eventSeq!, c.content]),
				);
				const byCallId = new Map(
					ev.cleared.filter((c) => c.eventSeq === undefined).map((c) => [c.callId, c.content]),
				);
				const replaced = out.map((m) => {
					if (m.role !== "tool") return m;
					if (m.eventSeq !== undefined && byEventSeq.has(m.eventSeq)) {
						return { ...m, content: byEventSeq.get(m.eventSeq)! };
					}
					if (byCallId.has(m.callId)) return { ...m, content: byCallId.get(m.callId)! };
					return m;
				});
				out.splice(0, out.length, ...replaced);
				break;
			}
			case "thinking":
				// bootstrap P1: accumulate the turn's reasoning — the flush (an
				// empty one at the turn's start) keeps the pending text, and
				// the assistant message that follows carries it. 0.1.26: the
				// assistant flush is guarded on the buffered results (a
				// mid-turn reasoning must not split the current message).
				// P1 (0.1.42): the flush keys on OPEN assistant content —
				// a mid-turn reasoning with a same-turn result buffered
				// must NOT split the message (the fresh2 400 family).
				if (blocks.length === 0 && text === null && resultBuf.length > 0) flushResults();
				pendingReasoning = (pendingReasoning ?? "") + ev.text;
				break;
			case "summarized":
				// ADR-0044: this event produced nothing itself — its summary
				// message was rendered at the boundary render above, in the
				// covered range's position.
				break;
			case "usage":
				// 0.1.26: NO flush — the non-rendered events interleave with
				// the streaming execution (a tool's started/receipt, an
				// ask's request land BETWEEN the turn's tool_call_ends).
				// Flushing here SPLIT the turn's assistant message — the
				// API requires each tool_calls message to be followed by
				// ITS tool messages, and a second assistant message (with
				// the later calls) between the first's calls and results
				// is a real 400. The assistant closes at the stop and the
				// turn boundaries.
				break;
			case "stop":
				// The turn boundary: the assistant closes at the provider's
				// stop — and the turn's BUFFERED results close WITH it (P1
				// 0.1.42). Parallel execution lands same-turn results
				// mid-stream; flushing them here — the true boundary —
				// projects [assistant, results…] in reading order, and the
				// stream-open guards below only ever flush a CLOSED turn's
				// late (post-stop) results.
				flushAssistant();
				flushResults();
				break;
			case "terminal":
			case "tool_execution_started":
			case "tool_execution_succeeded":
			case "tool_execution_failed":
			case "tool_execution_resolved":
			case "permission_requested":
			case "permission_decided":
			case "permission_expired":
			case "uncertain_pending":
			case "model_output_abandoned":
				// R-E 0.1.43: renders nothing — the marker is always skipped by
				// its own range; the case documents the intent (and no flush:
				// it must never split a message).
				break;
			case "microcompacted":
				// handled above (the replacement pass) — no open message.
				break;
		}
	}
	flushAssistant();
	flushResults(true); // the log's end is the last resort: held inputs never drop
	return out;
}

/**
 * Encode seed messages into log events — LOSSLESSLY for the framework's own
 * shapes (Area 6): one `text_delta` per text block (boundaries preserved),
 * `source` on the first event of each message, `tags` on tool results,
 * content blocks passed through. Nothing a legal Message can express is
 * dropped.
 */
export function messagesToEvents(messages: readonly Message[]): EventInput[] {
	const out: EventInput[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				out.push({
					type: "user_input",
					content: msg.content,
					...(msg.source !== undefined ? { source: msg.source } : {}),
				});
				break;
			}
			case "assistant": {
				// D group: an explicit assistant_start/assistant_end pair frames
				// the message — adjacent and empty assistants round-trip.
				// bootstrap P1: the reasoning re-enters the log as its ORIGINAL
				// thinking event — the projection re-attaches it identically.
				if (msg.reasoning !== undefined) {
					out.push({ type: "thinking", text: msg.reasoning });
				}
				out.push({
					type: "assistant_start",
					...(msg.source !== undefined ? { source: msg.source } : {}),
				});
				for (const block of msg.blocks) {
					if (block.type === "text") {
						out.push({
							type: "text_start",
							...(msg.source !== undefined ? { source: msg.source } : {}),
						});
						out.push({ type: "text_delta", text: block.text });
						out.push({ type: "text_end" });
					} else {
						out.push({
							type: "tool_call_start",
							callId: block.callId,
							name: block.name,
							...(msg.source !== undefined ? { source: msg.source } : {}),
						});
						out.push({
							type: "tool_call_end",
							callId: block.callId,
							name: block.name,
							input: block.input as Record<string, unknown>,
						});
					}
				}
				out.push({ type: "assistant_end" });
				break;
			}
			case "tool": {
				// D1: the FULL content (blocks included) is preserved — never
				// flattened to text.
				out.push({
					type: "tool_result",
					callId: msg.callId,
					content: msg.content,
					isError: msg.isError,
					...(msg.source !== undefined ? { source: msg.source } : {}),
					...(msg.tags !== undefined ? { tags: msg.tags } : {}),
				});
				break;
			}
		}
	}
	return out;
}

export type { AssistantBlock, MessageSource };
